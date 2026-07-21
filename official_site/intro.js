(function () {
  const targetUrl = "/index.html";
  const previewMode = new URLSearchParams(window.location.search).get("preview") === "1";
  const root = document.documentElement;
  const canvas = document.getElementById("shader");
  const earthWrap = document.querySelector(".earth-visual");
  const earthCanvas = document.getElementById("earthCanvas");
  const gl = canvas && canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance"
  });
  const earthGl = earthCanvas && earthCanvas.getContext("webgl", {
    alpha: true,
    antialias: true,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance"
  });

  let scrollProgress = 0;
  let burnLevel = 0;
  let burnHot = 0;
  let redirecting = false;
  const eastAsiaView = {
    yaw: 2.36,
    pitch: -0.4,
    velocityX: 0,
    velocityY: 0,
    dragging: false,
    lastX: 0,
    lastY: 0
  };

  function clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  function smoothstep(edge0, edge1, value) {
    const t = clamp01((value - edge0) / Math.max(edge1 - edge0, 0.0001));
    return t * t * (3 - 2 * t);
  }

  function easeOutCubic(value) {
    const t = clamp01(value);
    return 1 - Math.pow(1 - t, 3);
  }

  function updateScrollState() {
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    scrollProgress = Math.min(1, Math.max(0, window.scrollY / maxScroll));
    root.style.setProperty("--flight", scrollProgress.toFixed(4));

    const approach = smoothstep(0.04, 0.96, scrollProgress);
    const pathEase = Math.pow(approach, 1.25);
    const orbitalSwing = Math.sin(approach * Math.PI);
    const yawSwing = Math.sin(approach * Math.PI * 1.55 + 0.35);
    const pitchSwing = Math.sin(approach * Math.PI * 2.1 - 0.42);
    burnLevel = smoothstep(0.56, 0.96, scrollProgress);
    burnHot = smoothstep(0.78, 0.99, scrollProgress);

    const earthX = -3 - pathEase * 38 + orbitalSwing * 5.5 + yawSwing * 2.2;
    const earthY = -11 + pathEase * 35 + pitchSwing * 4.8 - burnHot * 5.5;
    const earthScale = 0.86 + pathEase * 1.55 + orbitalSwing * 0.1 + burnHot * 0.14;
    const earthRoll = -16 + pathEase * 12 + Math.sin(approach * Math.PI * 1.35) * 8 - burnHot * 4;
    const earthTiltX = Math.sin(approach * Math.PI * 1.18) * 6 - burnHot * 5;
    const earthTiltY = Math.cos(approach * Math.PI * 1.45) * 5 + orbitalSwing * 2.4;

    root.style.setProperty("--earth-flight-x", earthX.toFixed(2) + "vw");
    root.style.setProperty("--earth-flight-y", earthY.toFixed(2) + "vh");
    root.style.setProperty("--earth-flight-scale", earthScale.toFixed(4));
    root.style.setProperty("--earth-flight-roll", earthRoll.toFixed(3) + "deg");
    root.style.setProperty("--earth-flight-tilt-x", earthTiltX.toFixed(3) + "deg");
    root.style.setProperty("--earth-flight-tilt-y", earthTiltY.toFixed(3) + "deg");
    root.style.setProperty("--burn", burnLevel.toFixed(4));
    root.style.setProperty("--burn-hot", burnHot.toFixed(4));

    if (!previewMode && !redirecting && scrollProgress > 0.985) {
      redirecting = true;
      window.setTimeout(function () {
        window.location.href = targetUrl;
      }, 180);
    }
  }

  window.addEventListener("scroll", updateScrollState, { passive: true });
  window.addEventListener("resize", updateScrollState, { passive: true });
  updateScrollState();

  if (!canvas || !gl) {
    document.body.classList.add("shader-fallback");
    return;
  }

  const vertexSource = `
    attribute vec2 aPosition;
    void main() {
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;

  const fragmentSource = `
    precision highp float;

    uniform vec2 uResolution;
    uniform vec2 uPointer;
    uniform float uPulse;
    uniform float uScroll;
    uniform float uTime;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    float fbm(vec2 p) {
      float value = 0.0;
      float amp = 0.5;
      mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
      for (int i = 0; i < 5; i++) {
        value += amp * noise(p);
        p = rot * p * 2.04 + 8.17;
        amp *= 0.5;
      }
      return value;
    }

    vec3 colorFromHex(float r, float g, float b) {
      return vec3(r, g, b) / 255.0;
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / uResolution.xy;
      vec2 p = (gl_FragCoord.xy * 2.0 - uResolution.xy) / min(uResolution.x, uResolution.y);
      float t = uTime * 0.001;
      float entry = smoothstep(0.18, 0.92, uScroll);

      vec2 pointer = (uPointer - 0.5) * 2.0;
      pointer.x *= uResolution.x / uResolution.y;

      vec2 flow = p;
      flow.x += 0.16 * sin(flow.y * 1.85 + t * 0.18 + entry * 1.2);
      flow.y += 0.12 * sin(flow.x * 2.1 - t * 0.14);
      flow += pointer * 0.04;
      flow.y += entry * 0.52;

      float broad = fbm(flow * mix(0.58, 1.08, entry) + vec2(t * 0.022, -t * 0.016));
      float cloud = fbm(flow * mix(1.0, 1.62, entry) + vec2(-t * 0.018, t * 0.026 + entry));
      float tide = fbm(flow * 2.1 + vec2(t * 0.035, t * 0.018));
      float field = broad * 0.62 + cloud * 0.38;

      float horizon = exp(-pow((uv.y - mix(0.64, 0.48, entry)) * mix(5.4, 3.2, entry), 2.0));
      float air = smoothstep(0.28, 0.86, field);
      float wave = sin((flow.x * 1.08 + flow.y * 0.34 + tide * 0.82 + t * 0.1) * mix(5.6, 9.2, entry));
      float current = smoothstep(0.3, 0.96, wave * 0.5 + 0.5) * smoothstep(0.18, 0.88, tide);
      float mistCurrent = smoothstep(0.52, 1.0, current + horizon * 0.28);
      float pointerGlow = smoothstep(0.82, 0.0, length(p - pointer)) * uPulse;

      vec2 starGrid = uv * vec2(100.0, 62.0);
      vec2 starCell = floor(starGrid);
      vec2 starLocal = fract(starGrid) - 0.5;
      float starSeed = hash(starCell);
      float starShape = smoothstep(0.055, 0.0, length(starLocal));
      float stars = starShape * step(0.986, starSeed) * smoothstep(0.44, 0.92, uv.y) * (1.0 - entry * 0.72);

      float streak = smoothstep(0.99, 1.0, abs(sin((p.x * 0.78 - p.y * 0.92 + entry * 0.4) * mix(13.0, 26.0, entry))));
      streak *= 0.12 + entry * 0.42;

      vec3 space = colorFromHex(5.0, 11.0, 22.0);
      vec3 orbit = colorFromHex(13.0, 29.0, 49.0);
      vec3 ocean = colorFromHex(8.0, 58.0, 70.0);
      vec3 sky = colorFromHex(78.0, 115.0, 138.0);
      vec3 mist = colorFromHex(222.0, 249.0, 250.0);
      vec3 teal = colorFromHex(116.0, 215.0, 210.0);
      vec3 lime = colorFromHex(215.0, 239.0, 114.0);

      vec3 color = mix(ocean, space, smoothstep(0.12, 0.96, uv.y));
      color = mix(color, orbit, 0.35 * (1.0 - entry));
      color = mix(color, sky, air * (0.08 + entry * 0.16) + horizon * (0.08 + entry * 0.18));
      color += mist * (horizon * (0.14 + entry * 0.2) + stars * 0.7 + streak * 0.06);
      color += teal * (mistCurrent * (0.12 + entry * 0.12) + cloud * 0.045);
      color += lime * (current * tide * 0.035 + pointerGlow * 0.045);
      color += mist * pointerGlow * 0.055;

      float vignette = smoothstep(1.32, 0.2, length(p * vec2(0.82, 1.0)));
      color *= 0.62 + vignette * 0.46;
      color += (hash(gl_FragCoord.xy + t * 6.0) - 0.5) * 0.012;

      gl_FragColor = vec4(color, 1.0);
    }
  `;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn(gl.getShaderInfoLog(shader));
      document.body.classList.add("shader-fallback");
      return null;
    }
    return shader;
  }

  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return;

  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn(gl.getProgramInfoLog(program));
    document.body.classList.add("shader-fallback");
    return;
  }

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1,
      1, -1,
      -1, 1,
      -1, 1,
      1, -1,
      1, 1
    ]),
    gl.STATIC_DRAW
  );

  const position = gl.getAttribLocation(program, "aPosition");
  const resolution = gl.getUniformLocation(program, "uResolution");
  const pointerUniform = gl.getUniformLocation(program, "uPointer");
  const pulseUniform = gl.getUniformLocation(program, "uPulse");
  const scrollUniform = gl.getUniformLocation(program, "uScroll");
  const timeUniform = gl.getUniformLocation(program, "uTime");

  let earthProgram = null;
  let earthBuffer = null;
  let earthTexture = null;
  let earthPosition = null;
  let earthResolution = null;
  let earthYaw = null;
  let earthPitch = null;
  let earthScroll = null;
  let earthTime = null;
  let earthTextureUniform = null;

  if (earthGl) {
    const earthFragmentSource = `
      precision highp float;

      uniform sampler2D uTexture;
      uniform vec2 uResolution;
      uniform float uYaw;
      uniform float uPitch;
      uniform float uScroll;
      uniform float uTime;

      const float PI = 3.141592653589793;

      mat3 rotateX(float a) {
        float c = cos(a);
        float s = sin(a);
        return mat3(
          1.0, 0.0, 0.0,
          0.0, c, s,
          0.0, -s, c
        );
      }

      mat3 rotateY(float a) {
        float c = cos(a);
        float s = sin(a);
        return mat3(
          c, 0.0, -s,
          0.0, 1.0, 0.0,
          s, 0.0, c
        );
      }

      void main() {
        vec2 p = (gl_FragCoord.xy * 2.0 - uResolution.xy) / min(uResolution.x, uResolution.y);
        float r2 = dot(p, p);
        if (r2 > 1.0) {
          discard;
        }

        float z = sqrt(1.0 - r2);
        vec3 normal = normalize(vec3(p.x, p.y, z));
        vec3 world = rotateY(uYaw) * rotateX(uPitch) * normal;

        float lon = atan(world.x, world.z);
        float lat = asin(clamp(world.y, -1.0, 1.0));
        vec2 texCoord = vec2(fract(0.5 + lon / (2.0 * PI)), clamp(0.5 - lat / PI, 0.001, 0.999));
        vec3 earth = texture2D(uTexture, texCoord).rgb;

        float limb = smoothstep(0.0, 1.0, normal.z);
        float light = 0.46 + 0.54 * max(dot(normalize(vec3(-0.3, 0.38, 0.88)), normal), 0.0);
        float oceanBoost = smoothstep(0.28, 0.76, earth.b - earth.r + 0.18);
        float coastGlow = smoothstep(0.72, 1.0, earth.g + earth.b) * 0.06;
        vec3 color = earth * light;
        color += vec3(0.05, 0.13, 0.2) * oceanBoost * (0.28 + uScroll * 0.18);
        color += vec3(0.65, 0.9, 1.0) * coastGlow;

        float atmosphere = smoothstep(0.72, 1.0, sqrt(r2));
        color = mix(color, vec3(0.52, 0.78, 1.0), atmosphere * (0.16 + uScroll * 0.08));
        color *= 0.72 + limb * 0.42;

        float spec = pow(max(dot(reflect(normalize(vec3(0.42, -0.16, -1.0)), normal), vec3(0.0, 0.0, 1.0)), 0.0), 18.0);
        color += vec3(0.5, 0.8, 1.0) * spec * 0.08;

        float latitudeLine = 1.0 - smoothstep(0.0, 0.042, abs(sin(lat * 12.0)));
        float longitudeLine = 1.0 - smoothstep(0.0, 0.042, abs(sin(lon * 12.0)));
        float latitudeMajor = 1.0 - smoothstep(0.0, 0.034, abs(sin(lat * 4.0)));
        float longitudeMajor = 1.0 - smoothstep(0.0, 0.034, abs(sin(lon * 4.0)));
        float grid = max(latitudeLine, longitudeLine);
        float majorGrid = max(latitudeMajor, longitudeMajor);
        float gridVisibility = smoothstep(0.02, 0.3, normal.z) * (0.78 + 0.22 * sin(uTime * 0.0014));
        vec3 gridColor = vec3(0.12, 0.82, 1.0);
        color = mix(color, gridColor, grid * gridVisibility * 0.34);
        color += gridColor * majorGrid * gridVisibility * 0.2;

        float alpha = smoothstep(1.0, 0.965, sqrt(r2));
        gl_FragColor = vec4(color, alpha);
      }
    `;

    function compileEarth(type, source) {
      const shader = earthGl.createShader(type);
      earthGl.shaderSource(shader, source);
      earthGl.compileShader(shader);
      if (!earthGl.getShaderParameter(shader, earthGl.COMPILE_STATUS)) {
        console.warn(earthGl.getShaderInfoLog(shader));
        return null;
      }
      return shader;
    }

    const earthVertex = compileEarth(earthGl.VERTEX_SHADER, vertexSource);
    const earthFragment = compileEarth(earthGl.FRAGMENT_SHADER, earthFragmentSource);
    if (earthVertex && earthFragment) {
      earthProgram = earthGl.createProgram();
      earthGl.attachShader(earthProgram, earthVertex);
      earthGl.attachShader(earthProgram, earthFragment);
      earthGl.linkProgram(earthProgram);
      if (!earthGl.getProgramParameter(earthProgram, earthGl.LINK_STATUS)) {
        console.warn(earthGl.getProgramInfoLog(earthProgram));
        earthProgram = null;
      }
    }

    if (earthProgram) {
      earthBuffer = earthGl.createBuffer();
      earthGl.bindBuffer(earthGl.ARRAY_BUFFER, earthBuffer);
      earthGl.bufferData(
        earthGl.ARRAY_BUFFER,
        new Float32Array([
          -1, -1,
          1, -1,
          -1, 1,
          -1, 1,
          1, -1,
          1, 1
        ]),
        earthGl.STATIC_DRAW
      );

      earthPosition = earthGl.getAttribLocation(earthProgram, "aPosition");
      earthResolution = earthGl.getUniformLocation(earthProgram, "uResolution");
      earthYaw = earthGl.getUniformLocation(earthProgram, "uYaw");
      earthPitch = earthGl.getUniformLocation(earthProgram, "uPitch");
      earthScroll = earthGl.getUniformLocation(earthProgram, "uScroll");
      earthTime = earthGl.getUniformLocation(earthProgram, "uTime");
      earthTextureUniform = earthGl.getUniformLocation(earthProgram, "uTexture");

      earthTexture = earthGl.createTexture();
      earthGl.bindTexture(earthGl.TEXTURE_2D, earthTexture);
      earthGl.texParameteri(earthGl.TEXTURE_2D, earthGl.TEXTURE_WRAP_S, earthGl.CLAMP_TO_EDGE);
      earthGl.texParameteri(earthGl.TEXTURE_2D, earthGl.TEXTURE_WRAP_T, earthGl.CLAMP_TO_EDGE);
      earthGl.texParameteri(earthGl.TEXTURE_2D, earthGl.TEXTURE_MIN_FILTER, earthGl.LINEAR);
      earthGl.texParameteri(earthGl.TEXTURE_2D, earthGl.TEXTURE_MAG_FILTER, earthGl.LINEAR);
      earthGl.texImage2D(
        earthGl.TEXTURE_2D,
        0,
        earthGl.RGBA,
        1,
        1,
        0,
        earthGl.RGBA,
        earthGl.UNSIGNED_BYTE,
        new Uint8Array([12, 32, 52, 255])
      );

      const image = new Image();
      image.addEventListener("load", function () {
        earthGl.bindTexture(earthGl.TEXTURE_2D, earthTexture);
        earthGl.texImage2D(earthGl.TEXTURE_2D, 0, earthGl.RGBA, earthGl.RGBA, earthGl.UNSIGNED_BYTE, image);
      });
      image.src = "./assets/earth-east-asia-blue-marble-map.jpg";
    }
  }

  const pointer = {
    x: 0.68,
    y: 0.42,
    targetX: 0.68,
    targetY: 0.42,
    pulse: 0.3
  };

  function setPointer(clientX, clientY) {
    pointer.targetX = clientX / Math.max(window.innerWidth, 1);
    pointer.targetY = 1 - clientY / Math.max(window.innerHeight, 1);
    pointer.pulse = 1.0;
  }

  window.addEventListener("pointermove", function (event) {
    setPointer(event.clientX, event.clientY);
  }, { passive: true });

  window.addEventListener("pointerdown", function (event) {
    setPointer(event.clientX, event.clientY);
    pointer.pulse = 1.8;
  }, { passive: true });

  if (earthWrap) {
    earthWrap.addEventListener("pointerdown", function (event) {
      eastAsiaView.dragging = true;
      eastAsiaView.lastX = event.clientX;
      eastAsiaView.lastY = event.clientY;
      eastAsiaView.velocityX = 0;
      eastAsiaView.velocityY = 0;
      earthWrap.classList.add("is-dragging");
      earthWrap.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    earthWrap.addEventListener("pointermove", function (event) {
      if (!eastAsiaView.dragging) return;
      const dx = event.clientX - eastAsiaView.lastX;
      const dy = event.clientY - eastAsiaView.lastY;
      eastAsiaView.lastX = event.clientX;
      eastAsiaView.lastY = event.clientY;
      eastAsiaView.yaw -= dx * 0.006;
      eastAsiaView.pitch -= dy * 0.004;
      eastAsiaView.pitch = Math.max(-1.1, Math.min(0.95, eastAsiaView.pitch));
      eastAsiaView.velocityX = -dx * 0.004;
      eastAsiaView.velocityY = -dy * 0.003;
      event.preventDefault();
    });

    function releaseEarth(event) {
      if (!eastAsiaView.dragging) return;
      eastAsiaView.dragging = false;
      earthWrap.classList.remove("is-dragging");
      if (earthWrap.hasPointerCapture(event.pointerId)) {
        earthWrap.releasePointerCapture(event.pointerId);
      }
    }

    earthWrap.addEventListener("pointerup", releaseEarth);
    earthWrap.addEventListener("pointercancel", releaseEarth);
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(window.innerWidth * dpr));
    const height = Math.max(1, Math.floor(window.innerHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
    if (earthCanvas && earthGl && earthWrap) {
      const rect = earthWrap.getBoundingClientRect();
      const earthWidth = Math.max(1, Math.floor(rect.width * dpr));
      const earthHeight = Math.max(1, Math.floor(rect.height * dpr));
      if (earthCanvas.width !== earthWidth || earthCanvas.height !== earthHeight) {
        earthCanvas.width = earthWidth;
        earthCanvas.height = earthHeight;
        earthGl.viewport(0, 0, earthWidth, earthHeight);
      }
    }
  }

  window.addEventListener("resize", resize, { passive: true });
  resize();

  function render(now) {
    resize();
    pointer.x += (pointer.targetX - pointer.x) * 0.08;
    pointer.y += (pointer.targetY - pointer.y) * 0.08;
    pointer.pulse *= 0.965;

    const seconds = now * 0.001;
    const glow = 0.29 + scrollProgress * 0.14 + Math.max(0, Math.sin(seconds * 0.42)) * 0.08;
    const shadow = 0.61 - scrollProgress * 0.08 + Math.sin(seconds * 0.16) * 0.045;
    const cloudX = Math.sin(seconds * 0.18) * 34 - scrollProgress * 42;
    const cloudY = Math.cos(seconds * 0.13) * 18 + scrollProgress * 28;
    const earthBreathe = 1 + Math.sin(seconds * 0.12) * 0.01;
    const earthRoll = Math.sin(seconds * 0.08) * 1.8;
    const burnFlicker = 0.84 + Math.sin(seconds * 19.5) * 0.07 + Math.sin(seconds * 43.0) * 0.05;
    const burnJitterX = (Math.sin(seconds * 31.0) + Math.sin(seconds * 57.0) * 0.45) * burnLevel * 3.4;
    const burnJitterY = (Math.cos(seconds * 27.0) + Math.sin(seconds * 49.0) * 0.35) * burnLevel * 2.8;
    const burnShift = (seconds * 78 + Math.sin(seconds * 6.5) * 24) * burnLevel;

    root.style.setProperty("--earth-glow", glow.toFixed(3));
    root.style.setProperty("--earth-shadow", shadow.toFixed(3));
    root.style.setProperty("--cloud-x", cloudX.toFixed(1) + "px");
    root.style.setProperty("--cloud-y", cloudY.toFixed(1) + "px");
    root.style.setProperty("--earth-breathe", earthBreathe.toFixed(4));
    root.style.setProperty("--earth-roll", earthRoll.toFixed(3) + "deg");
    root.style.setProperty("--burn-flicker", burnFlicker.toFixed(3));
    root.style.setProperty("--burn-jitter-x", burnJitterX.toFixed(2) + "px");
    root.style.setProperty("--burn-jitter-y", burnJitterY.toFixed(2) + "px");
    root.style.setProperty("--burn-shift", burnShift.toFixed(2) + "px");

    if (!eastAsiaView.dragging) {
      eastAsiaView.yaw += 0.00055 + eastAsiaView.velocityX;
      eastAsiaView.pitch += eastAsiaView.velocityY;
      eastAsiaView.pitch = Math.max(-1.1, Math.min(0.95, eastAsiaView.pitch));
      eastAsiaView.velocityX *= 0.94;
      eastAsiaView.velocityY *= 0.9;
    }

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(resolution, canvas.width, canvas.height);
    gl.uniform2f(pointerUniform, pointer.x, pointer.y);
    gl.uniform1f(pulseUniform, pointer.pulse);
    gl.uniform1f(scrollUniform, scrollProgress);
    gl.uniform1f(timeUniform, now);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    if (earthProgram && earthGl && earthCanvas) {
      earthGl.clearColor(0, 0, 0, 0);
      earthGl.clear(earthGl.COLOR_BUFFER_BIT);
      earthGl.enable(earthGl.BLEND);
      earthGl.blendFunc(earthGl.SRC_ALPHA, earthGl.ONE_MINUS_SRC_ALPHA);
      earthGl.useProgram(earthProgram);
      earthGl.bindBuffer(earthGl.ARRAY_BUFFER, earthBuffer);
      earthGl.enableVertexAttribArray(earthPosition);
      earthGl.vertexAttribPointer(earthPosition, 2, earthGl.FLOAT, false, 0, 0);
      earthGl.activeTexture(earthGl.TEXTURE0);
      earthGl.bindTexture(earthGl.TEXTURE_2D, earthTexture);
      earthGl.uniform1i(earthTextureUniform, 0);
      earthGl.uniform2f(earthResolution, earthCanvas.width, earthCanvas.height);
      earthGl.uniform1f(earthYaw, eastAsiaView.yaw);
      earthGl.uniform1f(earthPitch, eastAsiaView.pitch);
      earthGl.uniform1f(earthScroll, scrollProgress);
      earthGl.uniform1f(earthTime, now);
      earthGl.drawArrays(earthGl.TRIANGLES, 0, 6);
    }

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}());
