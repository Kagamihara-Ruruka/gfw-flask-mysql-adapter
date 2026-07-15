const SampledGridWebglLayer = L.Layer.extend({
  initialize({ renderClock } = {}) {
    if (!renderClock || typeof renderClock.now !== "function") {
      throw new TypeError("SampledGridWebglLayer requires a render clock");
    }
    this._renderClock = renderClock;
    this._rows = [];
    this._drawMs = 0;
    this._hitCells = [];
  },
  onAdd(targetMap) {
    this._map = targetMap;
    this._canvas = L.DomUtil.create("canvas", "grid-canvas-layer sampled-grid-webgl-layer");
    this._gl = this._canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    if (!this._gl) {
      this._failed = true;
      return;
    }
    targetMap.getPane("sampledGridPane").appendChild(this._canvas);
    targetMap.on("move zoom resize", this._reset, this);
    this._reset();
  },
  onRemove(targetMap) {
    targetMap.off("move zoom resize", this._reset, this);
    this.releaseGpuResources();
    if (this._canvas) {
      L.DomUtil.remove(this._canvas);
    }
    this._canvas = null;
    this._gl = null;
  },
  releaseGpuResources() {
    const gl = this._gl;
    if (!gl) return;
    if (this._buffer) {
      gl.deleteBuffer(this._buffer);
      this._buffer = null;
    }
    if (this._program) {
      gl.deleteProgram(this._program);
      this._program = null;
    }
  },
  setRows(rows) {
    this._rows = rows;
    return this._draw();
  },
  _reset() {
    if (!this._map || !this._canvas) return;
    const size = this._map.getSize();
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);
    this._canvas.width = size.x;
    this._canvas.height = size.y;
    this._canvas.style.width = `${size.x}px`;
    this._canvas.style.height = `${size.y}px`;
    this._draw();
  },
  _compileShader(type, source) {
    const gl = this._gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || "shader compile failed";
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  },
  _ensureProgram() {
    if (this._program) return this._program;
    const gl = this._gl;
    const vertexShader = this._compileShader(
      gl.VERTEX_SHADER,
      `#version 300 es
      in vec2 a_position;
      in vec4 a_color;
      out vec4 v_color;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_color = a_color;
      }`
    );
    const fragmentShader = this._compileShader(
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision mediump float;
      in vec4 v_color;
      out vec4 outColor;
      void main() {
        outColor = v_color;
      }`
    );
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || "program link failed";
      gl.deleteProgram(program);
      throw new Error(message);
    }
    this._program = program;
    this._buffer = gl.createBuffer();
    this._positionLocation = gl.getAttribLocation(program, "a_position");
    this._colorLocation = gl.getAttribLocation(program, "a_color");
    return program;
  },
  _pushRect(vertices, x, y, w, h, width, height, color, alpha) {
    const x1 = (x / width) * 2 - 1;
    const x2 = ((x + w) / width) * 2 - 1;
    const y1 = 1 - (y / height) * 2;
    const y2 = 1 - ((y + h) / height) * 2;
    const r = color[0] / 255;
    const g = color[1] / 255;
    const b = color[2] / 255;
    vertices.push(
      x1, y1, r, g, b, alpha,
      x2, y1, r, g, b, alpha,
      x1, y2, r, g, b, alpha,
      x1, y2, r, g, b, alpha,
      x2, y1, r, g, b, alpha,
      x2, y2, r, g, b, alpha
    );
  },
  _draw() {
    const started = this._renderClock.now();
    if (!this._gl || !this._map || !this._canvas) return 0;
    const gl = this._gl;
    const size = this._map.getSize();
    gl.viewport(0, 0, size.x, size.y);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const vertices = [];
    const alpha = Math.max(0, Math.min(1, Number(
      state.layerAlpha[state.dataLayer] ?? state.sampledGridPaint?.alpha ?? 1
    )));
    const renderRows = sampledGridRowsForRender(this._rows);
    const model = SampledGridContract.model();
    const hitCells = [];
    for (const row of renderRows) {
      const bounds = model.bounds(row);
      if (!bounds) continue;
      const nw = this._map.latLngToContainerPoint([bounds.north, bounds.west]);
      const se = this._map.latLngToContainerPoint([bounds.south, bounds.east]);
      const x = Math.floor(Math.min(nw.x, se.x));
      const y = Math.floor(Math.min(nw.y, se.y));
      const w = Math.max(1, Math.ceil(Math.abs(se.x - nw.x)));
      const h = Math.max(1, Math.ceil(Math.abs(se.y - nw.y)));
      if (x > size.x || y > size.y || x + w < 0 || y + h < 0) continue;
      const cellOpacity = sampledGridCellOpacity(row);
      if (cellOpacity > 0) {
        this._pushRect(
          vertices,
          x,
          y,
          w,
          h,
          size.x,
          size.y,
          sampledGridCellColorParts(row),
          alpha * cellOpacity
        );
      }
      hitCells.push({
        row,
        rect: { x, y, w, h },
        bounds: {
          ...bounds,
          leaflet: L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]),
        },
        center: {
          lat: (bounds.south + bounds.north) / 2,
          lon: normalizeLongitude((bounds.west + bounds.east) / 2),
        },
      });
    }
    this._hitCells = hitCells;
    if (!vertices.length) {
      this._drawMs = this._renderClock.now() - started;
      return this._drawMs;
    }

    try {
      const program = this._ensureProgram();
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
      const stride = 6 * Float32Array.BYTES_PER_ELEMENT;
      gl.enableVertexAttribArray(this._positionLocation);
      gl.vertexAttribPointer(this._positionLocation, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(this._colorLocation);
      gl.vertexAttribPointer(this._colorLocation, 4, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(
        gl.SRC_ALPHA,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE,
        gl.ONE_MINUS_SRC_ALPHA
      );
      gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 6);
      gl.disable(gl.BLEND);
      this._drawMs = this._renderClock.now() - started;
      return this._drawMs;
    } catch (err) {
      console.warn("Sampled-grid WebGL draw failed", err);
      this._failed = true;
      this._drawMs = this._renderClock.now() - started;
      return this._drawMs;
    }
  },
  hitTest(containerPoint) {
    const point = L.point(containerPoint);
    for (let index = this._hitCells.length - 1; index >= 0; index -= 1) {
      const cell = this._hitCells[index];
      const { x, y, w, h } = cell.rect;
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h) {
        return cell;
      }
    }
    return null;
  },
});

SampledGridWebglLayer.isSupported = function isSupported() {
  const canvas = document.createElement("canvas");
  return Boolean(canvas.getContext("webgl2", { powerPreference: "high-performance" }));
};

window.SampledGridWebglLayer = SampledGridWebglLayer;
