import { setupImageHeroSeam } from "./hero-seam-sampler.js";
import { setupAmbientSoundscape } from "./assets/ambient-soundscape.js?v=1";

const dataSeam = setupImageHeroSeam({
  target: document.body,
  imageUrl: new URL("./assets/ppt-ocean-vortex.jpg", import.meta.url),
  sampleBand: [0.34, 0.78],
  toneProperty: "--data-tone",
  seamProperty: "--data-seam-gradient",
  toneOptions: { base: [2, 5, 8], scale: [0.055, 0.075, 0.1] },
});

const windSoundscape = setupAmbientSoundscape({
  ownerId: "data-wind",
  source: new URL("./assets/data-howling-wind-cc0.ogg", import.meta.url),
  mode: "intermittent",
  volume: 0.1,
  initialDelay: [7000, 14000],
  repeatDelay: [38000, 76000],
  segmentDuration: [8000, 15000],
  fadeDuration: 2200,
});

(() => {
  const canvas = document.querySelector("[data-vortex-flow]");
  const hero = canvas?.closest(".data-sources-hero");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!canvas || !hero || reducedMotion.matches) return;

  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return;

  const vortices = [
    { x: 0.526, y: 0.5, radius: 0.145, direction: 1, speed: 0.014, angle: 0 },
    { x: 0.704, y: 0.727, radius: 0.14, direction: -1, speed: 0.015, angle: 0 },
    { x: 0.132, y: 0.535, radius: 0.14, direction: -1, speed: 0.013, angle: 0 },
  ];
  const image = new Image();
  let cssWidth = 1;
  let cssHeight = 1;
  let pixelRatio = 1;
  let patches = [];
  let frameId = 0;
  let lastDrawAt = 0;
  let intersecting = true;
  let disposed = false;

  const buildPatch = (vortex) => {
    const sourceRadius = vortex.radius * image.naturalWidth;
    const sourceDiameter = sourceRadius * 2;
    const patch = document.createElement("canvas");
    const patchSize = Math.max(128, Math.min(520, Math.round(sourceDiameter)));
    patch.width = patchSize;
    patch.height = patchSize;
    const patchContext = patch.getContext("2d");
    if (!patchContext) return null;

    const sourceX = vortex.x * image.naturalWidth - sourceRadius;
    const sourceY = vortex.y * image.naturalHeight - sourceRadius;
    patchContext.drawImage(
      image,
      sourceX,
      sourceY,
      sourceDiameter,
      sourceDiameter,
      0,
      0,
      patchSize,
      patchSize,
    );
    patchContext.globalCompositeOperation = "destination-in";
    const feather = patchContext.createRadialGradient(
      patchSize / 2,
      patchSize / 2,
      patchSize * 0.28,
      patchSize / 2,
      patchSize / 2,
      patchSize * 0.5,
    );
    feather.addColorStop(0, "rgba(255,255,255,1)");
    feather.addColorStop(0.62, "rgba(255,255,255,0.94)");
    feather.addColorStop(0.84, "rgba(255,255,255,0.48)");
    feather.addColorStop(1, "rgba(255,255,255,0)");
    patchContext.fillStyle = feather;
    patchContext.fillRect(0, 0, patchSize, patchSize);
    return { canvas: patch, sourceDiameter };
  };

  const coverFrame = () => {
    const scale = Math.max(cssWidth / image.naturalWidth, cssHeight / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    return {
      scale,
      width,
      height,
      x: (cssWidth - width) * 0.5,
      y: (cssHeight - height) * 0.42,
    };
  };

  const resize = () => {
    const bounds = canvas.getBoundingClientRect();
    pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    cssWidth = Math.max(1, bounds.width);
    cssHeight = Math.max(1, bounds.height);
    canvas.width = Math.round(cssWidth * pixelRatio);
    canvas.height = Math.round(cssHeight * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
  };

  const draw = (time) => {
    frameId = 0;
    if (disposed || document.hidden || !intersecting || !image.naturalWidth) return;
    if (time - lastDrawAt < 33) {
      frameId = requestAnimationFrame(draw);
      return;
    }

    const deltaSeconds = Math.min(0.08, Math.max(0, (time - lastDrawAt) / 1000 || 0));
    lastDrawAt = time;
    const frame = coverFrame();
    context.clearRect(0, 0, cssWidth, cssHeight);
    context.drawImage(image, frame.x, frame.y, frame.width, frame.height);

    vortices.forEach((vortex, index) => {
      const patch = patches[index];
      if (!patch) return;
      vortex.angle = (vortex.angle + vortex.direction * vortex.speed * deltaSeconds) % (Math.PI * 2);
      const destinationSize = patch.sourceDiameter * frame.scale;
      const destinationX = frame.x + vortex.x * image.naturalWidth * frame.scale;
      const destinationY = frame.y + vortex.y * image.naturalHeight * frame.scale;
      context.save();
      context.translate(destinationX, destinationY);
      context.rotate(vortex.angle);
      context.drawImage(
        patch.canvas,
        -destinationSize / 2,
        -destinationSize / 2,
        destinationSize,
        destinationSize,
      );
      context.restore();
    });

    frameId = requestAnimationFrame(draw);
  };

  const stop = () => {
    if (!frameId) return;
    cancelAnimationFrame(frameId);
    frameId = 0;
  };

  const reconcile = () => {
    if (document.hidden || !intersecting || reducedMotion.matches) {
      stop();
      return;
    }
    if (!frameId && image.naturalWidth) {
      lastDrawAt = performance.now();
      frameId = requestAnimationFrame(draw);
    }
  };

  const resizeObserver = new ResizeObserver(() => {
    resize();
    reconcile();
  });
  const intersectionObserver = new IntersectionObserver(([entry]) => {
    intersecting = entry.isIntersecting;
    reconcile();
  }, { threshold: 0.02 });
  const handleVisibilityChange = () => reconcile();
  const handleMotionChange = () => reconcile();

  image.addEventListener("load", () => {
    if (disposed) return;
    patches = vortices.map(buildPatch);
    resize();
    hero.classList.add("has-vortex-runtime");
    reconcile();
  }, { once: true });
  image.src = new URL("./assets/ppt-ocean-vortex.jpg", document.baseURI).href;
  resizeObserver.observe(canvas);
  intersectionObserver.observe(canvas);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  reducedMotion.addEventListener("change", handleMotionChange);

  window.addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    disposed = true;
    stop();
    resizeObserver.disconnect();
    intersectionObserver.disconnect();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    reducedMotion.removeEventListener("change", handleMotionChange);
  }, { once: true });
})();

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  dataSeam.dispose();
  windSoundscape.dispose();
}, { once: true });
