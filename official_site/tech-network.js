import * as THREE from "three";
import { GLTFLoader } from "./assets/vendor/GLTFLoader.js";
import { setupImageHeroSeam } from "./hero-seam-sampler.js";

const setupTabs = () => {
  const root = document.querySelector("[data-tech-tabs]");
  if (!root) return;

  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute("aria-controls")));

  const activate = (index, shouldFocus = false) => {
    tabs.forEach((tab, tabIndex) => {
      const active = tabIndex === index;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (panels[tabIndex]) panels[tabIndex].hidden = !active;
    });
    if (shouldFocus) tabs[index]?.focus();
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(index));
    tab.addEventListener("keydown", (event) => {
      let nextIndex = index;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      else return;
      event.preventDefault();
      activate(nextIndex, true);
    });
  });
};

const setupMissionAudio = (transmitter, interactionState) => {
  if (!transmitter) return { dispose() {} };

  const signal = new Audio(new URL("./assets/sputnik-beep-nasa.ogg", import.meta.url));
  const voice = new Audio(new URL("./assets/vostok1-gagarin-mission-radio-10s.mp3", import.meta.url));
  const status = transmitter.querySelector("[data-sputnik-audio-status]");
  const initialDelay = () => 9000 + Math.random() * 7000;
  const repeatDelay = () => 42000 + Math.random() * 36000;
  let signalTimer = 0;
  let disposed = false;
  let signalUnlocked = false;

  signal.preload = "auto";
  signal.volume = 0.16;
  voice.preload = "auto";
  voice.volume = 0.82;

  const clearSignalTimer = () => {
    if (signalTimer) window.clearTimeout(signalTimer);
    signalTimer = 0;
  };

  const scheduleSignal = (delay = repeatDelay()) => {
    clearSignalTimer();
    if (disposed || document.hidden) return;
    signalTimer = window.setTimeout(() => {
      signalTimer = 0;
      if (disposed || document.hidden || !voice.paused) {
        scheduleSignal();
        return;
      }
      signal.currentTime = 0;
      signal.play().catch(() => {
        signalUnlocked = false;
      });
    }, delay);
  };

  const unlockSignal = async () => {
    if (signalUnlocked || disposed) return;
    const volume = signal.volume;
    signal.volume = 0;
    try {
      await signal.play();
      signal.pause();
      signal.currentTime = 0;
      signalUnlocked = true;
    } catch {
      signalUnlocked = false;
    } finally {
      signal.volume = volume;
    }
  };

  const handleFirstInteraction = () => {
    unlockSignal();
    document.removeEventListener("pointerdown", handleFirstInteraction, true);
    document.removeEventListener("keydown", handleFirstInteraction, true);
  };

  const playMissionVoice = async () => {
    if (performance.now() - interactionState.lastDragEndedAt < 320) return;
    clearSignalTimer();
    signal.pause();
    signal.currentTime = 0;
    voice.pause();
    voice.currentTime = 0;
    transmitter.setAttribute("aria-label", "Vostok 1 真實任務通訊播放中");
    transmitter.setAttribute("aria-busy", "true");
    if (status) status.textContent = "Vostok 1 任務通訊播放中";
    try {
      await voice.play();
    } catch {
      transmitter.setAttribute("aria-label", "播放 Vostok 1 真實任務通訊；拖曳可翻轉 Sputnik 1");
      transmitter.removeAttribute("aria-busy");
      if (status) status.textContent = "無法播放 Vostok 1 任務通訊";
      scheduleSignal();
    }
  };

  const finishMissionVoice = () => {
    transmitter.setAttribute("aria-label", "播放 Vostok 1 真實任務通訊；拖曳可翻轉 Sputnik 1");
    transmitter.removeAttribute("aria-busy");
    if (status) status.textContent = "Vostok 1 任務通訊播放完畢";
    scheduleSignal();
  };

  const handleSignalEnded = () => scheduleSignal();
  const handleVisibilityChange = () => {
    if (document.hidden) {
      clearSignalTimer();
      signal.pause();
      return;
    }
    scheduleSignal(initialDelay());
  };

  signal.addEventListener("ended", handleSignalEnded);
  voice.addEventListener("ended", finishMissionVoice);
  transmitter.addEventListener("click", playMissionVoice);
  document.addEventListener("pointerdown", handleFirstInteraction, true);
  document.addEventListener("keydown", handleFirstInteraction, true);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  scheduleSignal(initialDelay());

  return {
    dispose() {
      disposed = true;
      clearSignalTimer();
      signal.pause();
      voice.pause();
      signal.removeEventListener("ended", handleSignalEnded);
      voice.removeEventListener("ended", finishMissionVoice);
      transmitter.removeEventListener("click", playMissionVoice);
      document.removeEventListener("pointerdown", handleFirstInteraction, true);
      document.removeEventListener("keydown", handleFirstInteraction, true);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    },
  };
};

