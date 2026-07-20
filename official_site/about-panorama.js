import * as THREE from "./assets/vendor/three.module.js";
import { applyHeroSeamPalette, toneFromSamples } from "./hero-seam-sampler.js";

const mount = document.querySelector("[data-about-panorama]");

const setupHydrophoneSoundscape = (sceneMount) => {
  if (!sceneMount) return { dispose() {} };

  const hydrophone = new Audio(new URL("./assets/noaa-oceanographic-sound-source-12s.mp3", import.meta.url));
  const initialDelay = () => 9000 + Math.random() * 7000;
  const repeatDelay = () => 48000 + Math.random() * 34000;
  let timer = 0;
  let unlocked = false;
  let unlocking = false;
  let disposed = false;

  hydrophone.preload = "auto";
  hydrophone.volume = 0.13;

  const clearTimer = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
  };

  const schedule = (delay = repeatDelay()) => {
    clearTimer();
    if (disposed || !unlocked || document.hidden) return;
    timer = window.setTimeout(() => {
      timer = 0;
      if (disposed || document.hidden) return;
      hydrophone.currentTime = 0;
      hydrophone.play().catch(() => {
        unlocked = false;
      });
    }, delay);
  };

  const removeUnlockListeners = () => {
    document.removeEventListener("pointerdown", handleFirstInteraction, true);
    document.removeEventListener("keydown", handleFirstInteraction, true);
  };

  const unlock = async () => {
    if (disposed || unlocked || unlocking) return;
    unlocking = true;
    const previousMuted = hydrophone.muted;
    hydrophone.muted = true;
    try {
      await hydrophone.play();
      hydrophone.pause();
      hydrophone.currentTime = 0;
      unlocked = true;
      removeUnlockListeners();
      schedule(initialDelay());
    } catch {
      unlocked = false;
    } finally {
      hydrophone.muted = previousMuted;
      unlocking = false;
    }
  };

  function handleFirstInteraction() {
    unlock();
  }

  const handleVisibilityChange = () => {
    if (document.hidden) {
      clearTimer();
      hydrophone.pause();
      hydrophone.currentTime = 0;
      return;
    }
    schedule(initialDelay());
  };

  const handleEnded = () => schedule();
  hydrophone.addEventListener("ended", handleEnded);
  document.addEventListener("pointerdown", handleFirstInteraction, true);
  document.addEventListener("keydown", handleFirstInteraction, true);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  return {
    dispose() {
      disposed = true;
      clearTimer();
      hydrophone.pause();
      hydrophone.removeEventListener("ended", handleEnded);
      removeUnlockListeners();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    },
  };
};

const hydrophoneSoundscape = setupHydrophoneSoundscape(mount);

