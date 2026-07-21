import { setupImageHeroSeam } from "./hero-seam-sampler.js";
import { setupAmbientSoundscape } from "./assets/ambient-soundscape.js?v=1";

const hero = document.querySelector(".product-platform-hero");
const canvas = hero?.querySelector("[data-lighthouse-beacon]");
const skyCanvas = hero?.querySelector("[data-lighthouse-sky]");
const lighthousePhoto = hero?.querySelector("[data-lighthouse-photo]");
const lighthouseImage = new URL("./assets/product-lighthouse-janus-y.jpg", import.meta.url);

const seaSoundscape = setupAmbientSoundscape({
  ownerId: "product-waves",
  source: new URL("./assets/product-sea-surface-ambience.ogg", import.meta.url),
  mode: "loop",
  volume: 0.08,
  fadeDuration: 2600,
});

const BRIGHT_STARS = Object.freeze([
  ["Sirius", 6.7525, -16.7161, -1.46],
  ["Canopus", 6.3992, -52.6957, -0.74],
  ["Arcturus", 14.261, 19.1824, -0.05],
  ["Vega", 18.6156, 38.7837, 0.03],
  ["Capella", 5.2782, 45.998, 0.08],
  ["Rigel", 5.2423, -8.2016, 0.13],
  ["Procyon", 7.655, 5.225, 0.34],
  ["Betelgeuse", 5.9195, 7.4071, 0.42],
  ["Achernar", 1.6286, -57.2368, 0.46],
  ["Hadar", 14.0637, -60.373, 0.61],
  ["Altair", 19.8464, 8.8683, 0.76],
  ["Acrux", 12.4433, -63.0991, 0.76],
  ["Aldebaran", 4.5987, 16.5093, 0.86],
  ["Antares", 16.4901, -26.432, 0.91],
  ["Spica", 13.4199, -11.1613, 0.97],
  ["Pollux", 7.7553, 28.0262, 1.14],
  ["Fomalhaut", 22.9608, -29.6222, 1.16],
  ["Deneb", 20.6905, 45.2803, 1.25],
  ["Regulus", 10.1395, 11.9672, 1.35],
  ["Adhara", 6.9771, -28.9721, 1.5],
  ["Castor", 7.5767, 31.8883, 1.58],
  ["Bellatrix", 5.4189, 6.3497, 1.64],
  ["Elnath", 5.4382, 28.6075, 1.65],
  ["Alnilam", 5.6036, -1.2019, 1.69],
  ["Alnitak", 5.6793, -1.9426, 1.74],
  ["Alioth", 12.9005, 55.9598, 1.76],
  ["Dubhe", 11.0621, 61.7508, 1.79],
  ["Mirfak", 3.4054, 49.8612, 1.79],
  ["Wezen", 7.1399, -26.3932, 1.83],
  ["Alkaid", 13.7923, 49.3133, 1.86],
  ["Menkalinan", 5.9921, 44.9474, 1.9],
  ["Alhena", 6.6285, 16.3993, 1.93],
  ["Polaris", 2.5303, 89.2641, 1.98],
  ["Mirzam", 6.3783, -17.9559, 1.98],
  ["Hamal", 2.1195, 23.4624, 2],
  ["Algieba", 10.3329, 19.8415, 2.01],
  ["Alpheratz", 0.1398, 29.0904, 2.06],
  ["Saiph", 5.7959, -9.6696, 2.06],
  ["Rasalhague", 17.5822, 12.56, 2.08],
  ["Kochab", 14.8451, 74.1555, 2.08],
  ["Algol", 3.1361, 40.9556, 2.12],
  ["Denebola", 11.8177, 14.5721, 2.14],
  ["Alphecca", 15.5781, 26.7147, 2.23],
  ["Eltanin", 17.9434, 51.4889, 2.24],
  ["Schedar", 0.6751, 56.5373, 2.24],
  ["Caph", 0.1529, 59.1498, 2.28],
  ["Merak", 11.0307, 56.3824, 2.37],
  ["Phecda", 11.8972, 53.6948, 2.44],
  ["Megrez", 12.257, 57.0326, 3.31],
]);

const radians = (degrees) => degrees * Math.PI / 180;
const normalizeDegrees = (degrees) => ((degrees % 360) + 360) % 360;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

