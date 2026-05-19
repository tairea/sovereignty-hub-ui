import * as THREE from 'three';
import { supabase } from './supabase.js';
import {
  createHub,
  RING_RADIUS, NODE_LEN, LAYER_LEN, LAYER_GAP,
  LAYERS, PILLARS,
  answerKey,
} from './hub-viz.js';

// Spoke length from hub center to the outer end of the last layer bar
// (this is also where the pillar label sprite is anchored).
const SPOKE_END_RADIUS = NODE_LEN / 2 + LAYERS.length * (LAYER_LEN + LAYER_GAP) + 0.55;

// Labels are 3.4-wide sprites centered on the spoke end, so they extend
// ~1.7 units past the bar tip in every direction. Add label padding plus a
// small visual gap so adjacent hubs never overlap regardless of which
// pillars happen to be facing each other.
const LABEL_HALF_WIDTH = 1.7;
const VISUAL_GAP = 1.5;
const HUB_FOOTPRINT = (SPOKE_END_RADIUS + LABEL_HALF_WIDTH + VISUAL_GAP) * 2;

const COL_STEP = HUB_FOOTPRINT;
const ROW_STEP = HUB_FOOTPRINT;

const COLS_DESKTOP = 3;
const COLS_MOBILE = 1;

// ---------- DOM handles (populated lazily on first open) ----------
let overlay = null;
let host = null;
let countEl = null;
let titleEl = null;
let loadingEl = null;
let emptyEl = null;
let closeBtn = null;
let popupEl = null;
let popupIconEl = null;
let popupTitleEl = null;
let popupBodyEl = null;

// ---------- THREE.js state (recreated each open / disposed on close) ----------
let renderer = null;
let raycaster = null;
let mouseNDC = null;
let animFrame = null;

// View mode: 'grid' or 'viewer'
let mode = 'grid';

// Grid mode state
let gridScene = null;
let gridCamera = null;
let hubs = []; // [{ group, pillarNodes, record, x, z }]
let allBarMeshes = [];

// Viewer mode state (single hub centered for reading)
let viewerScene = null;
let viewerCamera = null;
let viewerHub = null; // { group, pillarNodes, allBarMeshes, record }
let viewerBarMeshes = [];
let viewerRotation = { y: 0, x: 0 }; // user-controlled rotation
let viewerDragState = null;
let popupTarget = null; // { pIdx, lIdx }

// ---------- Camera state ----------
// Parameterised as a target point on the grid plane (y=0) plus a "height"
// above the plane. The camera tilts slightly toward +Z so hubs read with
// a hint of perspective instead of dead-on top-down.
let cameraTargetZ = 0;           // where the camera looks (smoothed)
let cameraTargetZGoal = 0;       // where it is scrolling toward
let cameraHeight = 30;           // current distance above grid (smoothed)
let cameraHeightGoal = 30;       // where zoom is going
const CAMERA_TILT_RATIO = 0.30;  // tiltOffsetZ / height
const ZOOM_MIN = 8;
const ZOOM_MAX = 180;

// ---------- Per-hub drag state ----------
// dragState shapes:
//   { kind: 'rotate-hub', hubIdx, startX, startY, startRotY, moved }
//   { kind: 'scroll-grid', startX, startY, startTargetZ, moved }
let dragState = null;
let pinchState = null;
const DRAG_THRESHOLD_PX = 6;

// ---------- Public API ----------
export function open() {
  ensureDom();
  overlay.hidden = false;
  document.documentElement.style.overflow = 'hidden';
  mode = 'grid';
  updateChrome();
  startScene();
  loadHubs();
}

export function close() {
  if (overlay) overlay.hidden = true;
  document.documentElement.style.overflow = '';
  hidePopup();
  stopScene();
}

export function isOpen() {
  return overlay && !overlay.hidden;
}

// Back-button behavior: in viewer → return to grid; in grid → close overlay
function onBack() {
  if (mode === 'viewer') exitViewer();
  else close();
}

