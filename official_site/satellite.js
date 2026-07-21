import * as THREE from "three";
import { DRACOLoader } from "./assets/vendor/DRACOLoader.js";
import { GLTFLoader } from "./assets/vendor/GLTFLoader.js";

const mount = document.querySelector("[data-satellite-scene]");

if (mount) {
  const BASE_CAMERA_DISTANCE = 7.4;
  const CAMERA_Y = 0.25;
  const FRAME_USAGE = 0.985;
  const MODEL_SPAN = 5.8;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, CAMERA_Y, BASE_CAMERA_DISTANCE);

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.22;
  mount.append(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xbfdcff, 0x07101a, 2.8));
  const keyLight = new THREE.DirectionalLight(0xffffff, 4.2);
  keyLight.position.set(4, 5, 7);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0x41dfff, 3.4);
  rimLight.position.set(-6, 1, -2);
  scene.add(rimLight);

  const satelliteRoot = new THREE.Group();
  const attitudeRoot = new THREE.Group();
  attitudeRoot.rotation.set(-0.15, -0.48, -0.08);
  satelliteRoot.add(attitudeRoot);
  scene.add(satelliteRoot);

  let satellite = null;
  let dragActive = false;
  let previousX = 0;
  let previousY = 0;
  let targetPitch = attitudeRoot.rotation.x;
  let targetYaw = satelliteRoot.rotation.y;
  let modelCorners = [];
  const projectedCorner = new THREE.Vector3();

  const collectModelCorners = () => {
    const corners = [];
    const worldToAttitude = attitudeRoot.matrixWorld.clone().invert();

    satellite.traverse((node) => {
      if (!node.isMesh || !node.geometry) return;
      node.geometry.computeBoundingBox();
      const box = node.geometry.boundingBox;
      if (!box || box.isEmpty()) return;

      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            corners.push(
              new THREE.Vector3(x, y, z)
                .applyMatrix4(node.matrixWorld)
                .applyMatrix4(worldToAttitude),
            );
          }
        }
      }
    });

    return corners;
  };

  const requiredCameraDistance = () => {
    if (modelCorners.length === 0) return BASE_CAMERA_DISTANCE;

    const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
    const horizontalSlope = Math.tan(horizontalHalfFov) * FRAME_USAGE;
    const verticalSlope = Math.tan(verticalHalfFov) * FRAME_USAGE;
    let distance = BASE_CAMERA_DISTANCE;

    satelliteRoot.updateMatrixWorld(true);
    for (const corner of modelCorners) {
      const worldCorner = projectedCorner.copy(corner).applyMatrix4(attitudeRoot.matrixWorld);
      distance = Math.max(
        distance,
        worldCorner.z + Math.abs(worldCorner.x) / horizontalSlope,
        worldCorner.z + Math.abs(worldCorner.y - CAMERA_Y) / verticalSlope,
      );
    }

    return distance;
  };

  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("./assets/vendor/draco/");
  const modelLoader = new GLTFLoader();
  modelLoader.setDRACOLoader(dracoLoader);

  modelLoader.load(
    "./assets/landsat-8.glb",
    (gltf) => {
      satellite = gltf.scene;
      const box = new THREE.Box3().setFromObject(satellite);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = MODEL_SPAN / Math.max(size.x, size.y, size.z);

      satellite.scale.setScalar(scale);
      satellite.position.copy(center).multiplyScalar(-scale);
      attitudeRoot.add(satellite);
      attitudeRoot.updateMatrixWorld(true);
      modelCorners = collectModelCorners();
      mount.classList.add("is-loaded");
      dracoLoader.dispose();
    },
    undefined,
    (error) => {
      mount.dataset.error = error?.message || String(error);
      mount.classList.add("has-error");
    },
  );

  const resize = () => {
    const width = Math.max(1, mount.clientWidth);
    const height = Math.max(1, mount.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const onPointerDown = (event) => {
    dragActive = true;
    previousX = event.clientX;
    previousY = event.clientY;
    mount.setPointerCapture(event.pointerId);
    mount.classList.add("is-dragging");
  };

  const onPointerMove = (event) => {
    if (!dragActive) return;
    targetYaw += (event.clientX - previousX) * 0.008;
    targetPitch += (event.clientY - previousY) * 0.006;
    previousX = event.clientX;
    previousY = event.clientY;
  };

  const onPointerUp = (event) => {
    dragActive = false;
    mount.releasePointerCapture?.(event.pointerId);
    mount.classList.remove("is-dragging");
  };

  mount.addEventListener("pointerdown", onPointerDown);
  mount.addEventListener("pointermove", onPointerMove);
  mount.addEventListener("pointerup", onPointerUp);
  mount.addEventListener("pointercancel", onPointerUp);

  const clock = new THREE.Clock();
  const render = () => {
    const elapsed = clock.getElapsedTime();
    const idleYaw = dragActive ? 0 : Math.sin(elapsed * 0.18) * 0.09;
    const idlePitch = dragActive ? 0 : Math.sin(elapsed * 0.23) * 0.025;

    satelliteRoot.rotation.y = THREE.MathUtils.lerp(satelliteRoot.rotation.y, targetYaw + idleYaw, 0.05);
    attitudeRoot.rotation.x = THREE.MathUtils.lerp(attitudeRoot.rotation.x, targetPitch + idlePitch, 0.055);
    attitudeRoot.rotation.z = -0.08 + Math.sin(elapsed * 0.16) * 0.018;
    satelliteRoot.position.x = Math.sin(elapsed * 0.14) * 0.1;
    satelliteRoot.position.y = Math.sin(elapsed * 0.7) * 0.08;
    const fitDistance = requiredCameraDistance();
    camera.position.z = fitDistance > camera.position.z
      ? fitDistance
      : THREE.MathUtils.lerp(camera.position.z, fitDistance, 0.08);
    renderer.render(scene, camera);
    requestAnimationFrame(render);
  };

  new ResizeObserver(resize).observe(mount);
  resize();
  render();
}
