const srgbToLinear = (channel) => {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
};

const linearToSrgb = (channel) => {
  const normalized = channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, normalized * 255));
};

export const toneFromSamples = (
  samples,
  { base = [2, 5, 8], scale = [0.09, 0.11, 0.13] } = {},
) => {
  if (!samples.length) return [...base];
  const luminances = samples.map(({ luminance }) => luminance).sort((left, right) => left - right);
  const highPercentile = luminances[Math.floor((luminances.length - 1) * 0.92)];
  const highlightLimit = Math.min(242, highPercentile * 1.12 + 8);
  let red = 0;
  let green = 0;
  let blue = 0;
  let totalWeight = 0;

  samples.forEach((sample) => {
    if (sample.luminance < 3 || sample.luminance > highlightLimit) return;
    const weight = sample.weight ?? 1;
    red += srgbToLinear(sample.red) * weight;
    green += srgbToLinear(sample.green) * weight;
    blue += srgbToLinear(sample.blue) * weight;
    totalWeight += weight;
  });

  if (!totalWeight) return [...base];
  const average = [
    linearToSrgb(red / totalWeight),
    linearToSrgb(green / totalWeight),
    linearToSrgb(blue / totalWeight),
  ];
  return average.map((channel, index) => Math.round(base[index] + channel * scale[index]));
};

export const applyHeroSeamPalette = (
  target,
  segments,
  { toneProperty = "--hero-tone", seamProperty = "--hero-seam-gradient" } = {},
) => {
  if (!target || !segments.length) return;
  const tone = segments.reduce(
    (sum, segment) => sum.map((value, index) => value + segment[index] / segments.length),
    [0, 0, 0],
  ).map(Math.round);
  const stops = segments.map(
    (segment, index) => `rgb(${segment.join(" ")}) ${(index / Math.max(1, segments.length - 1)) * 100}%`,
  );
  target.style.setProperty(toneProperty, tone.join(" "));
  target.style.setProperty(seamProperty, `linear-gradient(90deg, ${stops.join(", ")})`);
  target.classList.add("has-hero-seam-palette");
};

export const setupImageHeroSeam = ({
  target = document.body,
  imageUrl,
  segmentCount = 8,
  sampleBand = [0.54, 0.84],
  toneProperty,
  seamProperty,
  toneOptions,
}) => {
  const image = new Image();
  const sampler = document.createElement("canvas");
  sampler.width = segmentCount * 24;
  sampler.height = 96;
  const context = sampler.getContext("2d", { willReadFrequently: true });
  let disposed = false;

  const sample = () => {
    if (disposed || !context || !image.naturalWidth) return;
    context.clearRect(0, 0, sampler.width, sampler.height);
    context.drawImage(image, 0, 0, sampler.width, sampler.height);
    const pixels = context.getImageData(0, 0, sampler.width, sampler.height).data;
    const startY = Math.floor(sampleBand[0] * sampler.height);
    const endY = Math.ceil(sampleBand[1] * sampler.height);
    const segments = Array.from({ length: segmentCount }, (_, segmentIndex) => {
      const startX = Math.floor((segmentIndex / segmentCount) * sampler.width);
      const endX = Math.ceil(((segmentIndex + 1) / segmentCount) * sampler.width);
      const samples = [];
      for (let y = startY; y < endY; y += 1) {
        const vertical = (y - startY) / Math.max(1, endY - startY - 1);
        const weight = 0.7 + Math.sin(vertical * Math.PI) * 0.55;
        for (let x = startX; x < endX; x += 1) {
          const index = (y * sampler.width + x) * 4;
          const red = pixels[index];
          const green = pixels[index + 1];
          const blue = pixels[index + 2];
          samples.push({
            red,
            green,
            blue,
            luminance: red * 0.2126 + green * 0.7152 + blue * 0.0722,
            weight,
          });
        }
      }
      return toneFromSamples(samples, toneOptions);
    });
    applyHeroSeamPalette(target, segments, { toneProperty, seamProperty });
  };

  image.addEventListener("load", sample, { once: true });
  image.src = String(imageUrl);

  return {
    dispose() {
      disposed = true;
      image.src = "";
    },
  };
};
