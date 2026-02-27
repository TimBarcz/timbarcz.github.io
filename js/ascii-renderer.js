import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const CONFIG = {
  // Tribute to Jan Barcz — phrases cycle through the brightness gradient
  characters: " Jan Barcz I miss you mom I'll always love you Jan Barcz I miss you mom I'll always love you",
  cellSize: 6,
  modelPath: 'glb/butterfly-draco.glb',
  renderWidth: 960,
  renderHeight: 540,
  cameraFov: 35,
  baseDistance: 2.0,

  flapSpeedFlying: 1.3,
  flapSpeedResting: 0.12,
  flightRampUp: 0.06,
  flightRampDown: 0.008,
  mouseStillDelay: 600,

  orbitSpeedFlying: 0.35,
  orbitSpeedResting: 0.015,
  distanceFlying: 0.6,
  distanceResting: 1.1,
  heightFlying: 0.15,
  heightResting: 0.0,
  cameraSmoothing: 0.025,

  wanderAmplitudeX: 0.8,
  wanderAmplitudeY: 0.5,
  wanderSpeedFlying: 0.35,
  wanderSpeedResting: 0.05,
  wanderSmoothing: 0.02,
};

const container = document.getElementById('ascii-model');
const asciiPre = document.getElementById('ascii-art');
if (!container || !asciiPre) throw new Error('ASCII container not found');

const offscreen = document.createElement('canvas');
offscreen.width = CONFIG.renderWidth;
offscreen.height = CONFIG.renderHeight;

const renderer = new THREE.WebGLRenderer({
  canvas: offscreen,
  antialias: false,
  alpha: true,
});
renderer.setSize(CONFIG.renderWidth, CONFIG.renderHeight);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  CONFIG.cameraFov,
  CONFIG.renderWidth / CONFIG.renderHeight,
  0.01,
  500
);

scene.add(new THREE.AmbientLight(0xffffff, 0.7));

const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(3, 5, 4);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
fillLight.position.set(-3, 2, -2);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xffffff, 0.6);
rimLight.position.set(0, 3, -6);
scene.add(rimLight);

let mixer = null;
let hoverAction = null;
let modelCenter = new THREE.Vector3();
let orbitRadius = 1;
let loaded = false;

// Flight state: 0 = resting, 1 = flying
let flight = 0;
let mouseMoving = false;
let mouseTimer = null;

// Camera state
let orbitAngle = 0;
let currentDistance = CONFIG.distanceResting;
let currentHeight = CONFIG.heightResting;

// Wander state — makes the butterfly drift around the viewport
let wanderTime = 0;
let currentOffsetX = 0;
let currentOffsetY = 0;

const readCtx = (() => {
  const c = document.createElement('canvas');
  c.width = CONFIG.renderWidth;
  c.height = CONFIG.renderHeight;
  return c.getContext('2d', { willReadFrequently: true });
})();

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
dracoLoader.setDecoderConfig({ type: 'js' });

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

loader.load(
  CONFIG.modelPath,
  (gltf) => {
    const model = gltf.scene;

    model.traverse((child) => {
      if (child.isMesh) {
        child.material = new THREE.MeshStandardMaterial({
          color: 0xcccccc,
          roughness: 0.5,
          metalness: 0.05,
          side: THREE.DoubleSide,
        });
      }
    });

    const box = new THREE.Box3().setFromObject(model);
    modelCenter = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    orbitRadius = maxDim * CONFIG.baseDistance;

    scene.add(model);

    if (gltf.animations && gltf.animations.length > 0) {
      mixer = new THREE.AnimationMixer(model);

      const hoverClip = gltf.animations.find(c => c.name === 'hover') || gltf.animations[0];
      hoverAction = mixer.clipAction(hoverClip);
      hoverAction.play();
      hoverAction.loop = THREE.LoopRepeat;
      hoverAction.timeScale = CONFIG.flapSpeedResting;
    }

    loaded = true;
    dracoLoader.dispose();
    updateCamera();
    animate();
  },
  undefined,
  (err) => console.error('Failed to load model:', err)
);

function updateCamera() {
  const r = orbitRadius * currentDistance;

  camera.position.set(
    modelCenter.x + r * Math.sin(orbitAngle),
    modelCenter.y + orbitRadius * currentHeight,
    modelCenter.z + r * Math.cos(orbitAngle)
  );
  camera.lookAt(modelCenter);
}

function updatePrePosition() {
  const tx = currentOffsetX * 35;
  const ty = currentOffsetY * -30 + 5;
  asciiPre.style.transform =
    'translate(' + tx.toFixed(1) + 'vw, ' + ty.toFixed(1) + 'vh)';
}

