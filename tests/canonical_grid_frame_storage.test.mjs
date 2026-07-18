import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function loadFrameClass() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/core/canonical-grid-frame.js"), "utf8"),
    context,
  );
  return context.CanonicalGridFrame;
}

test("canonical frame compacts numeric and low-cardinality columns without changing values", () => {
  const CanonicalGridFrame = loadFrameClass();
  const rowCount = 4096;
  const numeric = Array.from({ length: rowCount }, (_value, index) => index % 128);
  numeric[7] = null;
  const status = Array.from({ length: rowCount }, (_value, index) => (
    index % 2 ? "valid" : "contains_filled"
  ));
  const flags = Array.from({ length: rowCount }, (_value, index) => index % 3 === 0);
  const transport = {
    schema: "rrkal.canonical_grid_frame.v1",
    row_fields: ["value", "data_status", "valid"],
    frame_fields: { date: "2020-01-01" },
    columns: [numeric, status, flags],
    row_count: rowCount,
  };

  const frame = new CanonicalGridFrame(transport);
  numeric[0] = 9999;
  status[0] = "mutated";
  flags[0] = false;

  assert.equal(frame.valueAt("value", 0), 0);
  assert.equal(frame.valueAt("value", 7), null);
  assert.equal(frame.valueAt("data_status", 0), "contains_filled");
  assert.equal(frame.valueAt("valid", 0), true);
  assert.deepEqual(JSON.parse(JSON.stringify(frame.rowAt(7))), {
    date: "2020-01-01",
    value: null,
    data_status: "valid",
    valid: false,
  });

  const rawEstimate = rowCount * ((8 + 1) + (16 + "contains_filled".length * 2) + 8);
  assert.ok(frame.estimatedBytes < rawEstimate / 3);
});

test("canonical frame transport round-trip preserves nulls and high-cardinality strings", () => {
  const CanonicalGridFrame = loadFrameClass();
  const transport = {
    schema: "rrkal.canonical_grid_frame.v1",
    row_fields: ["cell_id", "value", "active"],
    frame_fields: { resolution_km: 4 },
    columns: [
      ["cell-0", "cell-1", "cell-2", "cell-3"],
      [1.5, null, -2, 0],
      [true, false, null, true],
    ],
    row_count: 4,
  };

  const frame = new CanonicalGridFrame(transport);
  assert.deepEqual(JSON.parse(JSON.stringify(frame.toTransport())), transport);
  assert.deepEqual(JSON.parse(JSON.stringify(frame.slice(1, 2).toTransport())), {
    ...transport,
    columns: [["cell-1", "cell-2"], [null, -2], [false, null]],
    row_count: 2,
  });
});