if (mount) {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.domElement.setAttribute("aria-hidden", "true");
  mount.append(renderer.domElement);

  const uniforms = {
    uPanorama: { value: null },
    uAspect: { value: 1 },
    uFov: { value: THREE.MathUtils.degToRad(62) },
    uYaw: { value: 0 },
    uPitch: { value: -0.22 },
    uTime: { value: 0 },
    uLamp: { value: 1 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform sampler2D uPanorama;
      uniform float uAspect;
      uniform float uFov;
      uniform float uYaw;
      uniform float uPitch;
      uniform float uTime;
      uniform float uLamp;
      varying vec2 vUv;

      const float PI = 3.141592653589793;
      const float TAU = 6.283185307179586;

      vec3 rotateView(vec3 ray) {
        float cp = cos(uPitch);
        float sp = sin(uPitch);
        float cy = cos(uYaw);
        float sy = sin(uYaw);
        ray = vec3(ray.x, cp * ray.y - sp * ray.z, sp * ray.y + cp * ray.z);
        return vec3(cy * ray.x - sy * ray.z, ray.y, sy * ray.x + cy * ray.z);
      }

      void main() {
        vec2 view = vUv * 2.0 - 1.0;
        view.x *= uAspect;
        float focalLength = 1.0 / tan(uFov * 0.5);
        vec3 ray = rotateView(normalize(vec3(view.x, view.y, -focalLength)));
        float longitude = atan(ray.x, -ray.z);
        float latitude = asin(clamp(ray.y, -1.0, 1.0));
        vec2 panoramaUv = vec2(fract(0.5 + longitude / TAU), 0.5 + latitude / PI);
        vec3 color = texture2D(uPanorama, panoramaUv).rgb;
        float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
        color = mix(vec3(luminance), color, 0.76);
        color = pow(color, vec3(1.12)) * vec3(0.62, 0.78, 0.98);
        float vignette = 1.0 - smoothstep(0.52, 1.14, length(view * vec2(0.78, 0.92)));
        vec2 lampVector = (vUv - vec2(0.64, 0.48)) * vec2(1.3, 1.0);
        float lampCone = 1.0 - smoothstep(0.08, 0.74, length(lampVector));
        float lampLevel = mix(0.08, 0.68 + lampCone * 0.72, uLamp);
        color *= lampLevel * mix(0.78, 1.0, vignette);
        color += vec3(0.08, 0.24, 0.34) * lampCone * uLamp * 0.16;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });

  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  let targetYaw = 0;
  let targetPitch = -0.22;
  let yaw = targetYaw;
  let pitch = targetPitch;
  let pointerId = null;
  let pointerStartX = 0;
  let pointerStartY = 0;
  let startYaw = 0;
  let startPitch = 0;
  let dragDistance = 0;
  let targetLamp = 1;
  let lamp = 1;
  let frameId = 0;
  let intersecting = true;
  let contextLost = false;
  let tonePixels = null;
  let toneWidth = 0;
  let toneHeight = 0;
  let lastToneSampleAt = 0;
  let appliedSegments = Array.from({ length: 8 }, () => [8, 34, 42]);
  const startedAt = performance.now();

  const clampPitch = (value) => THREE.MathUtils.clamp(value, -0.42, 0.34);
  const normalizeYaw = () => {
    if (Math.abs(targetYaw) < Math.PI * 8) return;
    const normalized = THREE.MathUtils.euclideanModulo(targetYaw + Math.PI, Math.PI * 2) - Math.PI;
    yaw += normalized - targetYaw;
    targetYaw = normalized;
  };

  const prepareToneSampler = (image) => {
    const canvas = document.createElement("canvas");
    toneWidth = 128;
    toneHeight = 64;
    canvas.width = toneWidth;
    canvas.height = toneHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0, toneWidth, toneHeight);
    tonePixels = context.getImageData(0, 0, toneWidth, toneHeight).data;
  };

  const sampleVisibleSegments = () => {
    if (!tonePixels) return null;
    const focalLength = 1 / Math.tan(uniforms.uFov.value * 0.5);
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const segments = [];

    for (let segment = 0; segment < 8; segment += 1) {
      const samples = [];
      for (let row = 0; row < 8; row += 1) {
        const normalizedY = -0.14 + row / 7 * 1.08;
        for (let column = 0; column < 4; column += 1) {
          const screenX = (segment + (column + 0.5) / 4) / 8;
          const normalizedX = screenX * 2 - 1;
        const viewX = normalizedX * uniforms.uAspect.value;
        const viewY = normalizedY;
        const inverseLength = 1 / Math.hypot(viewX, viewY, focalLength);
        const rayX = viewX * inverseLength;
        const rayY = viewY * inverseLength;
        const rayZ = -focalLength * inverseLength;
        const pitchedY = cosPitch * rayY - sinPitch * rayZ;
        const pitchedZ = sinPitch * rayY + cosPitch * rayZ;
        const rotatedX = cosYaw * rayX - sinYaw * pitchedZ;
        const rotatedZ = sinYaw * rayX + cosYaw * pitchedZ;
        const longitude = Math.atan2(rotatedX, -rotatedZ);
        const latitude = Math.asin(THREE.MathUtils.clamp(pitchedY, -1, 1));
        const sourceX = THREE.MathUtils.euclideanModulo(0.5 + longitude / (Math.PI * 2), 1);
        const sourceY = THREE.MathUtils.clamp(0.5 - latitude / Math.PI, 0, 1);
        const pixelX = Math.min(toneWidth - 1, Math.floor(sourceX * toneWidth));
        const pixelY = Math.min(toneHeight - 1, Math.floor(sourceY * toneHeight));
        const pixelIndex = (pixelY * toneWidth + pixelX) * 4;
        const red = tonePixels[pixelIndex];
        const green = tonePixels[pixelIndex + 1];
        const blue = tonePixels[pixelIndex + 2];
        const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
          const localX = column / 3 * 2 - 1;
          const vertical = (normalizedY + 0.14) / 1.08;
          const weight = (0.72 + Math.sin(vertical * Math.PI) * 0.48) * Math.exp(-(localX ** 2) * 0.22);
          samples.push({ red, green, blue, luminance, weight });
        }
      }
      segments.push(toneFromSamples(samples, {
        base: [4, 8, 11],
        scale: [0.11, 0.14, 0.16],
      }));
    }
    return segments;
  };

  const updatePageTone = (now) => {
    if (now - lastToneSampleAt < 180) return;
    lastToneSampleAt = now;
    const nextSegments = sampleVisibleSegments();
    if (!nextSegments) return;
    const changed = nextSegments.some((segment, segmentIndex) => (
      segment.some((channel, channelIndex) => Math.abs(channel - appliedSegments[segmentIndex][channelIndex]) >= 1)
    ));
    if (!changed) return;
    appliedSegments = nextSegments;
    applyHeroSeamPalette(document.body, appliedSegments, {
      toneProperty: "--about-tone",
      seamProperty: "--about-seam-gradient",
    });
  };

  const resize = () => {
    const bounds = mount.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    renderer.setSize(bounds.width, bounds.height, false);
    uniforms.uAspect.value = bounds.width / bounds.height;
  };

  const beginDrag = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    pointerId = event.pointerId;
    pointerStartX = event.clientX;
    pointerStartY = event.clientY;
    startYaw = targetYaw;
    startPitch = targetPitch;
    dragDistance = 0;
    mount.classList.add("is-dragging");
    mount.setPointerCapture?.(pointerId);
  };

  const updateDrag = (event) => {
    if (event.pointerId !== pointerId) return;
    const deltaX = event.clientX - pointerStartX;
    const deltaY = event.clientY - pointerStartY;
    dragDistance = Math.max(dragDistance, Math.hypot(deltaX, deltaY));
    targetYaw = startYaw - deltaX * 0.0032;
    targetPitch = clampPitch(startPitch + deltaY * 0.0027);
  };

  const endDrag = (event) => {
    if (event.pointerId !== pointerId) return;
    if (dragDistance < 7) {
      targetLamp = targetLamp > 0.5 ? 0 : 1;
      mount.classList.toggle("is-lamp-off", targetLamp < 0.5);
    }
    if (mount.hasPointerCapture?.(pointerId)) mount.releasePointerCapture(pointerId);
    pointerId = null;
    normalizeYaw();
    mount.classList.remove("is-dragging");
  };

  const render = (now) => {
    const seconds = (now - startedAt) / 1000;
    const drift = reducedMotion.matches || pointerId !== null ? 0 : Math.sin(seconds * 0.11) * 0.012;
    yaw += ((targetYaw + drift) - yaw) * 0.075;
    pitch += (targetPitch - pitch) * 0.075;
    lamp += (targetLamp - lamp) * 0.1;
    uniforms.uYaw.value = yaw;
    uniforms.uPitch.value = pitch;
    uniforms.uTime.value = seconds;
    uniforms.uLamp.value = lamp;
    updatePageTone(now);
    renderer.render(scene, camera);
    frameId = requestAnimationFrame(render);
  };

  const stop = () => {
    if (!frameId) return;
    cancelAnimationFrame(frameId);
    frameId = 0;
  };

  const reconcile = () => {
    if (document.hidden || !intersecting || contextLost) {
      stop();
      return;
    }
    if (!frameId && uniforms.uPanorama.value) frameId = requestAnimationFrame(render);
  };

  const textureLoader = new THREE.TextureLoader();
  textureLoader.load(
    "./assets/about-stellwagen-seabed-360.webp",
    (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      uniforms.uPanorama.value = texture;
      prepareToneSampler(texture.image);
      updatePageTone(performance.now());
      mount.classList.add("is-ready");
      reconcile();
    },
    undefined,
    () => mount.classList.add("is-fallback"),
  );

  const resizeObserver = new ResizeObserver(resize);
  const intersectionObserver = new IntersectionObserver(([entry]) => {
    intersecting = entry.isIntersecting;
    reconcile();
  }, { threshold: 0.02 });

  resizeObserver.observe(mount);
  intersectionObserver.observe(mount);
  mount.addEventListener("pointerdown", beginDrag);
  mount.addEventListener("pointermove", updateDrag);
  mount.addEventListener("pointerup", endDrag);
  mount.addEventListener("pointercancel", endDrag);
  renderer.domElement.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    contextLost = true;
    mount.classList.add("is-fallback");
    stop();
  });
  renderer.domElement.addEventListener("webglcontextrestored", () => {
    contextLost = false;
    mount.classList.remove("is-fallback");
    reconcile();
  });
  document.addEventListener("visibilitychange", reconcile);
  reducedMotion.addEventListener("change", reconcile);
  resize();
}

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  hydrophoneSoundscape.dispose();
}, { once: true });