function renderToAscii() {
  renderer.render(scene, camera);

  readCtx.clearRect(0, 0, CONFIG.renderWidth, CONFIG.renderHeight);
  readCtx.drawImage(offscreen, 0, 0);

  const cell = CONFIG.cellSize;
  const cols = Math.floor(CONFIG.renderWidth / cell);
  const rows = Math.floor(CONFIG.renderHeight / cell);
  const chars = CONFIG.characters;
  const maxIdx = chars.length - 1;

  const imageData = readCtx.getImageData(0, 0, CONFIG.renderWidth, CONFIG.renderHeight);
  const pixels = imageData.data;
  const w = CONFIG.renderWidth;

  const lines = new Array(rows);

  for (let row = 0; row < rows; row++) {
    let line = '';
    for (let col = 0; col < cols; col++) {
      let totalBrightness = 0;
      let totalAlpha = 0;
      let sampleCount = 0;

      const startX = col * cell;
      const startY = row * cell;

      for (let dy = 0; dy < cell; dy += 2) {
        for (let dx = 0; dx < cell; dx += 2) {
          const px = startX + dx;
          const py = startY + dy;
          const idx = (py * w + px) * 4;
          totalBrightness += (0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2]);
          totalAlpha += pixels[idx + 3];
          sampleCount++;
        }
      }

      const avgAlpha = totalAlpha / sampleCount;

      if (avgAlpha < 10) {
        line += ' ';
      } else {
        const normalized = (totalBrightness / sampleCount / 255) * (avgAlpha / 255);
        const charIndex = Math.min(maxIdx, Math.floor(normalized * maxIdx));
        line += chars[charIndex];
      }
    }
    lines[row] = line;
  }

  asciiPre.textContent = lines.join('\n');
}

const clock = new THREE.Clock();

function lerp(a, b, t) { return a + (b - a) * t; }

function animate() {
  if (!loaded) return;
  requestAnimationFrame(animate);

  const delta = clock.getDelta();

  // Ramp flight up quickly when mouse moves, down slowly when it stops
  if (mouseMoving) {
    flight += (1 - flight) * CONFIG.flightRampUp;
  } else {
    flight += (0 - flight) * CONFIG.flightRampDown;
  }
  flight = Math.max(0, Math.min(1, flight));

  // Wing flap speed: fast when flying, slow breathing when resting
  if (hoverAction) {
    const targetSpeed = lerp(CONFIG.flapSpeedResting, CONFIG.flapSpeedFlying, flight);
    hoverAction.timeScale = targetSpeed;
  }

  if (mixer) {
    mixer.update(delta);
  }

  // Camera orbit
  const orbitSpeed = lerp(CONFIG.orbitSpeedResting, CONFIG.orbitSpeedFlying, flight);
  orbitAngle += orbitSpeed * delta;

  // Zoom / height
  const targetDist = lerp(CONFIG.distanceResting, CONFIG.distanceFlying, flight);
  const targetHeight = lerp(CONFIG.heightResting, CONFIG.heightFlying, flight);
  currentDistance += (targetDist - currentDistance) * CONFIG.cameraSmoothing;
  currentHeight += (targetHeight - currentHeight) * CONFIG.cameraSmoothing;

  // Wander: butterfly drifts around the viewport using Lissajous-style motion
  const wanderSpeed = lerp(CONFIG.wanderSpeedResting, CONFIG.wanderSpeedFlying, flight);
  wanderTime += wanderSpeed * delta;

  const wanderScale = lerp(0.2, 1.0, flight);
  const targetOX = Math.sin(wanderTime * 1.0) * CONFIG.wanderAmplitudeX * wanderScale
                  + Math.sin(wanderTime * 1.7) * CONFIG.wanderAmplitudeX * 0.3 * wanderScale;
  const targetOY = Math.cos(wanderTime * 0.8) * CONFIG.wanderAmplitudeY * wanderScale
                  + Math.sin(wanderTime * 1.3) * CONFIG.wanderAmplitudeY * 0.2 * wanderScale;

  currentOffsetX += (targetOX - currentOffsetX) * CONFIG.wanderSmoothing;
  currentOffsetY += (targetOY - currentOffsetY) * CONFIG.wanderSmoothing;

  updateCamera();
  updatePrePosition();
  renderToAscii();
}

function onMouseMove() {
  mouseMoving = true;
  clearTimeout(mouseTimer);
  mouseTimer = setTimeout(() => { mouseMoving = false; }, CONFIG.mouseStillDelay);
}

window.addEventListener('mousemove', onMouseMove, { passive: true });
window.addEventListener('scroll', onMouseMove, { passive: true });
mouseTimer = setTimeout(() => { mouseMoving = false; }, CONFIG.mouseStillDelay);