// ---------- DOM setup ----------
function ensureDom() {
  if (overlay) return;
  overlay = document.getElementById('network-overlay');
  host = document.getElementById('network-canvas-host');
  countEl = document.getElementById('network-count');
  titleEl = document.getElementById('network-title');
  loadingEl = document.getElementById('network-loading');
  emptyEl = document.getElementById('network-empty');
  closeBtn = document.getElementById('network-close');
  popupEl = document.getElementById('network-viewer-popup');
  popupIconEl = popupEl.querySelector('.vp-icon');
  popupTitleEl = popupEl.querySelector('.vp-title');
  popupBodyEl = popupEl.querySelector('.vp-body');

  closeBtn.addEventListener('click', onBack);
  popupEl.querySelector('.vp-close').addEventListener('click', hidePopup);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) onBack();
  });
}

function updateChrome() {
  if (mode === 'viewer') {
    titleEl.textContent = viewerHub?.record?.hub_name || 'Hub';
    countEl.textContent = '';
  } else {
    titleEl.textContent = 'All Hubs';
    countEl.textContent = hubs.length ? `· ${hubs.length} hub${hubs.length === 1 ? '' : 's'}` : '';
  }
}

function addLights(s) {
  const amb = new THREE.AmbientLight(0xffffff, 0.55);
  s.add(amb);
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(8, 18, 6);
  s.add(dir);
}

// ---------- THREE setup / teardown ----------
function startScene() {
  gridScene = new THREE.Scene();
  gridScene.background = null;

  const rect = host.getBoundingClientRect();
  gridCamera = new THREE.PerspectiveCamera(45, rect.width / rect.height, 0.1, 1000);
  cameraTargetZ = 0;
  cameraTargetZGoal = 0;
  cameraHeight = 30;
  cameraHeightGoal = 30;
  positionGridCamera();

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(rect.width, rect.height);
  host.appendChild(renderer.domElement);

  addLights(gridScene);

  raycaster = new THREE.Raycaster();
  mouseNDC = new THREE.Vector2();

  window.addEventListener('resize', onResize);
  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);
  host.addEventListener('wheel', onWheel, { passive: false });
  host.addEventListener('touchstart', onTouchStart, { passive: false });
  host.addEventListener('touchmove', onTouchMove, { passive: false });
  host.addEventListener('touchend', onTouchEnd);
  host.addEventListener('touchcancel', onTouchEnd);

  loop();
}

function disposeGroup(group) {
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else obj.material.dispose();
    }
  });
}

