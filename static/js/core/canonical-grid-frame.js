const CANONICAL_GRID_FRAME_SCHEMA = "rrkal.canonical_grid_frame.v1";

function canonicalGridEstimateValueBytes(value) {
  if (value == null) return 1;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (typeof value === "string") return 16 + value.length * 2;
  return 16;
}

function canonicalGridIndexArray(length, dictionarySize) {
  if (dictionarySize <= 0x100) return new Uint8Array(length);
  if (dictionarySize <= 0x10000) return new Uint16Array(length);
  return new Uint32Array(length);
}

function canonicalGridRawColumn(values) {
  Object.freeze(values);
  return Object.freeze({
    kind: "raw",
    length: values.length,
    estimatedBytes: 32 + values.reduce(
      (sum, value) => sum + canonicalGridEstimateValueBytes(value),
      0,
    ),
    valueAt: (index) => values[index],
  });
}

function canonicalGridTypedColumn(values, valueType, nullable) {
  const length = values.length;
  const validity = nullable ? new Uint8Array(length) : null;
  const typed = valueType === "boolean" ? new Uint8Array(length) : new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const value = values[index];
    if (value == null) continue;
    if (validity) validity[index] = 1;
    typed[index] = valueType === "boolean" ? Number(Boolean(value)) : Number(value);
  }
  return Object.freeze({
    kind: valueType,
    length,
    estimatedBytes: 64 + typed.byteLength + (validity?.byteLength || 0),
    valueAt: (index) => {
      if (validity && validity[index] === 0) return null;
      return valueType === "boolean" ? typed[index] === 1 : typed[index];
    },
  });
}

function canonicalGridDictionaryColumn(values, valueType, nullable, dictionary, lookup) {
  const length = values.length;
  const validity = nullable ? new Uint8Array(length) : null;
  const indices = canonicalGridIndexArray(length, dictionary.length);
  for (let index = 0; index < length; index += 1) {
    const value = values[index];
    if (value == null) continue;
    if (validity) validity[index] = 1;
    indices[index] = lookup.get(value);
  }
  const compactDictionary = valueType === "number"
    ? Float64Array.from(dictionary)
    : Object.freeze([...dictionary]);
  const dictionaryBytes = valueType === "number"
    ? compactDictionary.byteLength
    : compactDictionary.reduce(
      (sum, value) => sum + canonicalGridEstimateValueBytes(value),
      0,
    );
  return Object.freeze({
    kind: `${valueType}_dictionary`,
    length,
    estimatedBytes: 96 + indices.byteLength + (validity?.byteLength || 0) + dictionaryBytes,
    valueAt: (index) => {
      if (validity && validity[index] === 0) return null;
      return compactDictionary[indices[index]];
    },
  });
}

function compileCanonicalGridColumn(values) {
  let valueType = "";
  let nullable = false;
  for (const value of values) {
    if (value == null) {
      nullable = true;
      continue;
    }
    const candidate = typeof value;
    if (!["number", "boolean", "string"].includes(candidate)) return canonicalGridRawColumn(values);
    if (valueType && valueType !== candidate) return canonicalGridRawColumn(values);
    valueType = candidate;
  }
  if (!valueType) return canonicalGridRawColumn(values);
  if (valueType === "boolean") return canonicalGridTypedColumn(values, valueType, nullable);

  const dictionary = [];
  const lookup = new Map();
  const dictionaryLimit = Math.min(0x10000, Math.max(16, Math.ceil(values.length / 4)));
  for (const value of values) {
    if (value == null || lookup.has(value)) continue;
    lookup.set(value, dictionary.length);
    dictionary.push(value);
    if (dictionary.length > dictionaryLimit) break;
  }
  if (dictionary.length <= dictionaryLimit) {
    return canonicalGridDictionaryColumn(values, valueType, nullable, dictionary, lookup);
  }
  if (valueType === "number") return canonicalGridTypedColumn(values, valueType, nullable);
  return canonicalGridRawColumn(values);
}

class CanonicalGridFrame {
  #storage;
  #indices;

