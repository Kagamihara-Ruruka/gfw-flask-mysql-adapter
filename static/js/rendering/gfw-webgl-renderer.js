function bindSampledGridViewportRedraw(layer, targetMap) {
  layer._viewportResetFrame = null;
  layer._scheduleViewportReset = () => {
    if (layer._viewportResetFrame !== null) return;
    layer._viewportResetFrame = layer._renderClock.request(() => {
      layer._viewportResetFrame = null;
      if (layer._map === targetMap) layer._reset();
    });
  };
  targetMap.on("moveend zoomend resize", layer._scheduleViewportReset, layer);
}

function unbindSampledGridViewportRedraw(layer, targetMap) {
  targetMap.off("moveend zoomend resize", layer._scheduleViewportReset, layer);
  if (layer._viewportResetFrame !== null) {
    layer._renderClock.cancel(layer._viewportResetFrame);
    layer._viewportResetFrame = null;
  }
  layer._scheduleViewportReset = null;
}

function releaseWebglContext(gl) {
  gl?.getExtension?.("WEBGL_lose_context")?.loseContext?.();
}

const SampledGridWebglLayer = L.Layer.extend({
  initialize({ renderClock } = {}) {
    if (!renderClock || typeof renderClock.now !== "function") {
      throw new TypeError("SampledGridWebglLayer requires a render clock");
    }
    this._renderClock = renderClock;
    this._rows = [];
    this._drawMs = 0;
    this._vertexData = new Float32Array(0);
    this._gpuBufferFloats = 0;
    this._colorScratch = [0, 0, 0];
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
    bindSampledGridViewportRedraw(this, targetMap);
    this._reset();
  },
  onRemove(targetMap) {
    unbindSampledGridViewportRedraw(this, targetMap);
    this.releaseGpuResources();
    releaseWebglContext(this._gl);
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
    this._gpuBufferFloats = 0;
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
  _ensureVertexCapacity(requiredFloats) {
    if (this._vertexData.length >= requiredFloats) return this._vertexData;
    let capacity = Math.max(1024, this._vertexData.length || 0);
    while (capacity < requiredFloats) capacity *= 2;
    this._vertexData = new Float32Array(capacity);
    return this._vertexData;
  },
  _writeRect(vertices, offset, x, y, w, h, width, height, color, alpha) {
    const x1 = (x / width) * 2 - 1;
    const x2 = ((x + w) / width) * 2 - 1;
    const y1 = 1 - (y / height) * 2;
    const y2 = 1 - ((y + h) / height) * 2;
    const r = color[0] / 255;
    const g = color[1] / 255;
    const b = color[2] / 255;
    const writeVertex = (px, py) => {
      vertices[offset++] = px;
      vertices[offset++] = py;
      vertices[offset++] = r;
      vertices[offset++] = g;
      vertices[offset++] = b;
      vertices[offset++] = alpha;
    };
    writeVertex(x1, y1);
    writeVertex(x2, y1);
    writeVertex(x1, y2);
    writeVertex(x1, y2);
    writeVertex(x2, y1);
    writeVertex(x2, y2);
    return offset;
  },
  _draw() {
    const started = this._renderClock.now();
    if (!this._gl || !this._map || !this._canvas) return 0;
    const gl = this._gl;
    const size = this._map.getSize();
    gl.viewport(0, 0, size.x, size.y);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const alpha = Math.max(0, Math.min(1, Number(
      state.layerAlpha[state.dataLayer] ?? state.sampledGridPaint?.alpha ?? 1
    )));
    const paintFrame = sampledGridPaintFrame(this._rows);
    const renderRows = paintFrame.rows;
    const vertices = this._ensureVertexCapacity(renderRows.length * 36);
    let vertexFloatCount = 0;
    const model = paintFrame.model;
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
      const value = model.value(row);
      const cellOpacity = paintFrame.opacityForValue(value);
      if (cellOpacity > 0) {
        vertexFloatCount = this._writeRect(
          vertices,
          vertexFloatCount,
          x,
          y,
          w,
          h,
          size.x,
          size.y,
          paintFrame.colorPartsForValue(value, this._colorScratch),
          alpha * cellOpacity
        );
      }
    }
    if (!vertexFloatCount) {
      this._drawMs = this._renderClock.now() - started;
      return this._drawMs;
    }

    try {
      const program = this._ensureProgram();
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
      if (this._gpuBufferFloats < vertices.length) {
        gl.bufferData(gl.ARRAY_BUFFER, vertices.byteLength, gl.DYNAMIC_DRAW);
        this._gpuBufferFloats = vertices.length;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices, 0, vertexFloatCount);
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
      gl.drawArrays(gl.TRIANGLES, 0, vertexFloatCount / 6);
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
    return sampledGridHitCellAt(this._map, this._rows, containerPoint);
  },
});

let sampledGridWebglSupported = null;

SampledGridWebglLayer.isSupported = function isSupported() {
  if (sampledGridWebglSupported !== null) return sampledGridWebglSupported;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { powerPreference: "high-performance" });
  sampledGridWebglSupported = Boolean(gl);
  releaseWebglContext(gl);
  return sampledGridWebglSupported;
};

window.SampledGridWebglLayer = SampledGridWebglLayer;