function stopScene() {
  if (animFrame != null) cancelAnimationFrame(animFrame);
  animFrame = null;
  window.removeEventListener('resize', onResize);
  if (host) {
    host.removeEventListener('pointerdown', onPointerDown);
    host.removeEventListener('pointermove', onPointerMove);
    host.removeEventListener('pointerup', onPointerUp);
    host.removeEventListener('pointercancel', onPointerUp);
    host.removeEventListener('wheel', onWheel);
    host.removeEventListener('touchstart', onTouchStart);
    host.removeEventListener('touchmove', onTouchMove);
    host.removeEventListener('touchend', onTouchEnd);
    host.removeEventListener('touchcancel', onTouchEnd);
  }
  for (const h of hubs) disposeGroup(h.group);
  hubs = [];
  allBarMeshes = [];
  if (viewerHub) { disposeGroup(viewerHub.group); viewerHub = null; viewerBarMeshes = []; }
  if (renderer) {
    renderer.dispose();
    if (renderer.domElement && renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
    renderer = null;
  }
  gridScene = null;
  gridCamera = null;
  viewerScene = null;
  viewerCamera = null;
  dragState = null;
  viewerDragState = null;
}

function onResize() {
  if (!renderer || !host) return;
  const rect = host.getBoundingClientRect();
  if (gridCamera) {
    gridCamera.aspect = rect.width / rect.height;
    gridCamera.updateProjectionMatrix();
  }
  if (viewerCamera) {
    viewerCamera.aspect = rect.width / rect.height;
    viewerCamera.updateProjectionMatrix();
  }
  renderer.setSize(rect.width, rect.height);
  if (popupTarget) updatePopupPosition();
  // On resize, re-fit so the layout adapts to orientation / window changes.
  if (mode === 'grid') fitAllHubs();
}

// ---------- Loading hubs ----------
async function loadHubs() {
  loadingEl.hidden = false;
  emptyEl.hidden = true;
  countEl.textContent = '';
  if (!supabase) {
    loadingEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.textContent = 'Supabase not configured.';
    return;
  }
  // profiles and survey_state both reference auth.users but not each other,
  // so PostgREST can't auto-join them. Fetch separately and merge.
  const [profilesRes, surveyRes] = await Promise.all([
    supabase.from('profiles').select('id, hub_name, hub_email, hub_link, hub_image_url'),
    supabase.from('survey_state').select('user_id, answers, descriptions, cursor, max_reached'),
  ]);
  loadingEl.hidden = true;
  if (profilesRes.error || surveyRes.error) {
    emptyEl.hidden = false;
    emptyEl.textContent = 'Failed to load hubs.';
    console.error('[network] load failed', profilesRes.error || surveyRes.error);
    return;
  }
  const surveysByUser = new Map();
  for (const s of (surveyRes.data || [])) surveysByUser.set(s.user_id, s);
  const merged = (profilesRes.data || []).map((p) => ({
    ...p,
    survey_state: surveysByUser.get(p.id) || null,
  }));
  // Hide rows with no hub_name set — those are signed-in users who haven't
  // filled in their profile yet. They'd render as nameless circles.
  const populated = merged.filter((r) => r.hub_name && r.hub_name.trim());
  if (populated.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  countEl.textContent = `· ${populated.length} hub${populated.length === 1 ? '' : 's'}`;
  buildHubs(populated);
}

function buildHubs(records) {
  const cols = (window.innerWidth >= 768) ? COLS_DESKTOP : COLS_MOBILE;
  records.forEach((rec, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = (col - (cols - 1) / 2) * COL_STEP;
    const z = row * ROW_STEP;

    const survey = (Array.isArray(rec.survey_state) ? rec.survey_state[0] : rec.survey_state) || {};
    const hub = createHub({
      answers: survey.answers || {},
      descriptions: survey.descriptions || {},
      name: rec.hub_name,
      imageUrl: rec.hub_image_url || '',
    });
    hub.group.position.set(x, 0, z);
    gridScene.add(hub.group);

    const entry = {
      idx: i, x, z,
      group: hub.group,
      pillarNodes: hub.pillarNodes,
      record: rec,
    };
    hubs.push(entry);
    for (const m of hub.allBarMeshes) {
      m.userData.hubIdx = i;
      allBarMeshes.push(m);
    }
  });
  updateChrome();
  fitAllHubs();
}

// Position the camera so every hub fits in the viewport with a little padding.
function fitAllHubs() {
  if (!gridCamera || hubs.length === 0) return;
  const xs = hubs.map((h) => h.x);
  const zs = hubs.map((h) => h.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  // Each hub occupies a rough HUB_FOOTPRINT square — include those bounds,
  // not just the centers.
  const spreadX = (maxX - minX) + HUB_FOOTPRINT;
  const spreadZ = (maxZ - minZ) + HUB_FOOTPRINT;
  const centerZ = (minZ + maxZ) / 2;

  const rect = host.getBoundingClientRect();
  const aspect = rect.width / rect.height;
  const fovY = THREE.MathUtils.degToRad(gridCamera.fov);
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
  // Top-down approximation; the tilt adds a little error so multiply by
  // 1.2 padding to absorb that plus give breathing room.
  const hForX = (spreadX / 2) / Math.tan(fovX / 2);
  const hForZ = (spreadZ / 2) / Math.tan(fovY / 2);
  const h = Math.max(hForX, hForZ) * 1.2;

  cameraHeight = h;
  cameraHeightGoal = h;
  cameraTargetZ = centerZ;
  cameraTargetZGoal = centerZ;
}

// ---------- Interaction ----------
function pickBarAt(clientX, clientY, meshList, camForRay) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouseNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouseNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, camForRay);
  const hits = raycaster.intersectObjects(meshList, false);
  return hits.length > 0 ? hits[0] : null;
}

function onPointerDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  // Pinch in progress? Don't start a one-finger drag.
  if (pinchState) return;
  if (mode === 'grid') {
    const hit = pickBarAt(e.clientX, e.clientY, allBarMeshes, gridCamera);
    if (hit) {
      const hubIdx = hit.object.userData.hubIdx;
      dragState = {
        kind: 'rotate-hub',
        hubIdx,
        startX: e.clientX, startY: e.clientY,
        startRotY: hubs[hubIdx].group.rotation.y,
        moved: false,
      };
    } else {
      // Empty space → pan/scroll the grid.
      dragState = {
        kind: 'scroll-grid',
        startX: e.clientX, startY: e.clientY,
        startTargetZ: cameraTargetZGoal,
        moved: false,
      };
    }
    host.setPointerCapture(e.pointerId);
  } else if (mode === 'viewer') {
    viewerDragState = {
      startX: e.clientX, startY: e.clientY,
      startRotY: viewerRotation.y,
      moved: false,
      pickedBar: pickBarAt(e.clientX, e.clientY, viewerBarMeshes, viewerCamera),
    };
    host.setPointerCapture(e.pointerId);
  }
}

