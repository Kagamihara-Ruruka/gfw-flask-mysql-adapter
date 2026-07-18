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
    this._frame = CanonicalGridFrame.empty();
    this._drawMs = 0;
    this._vertexData = new Float32Array(0);
    this._aggregationVertexData = new Float32Array(0);
    this._gpuBufferFloats = 0;
    this._aggregationBufferFloats = 0;
    this._aggregationTargetSize = { width: 0, height: 0 };
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
    this._aggregationSupported = Boolean(
      this._gl.getExtension("EXT_color_buffer_float")
      && this._gl.getExtension("EXT_float_blend")
    );
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
    for (const name of ["_aggregationBuffer", "_aggregationQuadBuffer"]) {
      if (this[name]) gl.deleteBuffer(this[name]);
      this[name] = null;
    }
    for (const name of ["_aggregationProgram", "_aggregationCompositeProgram"]) {
      if (this[name]) gl.deleteProgram(this[name]);
      this[name] = null;
    }
    if (this._aggregationTexture) gl.deleteTexture(this._aggregationTexture);
    if (this._aggregationFramebuffer) gl.deleteFramebuffer(this._aggregationFramebuffer);
    this._aggregationTexture = null;
    this._aggregationFramebuffer = null;
    this._aggregationBufferFloats = 0;
    this._aggregationTargetSize = { width: 0, height: 0 };
  },
  setFrame(frame) {
    if (!CanonicalGridFrame.isFrame(frame)) throw new TypeError("Sampled-grid WebGL layer requires CanonicalGridFrame");
    this._frame = frame;
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
  _ensureAggregationPrograms() {
    if (this._aggregationProgram && this._aggregationCompositeProgram) return;
    const gl = this._gl;
    const accumulationVertex = this._compileShader(
      gl.VERTEX_SHADER,
      `#version 300 es
      in vec2 a_position;
      in float a_value;
      out float v_value;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_value = a_value;
      }`
    );
    const accumulationFragment = this._compileShader(
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision highp float;
      in float v_value;
      out vec4 outAccumulation;
      void main() {
        outAccumulation = vec4(v_value, 1.0, 0.0, 0.0);
      }`
    );
    const accumulationProgram = gl.createProgram();
    gl.attachShader(accumulationProgram, accumulationVertex);
    gl.attachShader(accumulationProgram, accumulationFragment);
    gl.linkProgram(accumulationProgram);
    gl.deleteShader(accumulationVertex);
    gl.deleteShader(accumulationFragment);
    if (!gl.getProgramParameter(accumulationProgram, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(accumulationProgram) || "aggregation program link failed";
      gl.deleteProgram(accumulationProgram);
      throw new Error(message);
    }

    const compositeVertex = this._compileShader(
      gl.VERTEX_SHADER,
      `#version 300 es
      in vec2 a_position;
      in vec2 a_uv;
      out vec2 v_uv;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_uv = a_uv;
      }`
    );
    const compositeFragment = this._compileShader(
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_accumulation;
      uniform float u_domain_min;
      uniform float u_domain_max;
      uniform float u_alpha;
      uniform float u_zero_opacity;
      uniform int u_stop_count;
      uniform float u_stop_positions[8];
      uniform vec3 u_stop_colors[8];
      out vec4 outColor;

      vec3 sampledColor(float ratio) {
        vec3 result = u_stop_colors[0];
        for (int index = 1; index < 8; index += 1) {
          if (index >= u_stop_count) break;
          float rightPosition = u_stop_positions[index];
          vec3 rightColor = u_stop_colors[index];
          if (ratio <= rightPosition) {
            float leftPosition = u_stop_positions[index - 1];
            float width = max(0.000001, rightPosition - leftPosition);
            return mix(u_stop_colors[index - 1], rightColor, clamp((ratio - leftPosition) / width, 0.0, 1.0));
          }
          result = rightColor;
        }
        return result;
      }

      void main() {
        vec4 accumulated = texture(u_accumulation, v_uv);
        if (accumulated.g <= 0.0) discard;
        float value = accumulated.r / accumulated.g;
        float cellOpacity = abs(value) <= 0.0000001 ? u_zero_opacity : 1.0;
        if (cellOpacity <= 0.0) discard;
        float ratio = clamp((value - u_domain_min) / max(0.000001, u_domain_max - u_domain_min), 0.0, 1.0);
        outColor = vec4(sampledColor(ratio), u_alpha * cellOpacity);
      }`
    );
    const compositeProgram = gl.createProgram();
    gl.attachShader(compositeProgram, compositeVertex);
    gl.attachShader(compositeProgram, compositeFragment);
    gl.linkProgram(compositeProgram);
    gl.deleteShader(compositeVertex);
    gl.deleteShader(compositeFragment);
    if (!gl.getProgramParameter(compositeProgram, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(compositeProgram) || "aggregation composite link failed";
      gl.deleteProgram(accumulationProgram);
      gl.deleteProgram(compositeProgram);
      throw new Error(message);
    }

    this._aggregationProgram = accumulationProgram;
    this._aggregationCompositeProgram = compositeProgram;
    this._aggregationBuffer = gl.createBuffer();
    this._aggregationQuadBuffer = gl.createBuffer();
    this._aggregationPositionLocation = gl.getAttribLocation(accumulationProgram, "a_position");
    this._aggregationValueLocation = gl.getAttribLocation(accumulationProgram, "a_value");
    this._aggregationCompositePositionLocation = gl.getAttribLocation(compositeProgram, "a_position");
    this._aggregationCompositeUvLocation = gl.getAttribLocation(compositeProgram, "a_uv");
  },
  _ensureAggregationTarget(width, height) {
    if (!this._aggregationSupported) return false;
    this._ensureAggregationPrograms();
    const gl = this._gl;
    if (!this._aggregationTexture) {
      this._aggregationTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._aggregationTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._aggregationFramebuffer = gl.createFramebuffer();
    }
    if (this._aggregationTargetSize.width !== width || this._aggregationTargetSize.height !== height) {
      gl.bindTexture(gl.TEXTURE_2D, this._aggregationTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
      this._aggregationTargetSize = { width, height };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._aggregationFramebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this._aggregationTexture,
      0,
    );
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return complete;
  },
  _ensureVertexCapacity(requiredFloats) {
    if (this._vertexData.length >= requiredFloats) return this._vertexData;
    let capacity = Math.max(1024, this._vertexData.length || 0);
    while (capacity < requiredFloats) capacity *= 2;
    this._vertexData = new Float32Array(capacity);
    return this._vertexData;
  },
  _ensureAggregationVertexCapacity(requiredFloats) {
    if (this._aggregationVertexData.length >= requiredFloats) return this._aggregationVertexData;
    let capacity = Math.max(1024, this._aggregationVertexData.length || 0);
    while (capacity < requiredFloats) capacity *= 2;
    this._aggregationVertexData = new Float32Array(capacity);
    return this._aggregationVertexData;
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
  _writeAggregationRect(vertices, offset, x1, y1, x2, y2, width, height, value) {
    const left = (x1 / width) * 2 - 1;
    const right = (x2 / width) * 2 - 1;
    const top = 1 - (y1 / height) * 2;
    const bottom = 1 - (y2 / height) * 2;
    const writeVertex = (x, y) => {
      vertices[offset++] = x;
      vertices[offset++] = y;
      vertices[offset++] = value;
    };
    writeVertex(left, top);
    writeVertex(right, top);
    writeVertex(left, bottom);
    writeVertex(left, bottom);
    writeVertex(right, top);
    writeVertex(right, bottom);
    return offset;
  },
  _aggregationBounds(bounds, geometry, target = {}) {
    const width = Number(geometry?.cell_width_degrees);
    const height = Number(geometry?.cell_height_degrees);
    const originLon = Number(geometry?.origin_lon);
    const originLat = Number(geometry?.origin_lat);
    if (![width, height, originLon, originLat].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    const longitude = normalizeLongitude((Number(bounds.west) + Number(bounds.east)) / 2);
    const latitude = (Number(bounds.south) + Number(bounds.north)) / 2;
    const west = originLon + Math.floor(((longitude - originLon) / width) + 1e-10) * width;
    const south = originLat + Math.floor(((latitude - originLat) / height) + 1e-10) * height;
    target.west = west;
    target.south = south;
    target.east = west + width;
    target.north = south + height;
    return target;
  },
  _drawAggregated(paintFrame, profile, alpha, started) {
    const gl = this._gl;
    const size = this._map.getSize();
    if (!this._ensureAggregationTarget(size.x, size.y)) return null;
    const vertices = this._ensureAggregationVertexCapacity(paintFrame.validIndices.length * 18);
    const boundsScratch = {};
    const aggregateBounds = {};
    let vertexFloatCount = 0;
    for (const index of paintFrame.validIndices) {
      const bounds = this._frame.boundsAt(index, boundsScratch);
      if (!bounds || !this._aggregationBounds(bounds, profile.geometry, aggregateBounds)) continue;
      const nw = this._map.latLngToContainerPoint([aggregateBounds.north, aggregateBounds.west]);
      const se = this._map.latLngToContainerPoint([aggregateBounds.south, aggregateBounds.east]);
      const x1 = Math.min(nw.x, se.x);
      const y1 = Math.min(nw.y, se.y);
      const x2 = Math.max(nw.x, se.x);
      const y2 = Math.max(nw.y, se.y);
      if (x1 > size.x || y1 > size.y || x2 < 0 || y2 < 0) continue;
      const value = Number(this._frame.valueAt("value", index));
      if (!Number.isFinite(value)) continue;
      vertexFloatCount = this._writeAggregationRect(
        vertices,
        vertexFloatCount,
        x1,
        y1,
        x2,
        y2,
        size.x,
        size.y,
        value,
      );
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._aggregationFramebuffer);
    gl.viewport(0, 0, size.x, size.y);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (vertexFloatCount) {
      gl.useProgram(this._aggregationProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._aggregationBuffer);
      if (this._aggregationBufferFloats < vertices.length) {
        gl.bufferData(gl.ARRAY_BUFFER, vertices.byteLength, gl.DYNAMIC_DRAW);
        this._aggregationBufferFloats = vertices.length;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices, 0, vertexFloatCount);
      const stride = 3 * Float32Array.BYTES_PER_ELEMENT;
      gl.enableVertexAttribArray(this._aggregationPositionLocation);
      gl.vertexAttribPointer(this._aggregationPositionLocation, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(this._aggregationValueLocation);
      gl.vertexAttribPointer(
        this._aggregationValueLocation,
        1,
        gl.FLOAT,
        false,
        stride,
        2 * Float32Array.BYTES_PER_ELEMENT,
      );
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.TRIANGLES, 0, vertexFloatCount / 3);
      gl.disable(gl.BLEND);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, size.x, size.y);
    if (!vertexFloatCount) return this._renderClock.now() - started;
    const quad = new Float32Array([
      -1, 1, 0, 1,
      1, 1, 1, 1,
      -1, -1, 0, 0,
      -1, -1, 0, 0,
      1, 1, 1, 1,
      1, -1, 1, 0,
    ]);
    gl.useProgram(this._aggregationCompositeProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._aggregationQuadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const quadStride = 4 * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(this._aggregationCompositePositionLocation);
    gl.vertexAttribPointer(this._aggregationCompositePositionLocation, 2, gl.FLOAT, false, quadStride, 0);
    gl.enableVertexAttribArray(this._aggregationCompositeUvLocation);
    gl.vertexAttribPointer(
      this._aggregationCompositeUvLocation,
      2,
      gl.FLOAT,
      false,
      quadStride,
      2 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._aggregationTexture);
    gl.uniform1i(gl.getUniformLocation(this._aggregationCompositeProgram, "u_accumulation"), 0);
    gl.uniform1f(gl.getUniformLocation(this._aggregationCompositeProgram, "u_domain_min"), paintFrame.domain.min);
    gl.uniform1f(gl.getUniformLocation(this._aggregationCompositeProgram, "u_domain_max"), paintFrame.domain.max);
    gl.uniform1f(gl.getUniformLocation(this._aggregationCompositeProgram, "u_alpha"), alpha);
    gl.uniform1f(gl.getUniformLocation(this._aggregationCompositeProgram, "u_zero_opacity"), paintFrame.zeroOpacity);
    const stops = paintFrame.compiledStops.slice(0, 8);
    const positions = new Float32Array(8);
    const colors = new Float32Array(24);
    stops.forEach((stop, index) => {
      positions[index] = stop.position;
      colors[index * 3] = stop.channels[0] / 255;
      colors[index * 3 + 1] = stop.channels[1] / 255;
      colors[index * 3 + 2] = stop.channels[2] / 255;
    });
    gl.uniform1i(gl.getUniformLocation(this._aggregationCompositeProgram, "u_stop_count"), stops.length);
    gl.uniform1fv(gl.getUniformLocation(this._aggregationCompositeProgram, "u_stop_positions[0]"), positions);
    gl.uniform3fv(gl.getUniformLocation(this._aggregationCompositeProgram, "u_stop_colors[0]"), colors);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
    return this._renderClock.now() - started;
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
    const paintFrame = sampledGridPaintFrame(this._frame);
    const renderGridProfile = state.renderGridProfile;
    if (this._canvas) {
      this._canvas.dataset.renderGridFactor = String(renderGridProfile?.aggregationFactor || 1);
      this._canvas.dataset.renderGridReducer = String(renderGridProfile?.reducer || "none");
      this._canvas.dataset.renderGridBaseResolutionKm = String(renderGridProfile?.baseResolutionKm || "");
      this._canvas.dataset.renderGridResolutionKm = String(renderGridProfile?.renderResolutionKm || "");
    }
    if (
      renderGridProfile?.gpuAggregation
      && renderGridProfile.reducer === "mean"
      && renderGridProfile.nullPolicy === "ignore"
    ) {
      try {
        const drawMs = this._drawAggregated(paintFrame, renderGridProfile, alpha, started);
        if (Number.isFinite(drawMs)) {
          this._drawMs = drawMs;
          return drawMs;
        }
      } catch (err) {
        console.warn("Sampled-grid GPU aggregation failed", err);
        SampledGridWebglLayer.disableAggregation?.();
        window.VirtualGridController?.refresh?.("gpu_aggregation_failed");
      }
    }
    const vertices = this._ensureVertexCapacity(paintFrame.indices.length * 36);
    let vertexFloatCount = 0;
    const boundsScratch = {};
    for (const index of paintFrame.indices) {
      const bounds = this._frame.boundsAt(index, boundsScratch);
      if (!bounds) continue;
      const nw = this._map.latLngToContainerPoint([bounds.north, bounds.west]);
      const se = this._map.latLngToContainerPoint([bounds.south, bounds.east]);
      const x = Math.floor(Math.min(nw.x, se.x));
      const y = Math.floor(Math.min(nw.y, se.y));
      const w = Math.max(1, Math.ceil(Math.abs(se.x - nw.x)));
      const h = Math.max(1, Math.ceil(Math.abs(se.y - nw.y)));
      if (x > size.x || y > size.y || x + w < 0 || y + h < 0) continue;
      const value = Number(this._frame.valueAt("value", index));
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
    return sampledGridHitCellAt(this._map, this._frame, containerPoint);
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

let sampledGridAggregationSupported = null;

SampledGridWebglLayer.supportsAggregation = function supportsAggregation() {
  if (sampledGridAggregationSupported !== null) return sampledGridAggregationSupported;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { powerPreference: "high-performance" });
  sampledGridAggregationSupported = Boolean(
    gl
    && gl.getExtension("EXT_color_buffer_float")
    && gl.getExtension("EXT_float_blend")
  );
  releaseWebglContext(gl);
  return sampledGridAggregationSupported;
};

SampledGridWebglLayer.disableAggregation = function disableAggregation() {
  sampledGridAggregationSupported = false;
};

window.SampledGridWebglLayer = SampledGridWebglLayer;