const horizontalCoordinates = ({ rightAscension, declination, latitude, longitude, timestamp }) => {
  const julianDate = timestamp / 86400000 + 2440587.5;
  const centuries = (julianDate - 2451545) / 36525;
  const siderealDegrees = normalizeDegrees(
    280.46061837
      + 360.98564736629 * (julianDate - 2451545)
      + 0.000387933 * centuries * centuries
      - centuries * centuries * centuries / 38710000
      + longitude,
  );
  const hourAngle = radians(normalizeDegrees(siderealDegrees - rightAscension * 15));
  const declinationRadians = radians(declination);
  const latitudeRadians = radians(latitude);
  const altitude = Math.asin(
    Math.sin(declinationRadians) * Math.sin(latitudeRadians)
      + Math.cos(declinationRadians) * Math.cos(latitudeRadians) * Math.cos(hourAngle),
  );
  const azimuth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(latitudeRadians)
      - Math.tan(declinationRadians) * Math.cos(latitudeRadians),
  ) + Math.PI;
  return { altitude, azimuth };
};

const projectDirection = ({ altitude, azimuth, heading, pitch, horizontalFov, verticalFov }) => {
  const cosAltitude = Math.cos(altitude);
  const direction = [
    cosAltitude * Math.sin(azimuth),
    Math.sin(altitude),
    cosAltitude * Math.cos(azimuth),
  ];
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const forward = [cosPitch * Math.sin(heading), sinPitch, cosPitch * Math.cos(heading)];
  const right = [Math.cos(heading), 0, -Math.sin(heading)];
  const up = [-sinPitch * Math.sin(heading), cosPitch, -sinPitch * Math.cos(heading)];
  const dot = (left, rightVector) => left[0] * rightVector[0] + left[1] * rightVector[1] + left[2] * rightVector[2];
  const depth = dot(direction, forward);
  if (depth <= 0) return null;
  const planeX = dot(direction, right) / depth;
  const planeY = dot(direction, up) / depth;
  const normalizedX = planeX / Math.tan(horizontalFov / 2);
  const normalizedY = planeY / Math.tan(verticalFov / 2);
  if (Math.abs(normalizedX) > 1 || Math.abs(normalizedY) > 1) return null;
  return { x: (normalizedX + 1) / 2, y: (1 - normalizedY) / 2 };
};

const stableUnit = (text) => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
};

const objectPositionOffset = (token, freeSpace) => {
  if (!token?.endsWith("%")) return freeSpace / 2;
  return freeSpace * Number.parseFloat(token) / 100;
};

const lighthouseAnchor = () => {
  if (!hero || !lighthousePhoto || !lighthousePhoto.naturalWidth || !lighthousePhoto.naturalHeight) {
    const bounds = hero?.getBoundingClientRect();
    return { x: (bounds?.width || 1) * 0.64, y: (bounds?.height || 1) * 0.49 };
  }
  const heroBounds = hero.getBoundingClientRect();
  const photoBounds = lighthousePhoto.getBoundingClientRect();
  const style = getComputedStyle(lighthousePhoto);
  const objectFit = style.objectFit || "fill";
  const naturalWidth = lighthousePhoto.naturalWidth;
  const naturalHeight = lighthousePhoto.naturalHeight;
  const scale = objectFit === "contain"
    ? Math.min(photoBounds.width / naturalWidth, photoBounds.height / naturalHeight)
    : Math.max(photoBounds.width / naturalWidth, photoBounds.height / naturalHeight);
  const renderedWidth = naturalWidth * scale;
  const renderedHeight = naturalHeight * scale;
  const [positionX = "50%", positionY = "50%"] = style.objectPosition.split(/\s+/);
  const offsetX = objectPositionOffset(positionX, photoBounds.width - renderedWidth);
  const offsetY = objectPositionOffset(positionY, photoBounds.height - renderedHeight);
  const sourceX = clamp(Number.parseFloat(hero.dataset.lensX), 0, 1);
  const sourceY = clamp(Number.parseFloat(hero.dataset.lensY), 0, 1);
  return {
    x: photoBounds.left - heroBounds.left + offsetX + sourceX * renderedWidth,
    y: photoBounds.top - heroBounds.top + offsetY + sourceY * renderedHeight,
  };
};
const productSeam = setupImageHeroSeam({
  target: document.body,
  imageUrl: lighthouseImage,
  sampleBand: [0.48, 0.84],
  toneProperty: "--product-tone",
  seamProperty: "--product-seam-gradient",
  toneOptions: { base: [3, 7, 10], scale: [0.07, 0.095, 0.12] },
});

