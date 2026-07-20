const noopOwner = Object.freeze({ dispose() {} });

const randomBetween = (range) => {
  const [minimum, maximum] = range;
  return minimum + Math.random() * Math.max(0, maximum - minimum);
};

export const setupAmbientSoundscape = ({
  ownerId,
  source,
  mode = "intermittent",
  volume = 0.1,
  initialDelay = [6000, 12000],
  repeatDelay = [36000, 72000],
  segmentDuration = [8000, 15000],
  fadeDuration = 1800,
}) => {
  if (!ownerId || !source) return noopOwner;

  const ownerAttribute = `data-ambient-soundscape-${ownerId}`;
  const ownerRoot = document.documentElement;
  if (ownerRoot.hasAttribute(ownerAttribute)) return noopOwner;
  ownerRoot.setAttribute(ownerAttribute, "locked");

  const audio = new Audio(source);
  let scheduleTimer = 0;
  let stopTimer = 0;
  let fadeFrame = 0;
  let unlocked = false;
  let unlocking = false;
  let playingSegment = false;
  let disposed = false;

  audio.preload = "metadata";
  audio.loop = mode === "loop";
  audio.volume = 0;

  const setState = (state) => {
    if (!disposed) ownerRoot.setAttribute(ownerAttribute, state);
  };

  const clearTimers = () => {
    window.clearTimeout(scheduleTimer);
    window.clearTimeout(stopTimer);
    scheduleTimer = 0;
    stopTimer = 0;
  };

  const cancelFade = () => {
    if (fadeFrame) cancelAnimationFrame(fadeFrame);
    fadeFrame = 0;
  };

  const fadeTo = (targetVolume, duration, onComplete) => {
    cancelFade();
    const startedAt = performance.now();
    const startVolume = audio.volume;
    const safeDuration = Math.max(1, duration);

    const step = (time) => {
      if (disposed) return;
      const progress = Math.min(1, (time - startedAt) / safeDuration);
      const eased = progress * progress * (3 - 2 * progress);
      audio.volume = startVolume + (targetVolume - startVolume) * eased;
      if (progress < 1) {
        fadeFrame = requestAnimationFrame(step);
        return;
      }
      fadeFrame = 0;
      onComplete?.();
    };

    fadeFrame = requestAnimationFrame(step);
  };

  const pause = () => {
    cancelFade();
    audio.pause();
    audio.volume = 0;
    playingSegment = false;
    setState("paused");
  };

  const addUnlockListeners = () => {
    document.addEventListener("pointerdown", handleFirstInteraction, true);
    document.addEventListener("keydown", handleFirstInteraction, true);
  };

  const requireInteraction = () => {
    unlocked = false;
    setState("locked");
    addUnlockListeners();
  };

  const scheduleSegment = (delay = randomBetween(repeatDelay)) => {
    window.clearTimeout(scheduleTimer);
    scheduleTimer = 0;
    if (disposed || !unlocked || document.hidden || mode !== "intermittent") return;
    setState("scheduled");
    scheduleTimer = window.setTimeout(() => {
      scheduleTimer = 0;
      playSegment();
    }, delay);
  };

  const finishSegment = () => {
    if (!playingSegment) return;
    playingSegment = false;
    window.clearTimeout(stopTimer);
    stopTimer = 0;
    setState("fading");
    fadeTo(0, fadeDuration, () => {
      audio.pause();
      scheduleSegment();
    });
  };

  const playSegment = async () => {
    if (disposed || !unlocked || document.hidden || playingSegment) return;
    const durationMs = randomBetween(segmentDuration);
    const sourceDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (sourceDuration > durationMs / 1000 + 2) {
      audio.currentTime = Math.random() * (sourceDuration - durationMs / 1000 - 1);
    } else {
      audio.currentTime = 0;
    }
    audio.loop = false;
    audio.volume = 0;
    playingSegment = true;
    setState("starting");
    try {
      await audio.play();
      setState("playing");
      fadeTo(volume, fadeDuration);
      stopTimer = window.setTimeout(finishSegment, Math.max(fadeDuration * 2, durationMs - fadeDuration));
    } catch {
      playingSegment = false;
      requireInteraction();
    }
  };

  const startLoop = async () => {
    if (disposed || !unlocked || document.hidden || mode !== "loop") return;
    audio.loop = true;
    audio.volume = 0;
    setState("starting");
    try {
      await audio.play();
      setState("playing");
      fadeTo(volume, fadeDuration);
    } catch {
      requireInteraction();
    }
  };

  const removeUnlockListeners = () => {
    document.removeEventListener("pointerdown", handleFirstInteraction, true);
    document.removeEventListener("keydown", handleFirstInteraction, true);
  };

  const unlock = async () => {
    if (disposed || unlocked || unlocking) return;
    unlocking = true;
    setState("unlocking");
    const previousMuted = audio.muted;
    audio.muted = true;
    try {
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
      unlocked = true;
      setState("ready");
      removeUnlockListeners();
      if (mode === "loop") startLoop();
      else scheduleSegment(randomBetween(initialDelay));
    } catch {
      requireInteraction();
    } finally {
      audio.muted = previousMuted;
      unlocking = false;
    }
  };

  function handleFirstInteraction() {
    unlock();
  }

  const handleVisibilityChange = () => {
    clearTimers();
    if (document.hidden) {
      pause();
      return;
    }
    if (!unlocked) return;
    if (mode === "loop") startLoop();
    else scheduleSegment(randomBetween(initialDelay));
  };

  const handleEnded = () => {
    if (mode === "intermittent") finishSegment();
  };

  audio.addEventListener("ended", handleEnded);
  addUnlockListeners();
  document.addEventListener("visibilitychange", handleVisibilityChange);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimers();
      pause();
      audio.removeEventListener("ended", handleEnded);
      removeUnlockListeners();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      audio.removeAttribute("src");
      audio.load();
      ownerRoot.removeAttribute(ownerAttribute);
    },
  };
};
