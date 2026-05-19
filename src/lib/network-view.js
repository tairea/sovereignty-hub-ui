import * as THREE from 'three';
import { supabase } from './supabase.js';
import {
  createHub,
  RING_RADIUS, NODE_LEN, LAYER_LEN, LAYER_GAP,
  LAYERS, PILLARS,
  answerKey,
} from './hub-viz.js';

// One hub plus its outermost-label radius — used to space out the grid.
const HUB_FOOTPRINT = (NODE_LEN / 2 + 0 + LAYERS.length * (LAYER_LEN + LAYER_GAP) + 0.55) * 2;

// Tighter than HUB_FOOTPRINT so the grid feels populated.
const COL_STEP = HUB_FOOTPRINT * 0.95;
const ROW_STEP = HUB_FOOTPRINT * 1.05;

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

// ---------- Camera scroll state ----------
let cameraTargetZ = 0; // where camera is scrolling toward
let cameraZ = 0;
const CAMERA_HEIGHT = 14;
const CAMERA_TILT_Z_OFFSET = 6; // pull camera back along z so hubs sit nicely in view

// ---------- Per-hub drag state ----------
let dragState = null;
// { hubIdx, startX, startY, startRotY, moved }
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
  gridCamera = new THREE.PerspectiveCamera(45, rect.width / rect.height, 0.1, 500);
  cameraZ = 0;
  cameraTargetZ = 0;
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
  host.addEventListener('touchstart', onTouchStart, { passive: true });
  host.addEventListener('touchmove', onTouchMove, { passive: false });

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
  const { data, error } = await supabase
    .from('profiles')
    .select(`
      id, hub_name, hub_email, hub_link, hub_image_url,
      survey_state ( answers, descriptions, cursor, max_reached )
    `);
  loadingEl.hidden = true;
  if (error) {
    emptyEl.hidden = false;
    emptyEl.textContent = 'Failed to load hubs.';
    console.error('[network] load failed', error);
    return;
  }
  // Hide rows with no hub_name set — those are signed-in users who haven't
  // filled in their profile yet. They'd render as nameless circles.
  const populated = (data || []).filter((r) => r.hub_name && r.hub_name.trim());
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
  if (mode === 'grid') {
    const hit = pickBarAt(e.clientX, e.clientY, allBarMeshes, gridCamera);
    if (!hit) { dragState = null; return; }
    const hubIdx = hit.object.userData.hubIdx;
    dragState = {
      hubIdx,
      startX: e.clientX,
      startY: e.clientY,
      startRotY: hubs[hubIdx].group.rotation.y,
      moved: false,
    };
    host.setPointerCapture(e.pointerId);
  } else if (mode === 'viewer') {
    // In viewer: any pointerdown on canvas starts a rotation-or-click gesture.
    viewerDragState = {
      startX: e.clientX,
      startY: e.clientY,
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
    if (dragState.moved) {
      const factor = (Math.PI * 2) / 400;
      hubs[dragState.hubIdx].group.rotation.y = dragState.startRotY + dx * factor;
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
    const wasClick = !dragState.moved;
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
  // Scroll camera in +Z (further down the grid). Mouse wheel up = move up the grid.
  cameraTargetZ += e.deltaY * 0.04;
  clampCameraTarget();
}

let touchScrollState = null;
function onTouchStart(e) {
  // If a hub-drag is already happening (pointerdown captured), let it handle.
  if (dragState) return;
  if (e.touches.length !== 1) return;
  touchScrollState = { y: e.touches[0].clientY, startZ: cameraTargetZ };
}
function onTouchMove(e) {
  // Only handle scroll when we're NOT in a hub-drag gesture.
  if (dragState || !touchScrollState || e.touches.length !== 1) return;
  e.preventDefault();
  const dy = e.touches[0].clientY - touchScrollState.y;
  cameraTargetZ = touchScrollState.startZ - dy * 0.04;
  clampCameraTarget();
}

function clampCameraTarget() {
  if (hubs.length === 0) { cameraTargetZ = 0; return; }
  const maxRowZ = hubs[hubs.length - 1].z;
  cameraTargetZ = Math.max(0, Math.min(maxRowZ, cameraTargetZ));
}

function positionGridCamera() {
  if (!gridCamera) return;
  gridCamera.position.set(0, CAMERA_HEIGHT, cameraZ + CAMERA_TILT_Z_OFFSET);
  gridCamera.lookAt(0, 0, cameraZ);
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
    cameraZ += (cameraTargetZ - cameraZ) * 0.18;
    positionGridCamera();
    renderer.render(gridScene, gridCamera);
  } else if (mode === 'viewer' && viewerScene && viewerCamera) {
    renderer.render(viewerScene, viewerCamera);
    if (popupTarget) updatePopupPosition();
  }
  animFrame = requestAnimationFrame(loop);
}