const sky = (() => {
  if (!hero || !skyCanvas) return { dispose() {} };
  const context = skyCanvas.getContext("2d");
  if (!context) return { dispose() {} };

  const latitude = Number.parseFloat(hero.dataset.skyLatitude);
  const longitude = Number.parseFloat(hero.dataset.skyLongitude);
  const timestamp = Date.parse(hero.dataset.skyTime || "");
  const heading = radians(Number.parseFloat(hero.dataset.cameraAzimuth) || 270);
  const pitch = radians(Number.parseFloat(hero.dataset.cameraPitch) || 27);
  if (![latitude, longitude, timestamp].every(Number.isFinite)) return { dispose() {} };

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let width = 1;
  let height = 1;
  let ratio = 1;
  let frameId = 0;
  let lastPaint = 0;
  let intersecting = true;
  let disposed = false;
  let visibleStars = [];

  const rebuildProjection = () => {
    const horizontalFov = radians(width < 720 ? 98 : 86);
    const verticalFov = radians(width < 720 ? 68 : 58);
    const anchor = lighthouseAnchor();
    const lensX = anchor.x / width;
    const lensY = anchor.y / height;
    visibleStars = BRIGHT_STARS.flatMap(([name, rightAscension, declination, magnitude]) => {
      const coordinates = horizontalCoordinates({
        rightAscension,
        declination,
        latitude,
        longitude,
        timestamp,
      });
      if (coordinates.altitude <= radians(-1.5)) return [];
      const projected = projectDirection({
        ...coordinates,
        heading,
        pitch,
        horizontalFov,
        verticalFov,
      });
      if (!projected || projected.y > 0.87) return [];

      const towerOcclusion = projected.y > lensY - 0.09
        && Math.abs(projected.x - lensX) < 0.18 + Math.max(0, projected.y - lensY) * 0.38;
      if (towerOcclusion) return [];

      const brightness = clamp(10 ** (-0.2 * (magnitude + 1.46)), 0.08, 1);
      return [{
        name,
        x: projected.x * width,
        y: projected.y * height,
        radius: 0.55 + Math.sqrt(brightness) * 1.45,
        opacity: 0.17 + brightness * 0.48,
        phase: stableUnit(`${name}:phase`) * Math.PI * 2,
        frequency: 0.00045 + stableUnit(`${name}:frequency`) * 0.00072,
      }];
    });
  };

  const resize = () => {
    const bounds = hero.getBoundingClientRect();
    ratio = Math.min(window.devicePixelRatio || 1, 1.75);
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    skyCanvas.width = Math.round(width * ratio);
    skyCanvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    rebuildProjection();
  };

  const schedule = () => {
    if (!disposed && intersecting && !document.hidden && !reducedMotion.matches) {
      frameId = requestAnimationFrame(draw);
    }
  };

  const draw = (paintTime = 0) => {
    if (!reducedMotion.matches && paintTime - lastPaint < 48) {
      schedule();
      return;
    }
    lastPaint = paintTime;
    context.clearRect(0, 0, width, height);
    context.save();
    context.globalCompositeOperation = "lighter";
    visibleStars.forEach((star) => {
      const twinkle = reducedMotion.matches ? 0.94 : 0.9 + Math.sin(paintTime * star.frequency + star.phase) * 0.1;
      const alpha = star.opacity * twinkle;
      if (star.radius > 1.35) {
        const halo = context.createRadialGradient(star.x, star.y, 0, star.x, star.y, star.radius * 4.2);
        halo.addColorStop(0, `rgba(220, 241, 255, ${alpha * 0.42})`);
        halo.addColorStop(1, "rgba(176, 218, 244, 0)");
        context.fillStyle = halo;
        context.beginPath();
        context.arc(star.x, star.y, star.radius * 4.2, 0, Math.PI * 2);
        context.fill();
      }
      context.fillStyle = `rgba(236, 247, 255, ${alpha})`;
      context.beginPath();
      context.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
      context.fill();
    });
    context.restore();
    schedule();
  };

  const start = () => {
    cancelAnimationFrame(frameId);
    draw(performance.now());
  };
  const resizeObserver = new ResizeObserver(() => {
    resize();
    start();
  });
  const intersectionObserver = new IntersectionObserver(([entry]) => {
    intersecting = entry.isIntersecting;
    if (intersecting) start();
    else cancelAnimationFrame(frameId);
  }, { threshold: 0.04 });
  const onVisibilityChange = () => {
    if (!document.hidden && intersecting) start();
    else cancelAnimationFrame(frameId);
  };
  const onPhotoLoad = () => {
    resize();
    start();
  };

  resize();
  resizeObserver.observe(hero);
  intersectionObserver.observe(hero);
  document.addEventListener("visibilitychange", onVisibilityChange);
  reducedMotion.addEventListener("change", start);
  lighthousePhoto?.addEventListener("load", onPhotoLoad);
  start();

  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      reducedMotion.removeEventListener("change", start);
      lighthousePhoto?.removeEventListener("load", onPhotoLoad);
    },
  };
})();