  constructor(transport, internal = null) {
    if (internal?.storage) {
      this.#storage = internal.storage;
      this.#indices = internal.indices;
      Object.freeze(this);
      return;
    }
    if (!transport || transport.schema !== CANONICAL_GRID_FRAME_SCHEMA) {
      throw new Error(`Unsupported canonical grid frame: ${transport?.schema || "<missing>"}`);
    }
    const fields = Array.isArray(transport.row_fields)
      ? transport.row_fields.map((field) => String(field))
      : null;
    const columns = Array.isArray(transport.columns) ? transport.columns : null;
    const rowCount = Number(transport.row_count);
    if (!fields || !columns || fields.length !== columns.length || !Number.isInteger(rowCount) || rowCount < 0) {
      throw new Error("Invalid canonical grid frame metadata");
    }
    if (new Set(fields).size !== fields.length || columns.some((column) => (
      !Array.isArray(column) || column.length !== rowCount
    ))) {
      throw new Error("Invalid canonical grid frame columns");
    }
    const fieldIndexes = new Map(fields.map((field, index) => [field, index]));
    const frameFields = Object.freeze({ ...(transport.frame_fields || {}) });
    const compiledColumns = Object.freeze(columns.map(compileCanonicalGridColumn));
    const estimatedBytes = compiledColumns.reduce(
      (total, column) => total + column.estimatedBytes,
      256 + fields.reduce((total, field) => total + field.length * 2, 0),
    );
    this.#storage = Object.freeze({
      fields: Object.freeze(fields),
      columns: compiledColumns,
      fieldIndexes,
      frameFields,
      rowCount,
      estimatedBytes,
    });
    this.#indices = null;
    Object.freeze(this);
  }

  static isFrame(value) {
    return value instanceof CanonicalGridFrame;
  }

  static empty(frameFields = {}) {
    return new CanonicalGridFrame({
      schema: CANONICAL_GRID_FRAME_SCHEMA,
      row_fields: [],
      frame_fields: frameFields,
      columns: [],
      row_count: 0,
    });
  }

  get rowCount() {
    return this.#indices === null ? this.#storage.rowCount : this.#indices.length;
  }

  get estimatedBytes() {
    if (this.#indices === null) return this.#storage.estimatedBytes;
    const ratio = this.#storage.rowCount > 0 ? this.rowCount / this.#storage.rowCount : 0;
    return Math.max(256, Math.ceil(this.#storage.estimatedBytes * ratio));
  }

  get frameFields() {
    return this.#storage.frameFields;
  }

  sourceIndex(logicalIndex) {
    const index = Number(logicalIndex);
    if (!Number.isInteger(index) || index < 0 || index >= this.rowCount) throw new RangeError(String(logicalIndex));
    return this.#indices === null ? index : this.#indices[index];
  }

  hasField(field) {
    return Object.hasOwn(this.#storage.frameFields, field) || this.#storage.fieldIndexes.has(field);
  }

  valueAt(field, logicalIndex) {
    if (Object.hasOwn(this.#storage.frameFields, field)) return this.#storage.frameFields[field];
    const columnIndex = this.#storage.fieldIndexes.get(field);
    if (columnIndex === undefined) return null;
    return this.#storage.columns[columnIndex].valueAt(this.sourceIndex(logicalIndex));
  }

  boundsAt(logicalIndex, target = {}) {
    const raw = ["west", "south", "east", "north"].map((direction) => (
      this.valueAt(`bounds.${direction}`, logicalIndex)
    ));
    if (raw.some((value) => value === null || value === undefined || value === "")) return null;
    const [west, south, east, north] = raw.map(Number);
    if (![west, south, east, north].every(Number.isFinite)) return null;
    target.west = west;
    target.south = south;
    target.east = east;
    target.north = north;
    return target;
  }

  fieldNames() {
    const names = [...Object.keys(this.#storage.frameFields)];
    let hasBounds = false;
    for (const field of this.#storage.fields) {
      if (field.startsWith("bounds.")) {
        hasBounds = true;
      } else if (!names.includes(field)) {
        names.push(field);
      }
    }
    if (hasBounds) names.unshift("bounds");
    return names;
  }

  rowAt(logicalIndex) {
    const row = { ...this.#storage.frameFields };
    let bounds = null;
    for (const field of this.#storage.fields) {
      const value = this.valueAt(field, logicalIndex);
      if (field.startsWith("bounds.")) {
        bounds ||= {};
        bounds[field.slice(7)] = value;
      } else {
        row[field] = value;
      }
    }
    return bounds && Object.values(bounds).some((value) => value != null)
      ? { bounds, ...row }
      : row;
  }

  rows(offset = 0, limit = this.rowCount) {
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const stop = Math.min(this.rowCount, start + Math.max(0, Math.floor(Number(limit) || 0)));
    return Array.from({ length: Math.max(0, stop - start) }, (_value, index) => this.rowAt(start + index));
  }

  forEach(callback) {
    for (let index = 0; index < this.rowCount; index += 1) callback(this, index);
  }

  reduceField(field, reducer, initialValue) {
    let result = initialValue;
    for (let index = 0; index < this.rowCount; index += 1) {
      result = reducer(result, this.valueAt(field, index), index, this);
    }
    return result;
  }

  numericSummary(field) {
    let count = 0;
    let sum = 0;
    let min = null;
    let max = null;
    for (let index = 0; index < this.rowCount; index += 1) {
      const raw = this.valueAt(field, index);
      if (raw === null || raw === undefined || raw === "") continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      count += 1;
      sum += value;
      min = min === null ? value : Math.min(min, value);
      max = max === null ? value : Math.max(max, value);
    }
    return Object.freeze({ count, sum, min, max });
  }

  select(predicate) {
    const indices = [];
    for (let index = 0; index < this.rowCount; index += 1) {
      if (predicate(this, index)) indices.push(this.sourceIndex(index));
    }
    if (indices.length === this.rowCount) return this;
    return new CanonicalGridFrame(null, {
      storage: this.#storage,
      indices: Int32Array.from(indices),
    });
  }

  filterBbox(box, epsilon = 1e-6) {
    if (!box) return this;
    return this.select((frame, index) => {
      const bounds = frame.boundsAt(index, {});
      if (bounds) {
        return bounds.west < box.east - epsilon
          && bounds.east > box.west + epsilon
          && bounds.south < box.north - epsilon
          && bounds.north > box.south + epsilon;
      }
      const lat = Number(frame.valueAt("lat", index));
      const lon = Number(frame.valueAt("lon", index));
      return Number.isFinite(lat) && Number.isFinite(lon)
        && lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north;
    });
  }

  slice(offset = 0, limit = this.rowCount) {
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const stop = Math.min(this.rowCount, start + Math.max(0, Math.floor(Number(limit) || 0)));
    if (start === 0 && stop === this.rowCount) return this;
    const indices = new Int32Array(Math.max(0, stop - start));
    for (let index = start; index < stop; index += 1) indices[index - start] = this.sourceIndex(index);
    return new CanonicalGridFrame(null, { storage: this.#storage, indices });
  }

  identityAt(index) {
    return [
      this.valueAt("cell_id", index) ?? this.valueAt("lat", index) ?? "",
      this.valueAt("lon", index) ?? "",
      this.valueAt("resolution_km", index) ?? "",
      this.valueAt("date", index) ?? "",
    ].join("|");
  }

  toTransport() {
    const fields = this.#storage.fields;
    const columns = fields.map((field) => (
      Array.from({ length: this.rowCount }, (_value, index) => this.valueAt(field, index))
    ));
    return {
      schema: CANONICAL_GRID_FRAME_SCHEMA,
      row_fields: [...fields],
      frame_fields: { ...this.#storage.frameFields },
      columns,
      row_count: this.rowCount,
    };
  }

  static merge(frames) {
    const values = (frames || []).filter(CanonicalGridFrame.isFrame);
    if (!values.length) return CanonicalGridFrame.empty();
    const rowFields = [...new Set(values.flatMap((frame) => frame.#storage.fields))];
    const potentialConstants = [...new Set(values.flatMap((frame) => Object.keys(frame.frameFields)))];
    const frameFields = {};
    for (const field of potentialConstants) {
      const present = values.filter((frame) => Object.hasOwn(frame.frameFields, field));
      const first = present[0]?.frameFields[field];
      if (present.length === values.length && present.every((frame) => frame.frameFields[field] === first)) {
        frameFields[field] = first;
      } else if (!rowFields.includes(field)) {
        rowFields.push(field);
      }
    }
    const columns = rowFields.map(() => []);
    const seen = new Set();
    for (const frame of values) {
      for (let index = 0; index < frame.rowCount; index += 1) {
        const key = frame.identityAt(index);
        if (seen.has(key)) continue;
        seen.add(key);
        rowFields.forEach((field, fieldIndex) => columns[fieldIndex].push(frame.valueAt(field, index)));
      }
    }
    return new CanonicalGridFrame({
      schema: CANONICAL_GRID_FRAME_SCHEMA,
      row_fields: rowFields,
      frame_fields: frameFields,
      columns,
      row_count: seen.size,
    });
  }
}

function decodeCanonicalGridFramePacket(packet) {
  const transport = packet?.canonical_frame;
  if (!transport) {
    if (packet?.row_contract_version === "rrkal.sampled_grid.v1") {
      throw new Error("Canonical sampled-grid batch packet is missing canonical_frame");
    }
    return packet;
  }
  const frame = new CanonicalGridFrame(transport);
  const decoded = { ...packet, frame, row_count: frame.rowCount };
  delete decoded.canonical_frame;
  return Object.freeze(decoded);
}

Object.assign(globalThis, {
  CANONICAL_GRID_FRAME_SCHEMA,
  CanonicalGridFrame,
  decodeCanonicalGridFramePacket,
});