function onPointerMove(e) {
  if (mode === 'grid' && dragState) {
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) dragState.moved = true;
    if (!dragState.moved) return;
    if (dragState.kind === 'rotate-hub') {
      const factor = (Math.PI * 2) / 400;
      hubs[dragState.hubIdx].group.rotation.y = dragState.startRotY + dx * factor;
    } else if (dragState.kind === 'scroll-grid') {
      // Convert px → world units based on current camera height + FOV so
      // the grid pans 1:1 with the cursor regardless of zoom.
      const fovY = THREE.MathUtils.degToRad(gridCamera.fov);
      const worldPerPx = (2 * cameraHeight * Math.tan(fovY / 2)) / host.clientHeight;
      cameraTargetZGoal = dragState.startTargetZ - dy * worldPerPx;
      clampCameraTarget();
    }
  } else if (mode === 'viewer' && viewerDragState) {
    const dx = e.clientX - viewerDragState.startX;
    const dy = e.clientY - viewerDragState.startY;
    if (!viewerDragState.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) viewerDragState.moved = true;
    if (viewerDragState.moved) {
      const factor = (Math.PI * 2) / 400;
      viewerRotation.y = viewerDragState.startRotY + dx * factor;
      viewerHub.group.rotation.y = viewerRotation.y;
    }
  }
}

function onPointerUp(e) {
  try { host.releasePointerCapture(e.pointerId); } catch (_) {}
  if (mode === 'grid' && dragState) {
    const wasClick = !dragState.moved && dragState.kind === 'rotate-hub';
    const clickedHubIdx = dragState.hubIdx;
    dragState = null;
    if (wasClick) {
      const rec = hubs[clickedHubIdx]?.record;
      if (rec) enterViewer(rec);
    }
  } else if (mode === 'viewer' && viewerDragState) {
    const wasClick = !viewerDragState.moved;
    const hit = viewerDragState.pickedBar;
    viewerDragState = null;
    if (wasClick && hit) {
      const { pIdx, lIdx } = hit.object.userData;
      showPopupForLayer(pIdx, lIdx);
    } else if (wasClick) {
      hidePopup();
    }
  }
}

function onWheel(e) {
  e.preventDefault();
  if (mode !== 'grid') return;
  // wheel-up (negative deltaY) zooms in (smaller height).
  // 1.0015^120 ≈ 1.2 per notch — feels about right.
  const factor = Math.pow(1.0015, e.deltaY);
  cameraHeightGoal = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cameraHeightGoal * factor));
}

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function onTouchStart(e) {
  if (e.touches.length === 2 && mode === 'grid') {
    // Two-finger pinch: cancel any in-progress one-finger drag.
    dragState = null;
    pinchState = {
      startDistance: touchDistance(e.touches),
      startHeight: cameraHeightGoal,
    };
  }
}

function onTouchMove(e) {
  if (pinchState && e.touches.length === 2 && mode === 'grid') {
    e.preventDefault();
    const d = touchDistance(e.touches);
    if (d > 0 && pinchState.startDistance > 0) {
      const factor = pinchState.startDistance / d;
      cameraHeightGoal = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinchState.startHeight * factor));
    }
  }
}

function onTouchEnd(e) {
  if (e.touches.length < 2) pinchState = null;
}

function clampCameraTarget() {
  if (hubs.length === 0) { cameraTargetZGoal = 0; return; }
  const minZ = hubs[0].z - HUB_FOOTPRINT;
  const maxZ = hubs[hubs.length - 1].z + HUB_FOOTPRINT;
  cameraTargetZGoal = Math.max(minZ, Math.min(maxZ, cameraTargetZGoal));
}

function positionGridCamera() {
  if (!gridCamera) return;
  gridCamera.position.set(0, cameraHeight, cameraTargetZ + cameraHeight * CAMERA_TILT_RATIO);
  gridCamera.lookAt(0, 0, cameraTargetZ);
}

