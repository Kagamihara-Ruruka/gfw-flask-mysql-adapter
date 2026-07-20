const viewport = document.querySelector("[data-member-evolution]");
const track = viewport?.querySelector("[data-member-evolution-track]");
const trackCopy = viewport?.querySelector("[data-member-evolution-copy]");
const stage = viewport?.closest("[data-member-evolution-stage]");

if (
  viewport
  && track instanceof HTMLImageElement
  && trackCopy instanceof HTMLImageElement
  && stage
  && viewport.dataset.evolutionMounted !== "true"
) {
  viewport.dataset.evolutionMounted = "true";

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const cycleDurationMs = 58_000;
  let animationFrame = 0;
  let lastTimestamp = 0;
  let phase = 0;
  let trackHeight = 0;
  let initialized = false;
  let visible = true;
  let disposed = false;

  const paint = () => {
    const offsetPercent = (reducedMotion.matches ? 0.5 : phase) * 100;
    track.style.transform = `translate3d(0, -${offsetPercent}%, 0)`;
    trackCopy.style.transform = `translate3d(0, -${offsetPercent}%, 0)`;
  };

  const shouldAnimate = () => (
    !disposed
    && visible
    && !document.hidden
    && !reducedMotion.matches
    && trackHeight > 0
  );

  const frame = (timestamp) => {
    animationFrame = 0;
    if (!shouldAnimate()) {
      lastTimestamp = 0;
      return;
    }

    if (lastTimestamp > 0) {
      const delta = Math.min(100, timestamp - lastTimestamp);
      phase = (phase - delta / cycleDurationMs + 1) % 1;
    }
    lastTimestamp = timestamp;
    paint();
    animationFrame = requestAnimationFrame(frame);
  };

  const stop = () => {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    lastTimestamp = 0;
  };

  const reconcile = () => {
    if (reducedMotion.matches) {
      stop();
      paint();
      return;
    }
    if (shouldAnimate() && animationFrame === 0) {
      animationFrame = requestAnimationFrame(frame);
    } else if (!shouldAnimate()) {
      stop();
    }
  };

  const measure = () => {
    const stageHeight = stage.getBoundingClientRect().height;
    trackHeight = Math.max(0, track.getBoundingClientRect().height);
    trackCopy.style.top = `${trackHeight}px`;
    if (!initialized && trackHeight > 0) {
      phase = Math.max(0, 1 - stageHeight / trackHeight);
      initialized = true;
    }
    paint();
    reconcile();
  };

  const visibilityObserver = new IntersectionObserver(([entry]) => {
    visible = Boolean(entry?.isIntersecting);
    reconcile();
  }, { threshold: 0.03 });

  const resizeObserver = new ResizeObserver(measure);

  const onVisibilityChange = () => reconcile();
  const onMotionPreferenceChange = () => {
    lastTimestamp = 0;
    measure();
  };
  const onTrackLoad = () => measure();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop();
    visibilityObserver.disconnect();
    resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    reducedMotion.removeEventListener("change", onMotionPreferenceChange);
    track.removeEventListener("load", onTrackLoad);
    viewport.removeAttribute("data-evolution-mounted");
  };

  visibilityObserver.observe(stage);
  resizeObserver.observe(stage);
  resizeObserver.observe(track);
  document.addEventListener("visibilitychange", onVisibilityChange);
  reducedMotion.addEventListener("change", onMotionPreferenceChange);
  track.addEventListener("load", onTrackLoad);
  window.addEventListener("pagehide", dispose, { once: true });

  if (track.complete) measure();
}