const beacon = (() => {
  if (!hero || !canvas) return { dispose() {} };
  const context = canvas.getContext("2d");
  if (!context) return { dispose() {} };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let width = 1;
  let height = 1;
  let ratio = 1;
  let frameId = 0;
  let intersecting = true;
  let disposed = false;

  const resize = () => {
    const bounds = hero.getBoundingClientRect();
    ratio = Math.min(window.devicePixelRatio || 1, 1.75);
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  const beamPath = (startX, startY, endX, endY, halfWidth) => {
    const length = Math.max(1, Math.hypot(endX - startX, endY - startY));
    const perpendicularX = -(endY - startY) / length;
    const perpendicularY = (endX - startX) / length;
    context.beginPath();
    context.moveTo(startX, startY);
    context.lineTo(endX + perpendicularX * halfWidth, endY + perpendicularY * halfWidth);
    context.lineTo(endX - perpendicularX * halfWidth, endY - perpendicularY * halfWidth);
    context.closePath();
  };

  const draw = (timestamp = 0) => {
    context.clearRect(0, 0, width, height);
    const { x: lensX, y: lensY } = lighthouseAnchor();
    const phase = reducedMotion.matches ? 0.18 : (timestamp % 11800) / 11800 * Math.PI * 2;
    const projection = Math.cos(phase);
    const depth = Math.sin(phase);
    const visibility = Math.abs(projection) ** 0.72;
    const direction = projection < 0 ? -1 : 1;
    const beamLength = width * (0.08 + visibility * 0.76);
    const endX = lensX + direction * beamLength;
    const endY = lensY - depth * height * 0.022;

    context.save();
    context.globalCompositeOperation = "lighter";
    const outerGradient = context.createLinearGradient(lensX, lensY, endX, endY);
    outerGradient.addColorStop(0, `rgba(255, 244, 201, ${0.15 + visibility * 0.1})`);
    outerGradient.addColorStop(0.2, `rgba(233, 244, 229, ${0.08 + visibility * 0.08})`);
    outerGradient.addColorStop(0.7, `rgba(179, 218, 224, ${0.025 + visibility * 0.035})`);
    outerGradient.addColorStop(1, "rgba(156, 205, 218, 0)");
    context.fillStyle = outerGradient;
    beamPath(lensX, lensY, endX, endY, height * (0.055 + visibility * 0.09));
    context.filter = `blur(${14 + visibility * 18}px)`;
    context.fill();

    const coreGradient = context.createLinearGradient(lensX, lensY, endX, endY);
    coreGradient.addColorStop(0, `rgba(255, 252, 224, ${0.3 + visibility * 0.15})`);
    coreGradient.addColorStop(0.34, `rgba(232, 246, 239, ${0.08 + visibility * 0.09})`);
    coreGradient.addColorStop(1, "rgba(200, 231, 234, 0)");
    context.filter = `blur(${5 + visibility * 7}px)`;
    context.fillStyle = coreGradient;
    beamPath(lensX, lensY, endX, endY, height * (0.014 + visibility * 0.03));
    context.fill();
    context.restore();

    const flareStrength = 0.16 + (1 - visibility) * 0.32;
    const flare = context.createRadialGradient(lensX, lensY, 0, lensX, lensY, height * 0.042);
    flare.addColorStop(0, `rgba(255, 252, 218, ${flareStrength})`);
    flare.addColorStop(0.2, `rgba(255, 232, 169, ${flareStrength * 0.36})`);
    flare.addColorStop(1, "rgba(255, 222, 154, 0)");
    context.fillStyle = flare;
    context.beginPath();
    context.arc(lensX, lensY, height * 0.042, 0, Math.PI * 2);
    context.fill();

    if (!disposed && intersecting && !document.hidden && !reducedMotion.matches) {
      frameId = requestAnimationFrame(draw);
    }
  };

  const start = () => {
    cancelAnimationFrame(frameId);
    draw(performance.now());
  };
  const resizeObserver = new ResizeObserver(() => {
    resize();
    start();
  });
  const intersectionObserver = new IntersectionObserver(([entry]) => {
    intersecting = entry.isIntersecting;
    if (intersecting) start();
    else cancelAnimationFrame(frameId);
  }, { threshold: 0.04 });
  const onVisibilityChange = () => {
    if (!document.hidden && intersecting) start();
    else cancelAnimationFrame(frameId);
  };
  const onPhotoLoad = () => {
    resize();
    start();
  };

  resize();
  resizeObserver.observe(hero);
  intersectionObserver.observe(hero);
  document.addEventListener("visibilitychange", onVisibilityChange);
  reducedMotion.addEventListener("change", start);
  lighthousePhoto?.addEventListener("load", onPhotoLoad);
  start();

  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      reducedMotion.removeEventListener("change", start);
      lighthousePhoto?.removeEventListener("load", onPhotoLoad);
    },
  };
})();

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  productSeam.dispose();
  sky.dispose();
  beacon.dispose();
  seaSoundscape.dispose();
}, { once: true });