// ---------- Viewer mode (single hub fullscreen) ----------
function enterViewer(rec) {
  mode = 'viewer';
  hidePopup();
  // Build a fresh hub at origin in its own scene
  viewerScene = new THREE.Scene();
  viewerScene.background = null;
  addLights(viewerScene);
  const survey = (Array.isArray(rec.survey_state) ? rec.survey_state[0] : rec.survey_state) || {};
  const built = createHub({
    answers: survey.answers || {},
    descriptions: survey.descriptions || {},
    name: rec.hub_name,
    imageUrl: rec.hub_image_url || '',
  });
  viewerHub = {
    group: built.group,
    pillarNodes: built.pillarNodes,
    record: rec,
    answers: survey.answers || {},
    descriptions: survey.descriptions || {},
  };
  viewerBarMeshes = built.allBarMeshes;
  viewerScene.add(built.group);
  viewerRotation = { y: 0, x: 0 };
  built.group.rotation.y = 0;

  const rect = host.getBoundingClientRect();
  viewerCamera = new THREE.PerspectiveCamera(45, rect.width / rect.height, 0.1, 100);
  // Same framing as main viz so it feels familiar
  viewerCamera.position.set(0, 14, 1.5);
  viewerCamera.lookAt(0, 0, 0);

  updateChrome();
}

function exitViewer() {
  hidePopup();
  if (viewerHub) {
    disposeGroup(viewerHub.group);
    viewerHub = null;
    viewerBarMeshes = [];
  }
  viewerScene = null;
  viewerCamera = null;
  viewerDragState = null;
  mode = 'grid';
  updateChrome();
}

// ---------- Popup (viewer mode) ----------
function showPopupForLayer(pIdx, lIdx) {
  const desc = viewerHub?.descriptions?.[answerKey(pIdx, lIdx)];
  if (!desc || !desc.trim()) { hidePopup(); return; }
  const pillar = PILLARS[pIdx];
  const layer = LAYERS[lIdx];
  popupIconEl.className = `vp-icon ${pillar.faClass}`;
  popupIconEl.style.color = pillar.color;
  popupTitleEl.textContent = `${pillar.name} · ${layer.name}`;
  popupBodyEl.textContent = desc;
  popupTarget = { pIdx, lIdx };
  popupEl.hidden = false;
  updatePopupPosition();
}

function hidePopup() {
  popupTarget = null;
  if (popupEl) popupEl.hidden = true;
}

function updatePopupPosition() {
  if (!popupTarget || !viewerHub || !viewerCamera || !renderer) return;
  const pn = viewerHub.pillarNodes[popupTarget.pIdx];
  const bar = pn.bars[popupTarget.lIdx];
  bar.group.updateMatrixWorld(true);
  const centerWorld = new THREE.Vector3().setFromMatrixPosition(bar.group.matrixWorld);
  const outerWorld = new THREE.Vector3(LAYER_LEN / 2, 0, 0).applyMatrix4(bar.group.matrixWorld);
  const ndcCenter = centerWorld.clone().project(viewerCamera);
  const ndcOuter = outerWorld.clone().project(viewerCamera);
  const rect = renderer.domElement.getBoundingClientRect();
  const ox = (ndcOuter.x * 0.5 + 0.5) * rect.width;
  const cy = (1 - (ndcCenter.y * 0.5 + 0.5)) * rect.height;
  const MARGIN = 36;
  popupEl.style.left = `${ox + MARGIN}px`;
  popupEl.style.top = `${cy}px`;
  popupEl.style.transform = 'translate(0, -50%)';
  popupEl.style.opacity = (ndcCenter.z > 1) ? '0' : '1';
}

// ---------- Render loop ----------
function loop() {
  if (!renderer) return;
  if (mode === 'grid') {
    cameraTargetZ += (cameraTargetZGoal - cameraTargetZ) * 0.18;
    cameraHeight += (cameraHeightGoal - cameraHeight) * 0.2;
    positionGridCamera();
    renderer.render(gridScene, gridCamera);
  } else if (mode === 'viewer' && viewerScene && viewerCamera) {
    renderer.render(viewerScene, viewerCamera);
    if (popupTarget) updatePopupPosition();
  }
  animFrame = requestAnimationFrame(loop);
}