const setupSputnikModel = (transmitter, interactionState) => {
  const canvas = transmitter?.querySelector("[data-sputnik-scene]");
  if (!transmitter || !canvas) return { dispose() {} };

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch {
    transmitter.classList.add("has-model-error");
    transmitter.setAttribute("aria-label", "Sputnik 1 模型無法載入");
    return { dispose() {} };
  }

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  const pivot = new THREE.Group();
  const loader = new GLTFLoader();
  let modelReady = false;
  let disposed = false;
  let dragPointerId = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragX = 0;
  let dragY = 0;
  let didDrag = false;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.22;
  camera.position.set(0, 0, 8);
  camera.lookAt(0, 0, 0);
  scene.add(pivot);
  scene.add(new THREE.HemisphereLight(0xe8f7ff, 0x051018, 1.8));

  const keyLight = new THREE.DirectionalLight(0xffffff, 4.4);
  keyLight.position.set(4, 5, 8);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x57dff8, 3.2);
  rimLight.position.set(-5, 1, -4);
  scene.add(rimLight);
  const earthLight = new THREE.PointLight(0x9dffdc, 16, 24);
  earthLight.position.set(2, -4, 5);
  scene.add(earthLight);

  const fitAndRender = () => {
    if (disposed) return;
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    const aspect = width / height;
    renderer.setSize(width, height, false);
    camera.left = -aspect;
    camera.right = aspect;
    camera.top = 1;
    camera.bottom = -1;
    camera.updateProjectionMatrix();

    if (modelReady) {
      pivot.position.set(0, 0, 0);
      pivot.scale.setScalar(1);
      pivot.updateWorldMatrix(true, true);
      const modelBounds = new THREE.Box3().setFromObject(pivot);
      const size = modelBounds.getSize(new THREE.Vector3());
      const center = modelBounds.getCenter(new THREE.Vector3());
      const fitScale = Math.min((aspect * 1.86) / Math.max(size.x, 0.001), 1.86 / Math.max(size.y, 0.001));
      pivot.scale.setScalar(fitScale);
      pivot.position.set(-center.x * fitScale, -center.y * fitScale, -center.z * fitScale);
      pivot.updateWorldMatrix(true, true);
    }
    renderer.render(scene, camera);
  };

  loader.load(
    new URL("./assets/sputnik-1/scene.gltf", import.meta.url).href,
    (gltf) => {
      if (disposed) return;
      const model = gltf.scene;
      model.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        child.frustumCulled = false;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => {
          if ("metalness" in material) material.metalness = Math.max(material.metalness ?? 0, 0.7);
          if ("roughness" in material) material.roughness = Math.min(material.roughness ?? 1, 0.28);
          material.needsUpdate = true;
        });
      });
      pivot.add(model);
      pivot.rotation.set(-0.34, -0.92, 0.2);
      modelReady = true;
      transmitter.classList.add("is-ready");
      fitAndRender();
    },
    undefined,
    () => {
      transmitter.classList.add("has-model-error");
      transmitter.setAttribute("aria-label", "Sputnik 1 模型無法載入");
    },
  );

  const resizeObserver = new ResizeObserver(fitAndRender);
  resizeObserver.observe(canvas);

  const finishDrag = (event) => {
    if (dragPointerId !== event.pointerId) return;
    if (didDrag) interactionState.lastDragEndedAt = performance.now();
    transmitter.classList.remove("is-dragging");
    if (transmitter.hasPointerCapture(event.pointerId)) transmitter.releasePointerCapture(event.pointerId);
    dragPointerId = null;
    didDrag = false;
  };

  const handlePointerDown = (event) => {
    if (!modelReady || dragPointerId !== null) return;
    dragPointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragX = event.clientX;
    dragY = event.clientY;
    didDrag = false;
    transmitter.setPointerCapture(event.pointerId);
    transmitter.classList.add("is-dragging");
  };

  const handlePointerMove = (event) => {
    if (!modelReady || dragPointerId !== event.pointerId) return;
    const deltaX = event.clientX - dragX;
    const deltaY = event.clientY - dragY;
    dragX = event.clientX;
    dragY = event.clientY;
    if (!didDrag && Math.hypot(event.clientX - dragStartX, event.clientY - dragStartY) < 10) return;
    didDrag = true;
    pivot.rotation.y += deltaX * 0.008;
    pivot.rotation.x += deltaY * 0.008;
    fitAndRender();
    event.preventDefault();
  };

  transmitter.addEventListener("pointerdown", handlePointerDown);
  transmitter.addEventListener("pointermove", handlePointerMove);
  transmitter.addEventListener("pointerup", finishDrag);
  transmitter.addEventListener("pointercancel", finishDrag);
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    transmitter.classList.add("has-model-error");
  });
  canvas.addEventListener("webglcontextrestored", () => {
    transmitter.classList.remove("has-model-error");
    fitAndRender();
  });
  fitAndRender();

  return {
    dispose() {
      disposed = true;
      resizeObserver.disconnect();
      transmitter.removeEventListener("pointerdown", handlePointerDown);
      transmitter.removeEventListener("pointermove", handlePointerMove);
      transmitter.removeEventListener("pointerup", finishDrag);
      transmitter.removeEventListener("pointercancel", finishDrag);
      pivot.traverse((child) => {
        if (!child.isMesh) return;
        child.geometry?.dispose?.();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => material?.dispose?.());
      });
      renderer.dispose();
    },
  };
};

setupTabs();
const pageTone = setupImageHeroSeam({
  target: document.body,
  imageUrl: new URL("./assets/tech-earth-limb-nasa-iss.jpg", import.meta.url),
  toneProperty: "--tech-tone",
  seamProperty: "--tech-seam-gradient",
});
const transmitter = document.querySelector("[data-sputnik-transmitter]");
const interactionState = { lastDragEndedAt: Number.NEGATIVE_INFINITY };
const missionAudio = setupMissionAudio(transmitter, interactionState);
const sputnikModel = setupSputnikModel(transmitter, interactionState);

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  pageTone.dispose();
  missionAudio.dispose();
  sputnikModel.dispose();
}, { once: true });
