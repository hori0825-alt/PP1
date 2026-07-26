import * as THREE from 'three';
import './ui/app.css';
import { createScene } from './viewer/scene';
import { ViewerCameraRig } from './viewer/cameras';
import { ViewerControls } from './viewer/controls';
import { buildBodyMesh } from './geometry/bodyMesh';
import { buildCalyxMesh } from './geometry/calyxMesh';
import { buildStemMesh } from './geometry/stemMesh';
import { buildEyeMesh, buildMouthMesh } from './geometry/faceMesh';
import { createDefaultProjectData } from './presets/eggplant';
import { mountReferencePanel } from './ui/referencePanel';
import { formatMm } from './core/units';
import type { ViewName } from './core/params';

const app = document.getElementById('app')!;
app.innerHTML = `
  <div id="panel-left" class="panel">
    <h2>プロジェクト / 本体 / ヘタ / 茎 / 顔 / 色 / 印刷設定 / エクスポート</h2>
    <p>（今後のタスクで実装）</p>
    <div id="panel-reference"></div>
  </div>
  <div id="viewer-container">
    <canvas id="viewer-canvas"></canvas>
    <div class="view-toolbar">
      <button data-view="front">正面</button>
      <button data-view="side">右側面</button>
      <button data-view="back">背面</button>
      <button data-view="top">上面</button>
      <button data-view="perspective">斜め</button>
      <button id="toggle-projection">平行投影</button>
    </div>
    <div class="dim-readout" id="dim-readout"></div>
  </div>
  <div id="panel-right" class="panel"><h2>選択パーツ詳細</h2><p>（今後のタスクで実装）</p></div>
  <div id="panel-bottom" class="panel"><h2>断面グラフ / ログ</h2><p>（今後のタスクで実装）</p></div>
`;

const project = createDefaultProjectData();

const canvas = document.getElementById('viewer-canvas') as HTMLCanvasElement;
const { scene, renderer, bodyGroup } = createScene(canvas);

const bodyMaterial = new THREE.MeshStandardMaterial({ color: project.colors.body });
const calyxMaterial = new THREE.MeshStandardMaterial({ color: project.colors.calyx });
const stemMaterial = new THREE.MeshStandardMaterial({ color: project.colors.stem });
const eyeMaterial = new THREE.MeshStandardMaterial({ color: project.colors.eye });
const mouthMaterial = new THREE.MeshStandardMaterial({ color: project.colors.mouth });

function rebuildBodyMesh(): void {
  bodyGroup.clear();
  const { geometry, warnings } = buildBodyMesh(project.body);
  const mesh = new THREE.Mesh(geometry, bodyMaterial);
  mesh.name = 'body';
  bodyGroup.add(mesh);
  if (warnings.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[body warnings]', warnings);
  }

  const calyx = buildCalyxMesh(project.calyx, project.body.sections);
  const calyxMesh = new THREE.Mesh(calyx.geometry, calyxMaterial);
  calyxMesh.name = 'calyx';
  bodyGroup.add(calyxMesh);
  if (calyx.warnings.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[calyx warnings]', calyx.warnings);
  }

  const stem = buildStemMesh(project.stem, project.body.sections);
  const stemMesh = new THREE.Mesh(stem.geometry, stemMaterial);
  stemMesh.name = 'stem';
  bodyGroup.add(stemMesh);
  if (stem.warnings.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[stem warnings]', stem.warnings);
  }

  const eyes = buildEyeMesh(project.eyes, project.body.sections);
  const eyeMesh = new THREE.Mesh(eyes.geometry, eyeMaterial);
  eyeMesh.name = 'eyes';
  bodyGroup.add(eyeMesh);

  const mouth = buildMouthMesh(project.mouth, project.body.sections);
  const mouthMesh = new THREE.Mesh(mouth.geometry, mouthMaterial);
  mouthMesh.name = 'mouth';
  bodyGroup.add(mouthMesh);
}
rebuildBodyMesh();

const cameraRig = new ViewerCameraRig();
cameraRig.setTarget(new THREE.Vector3(0, 0, project.body.totalHeight / 2));
cameraRig.setDistance(project.camera.distanceMm);

const controls = new ViewerControls(
  cameraRig.camera,
  canvas,
  new THREE.Vector3(0, 0, project.body.totalHeight / 2),
);

const viewerContainer = document.getElementById('viewer-container')!;
function resize(): void {
  const width = viewerContainer.clientWidth;
  const height = viewerContainer.clientHeight;
  renderer.setSize(width, height, false);
  cameraRig.setAspect(width / height);
}
new ResizeObserver(resize).observe(viewerContainer);
resize();

const viewButtons = document.querySelectorAll<HTMLButtonElement>('.view-toolbar button[data-view]');
function setActiveViewButton(view: ViewName): void {
  viewButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
}
viewButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view as ViewName;
    cameraRig.setView(view);
    controls.rebind(cameraRig.camera);
    setActiveViewButton(view);
  });
});
setActiveViewButton('perspective');

const toggleProjectionBtn = document.getElementById('toggle-projection') as HTMLButtonElement;
toggleProjectionBtn.addEventListener('click', () => {
  cameraRig.setOrthographic(!cameraRig.isOrthographic);
  toggleProjectionBtn.classList.toggle('active', cameraRig.isOrthographic);
  controls.rebind(cameraRig.camera);
});

const dimReadout = document.getElementById('dim-readout')!;
dimReadout.textContent = `全高: ${formatMm(project.body.totalHeight)}`;

mountReferencePanel(document.getElementById('panel-reference')!, {
  project,
  scene,
  getCamera: () => cameraRig.camera,
  domElement: canvas,
});

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, cameraRig.camera);
}
animate();
