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
import { createAtlasTexture, assignSolidUV } from './texture/canvasPainter';
import { ATLAS_PATCHES } from './texture/atlas';
import { formatMm } from './core/units';
import type { ViewName } from './core/params';
import { ProjectStore } from './state/store';
import type { PanelContext, MountedPanel } from './ui/panels/context';
import { mountBodyPanel } from './ui/panels/bodyPanel';
import { mountCalyxPanel } from './ui/panels/calyxPanel';
import { mountStemPanel } from './ui/panels/stemPanel';
import { mountFacePanel } from './ui/panels/facePanel';
import { mountColorPanel } from './ui/panels/colorPanel';
import { mountPrintPanel } from './ui/panels/printPanel';
import { mountProjectPanel } from './ui/panels/projectPanel';

const app = document.getElementById('app')!;
app.innerHTML = `
  <div id="panel-left" class="panel">
    <div id="panel-project"></div>
    <div id="panel-reference"></div>
    <div id="panel-body"></div>
    <div id="panel-calyx"></div>
    <div id="panel-stem"></div>
    <div id="panel-face"></div>
    <div id="panel-color"></div>
    <div id="panel-print"></div>
    <div id="panel-export"></div>
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
      <button id="toggle-wireframe">ワイヤーフレーム</button>
    </div>
    <div class="dim-readout" id="dim-readout"></div>
  </div>
  <div id="panel-right" class="panel">
    <h2>寸法・警告</h2>
    <div id="panel-right-summary"></div>
  </div>
  <div id="panel-bottom" class="panel">
    <h2>断面一覧 / ログ・警告</h2>
    <div id="panel-bottom-content"></div>
  </div>
`;

const store = new ProjectStore(createDefaultProjectData());

const canvas = document.getElementById('viewer-canvas') as HTMLCanvasElement;
const { scene, renderer, bodyGroup } = createScene(canvas);

// 単一マテリアル・単一テクスチャアトラス方式（6.6節）。パーツごとに別マテリアルを
// 割り当てず、全パーツがこの1つの simple3d_main 相当マテリアルを共有する。
let atlasTexture = createAtlasTexture(store.getProject().colors);
const mainMaterial = new THREE.MeshStandardMaterial({ map: atlasTexture });

let lastWarnings: string[] = [];

function rebuildBodyMesh(): void {
  const project = store.getProject();
  bodyGroup.clear();
  const warnings: string[] = [];

  const body = buildBodyMesh(project.body);
  assignSolidUV(body.geometry, ATLAS_PATCHES.body);
  const mesh = new THREE.Mesh(body.geometry, mainMaterial);
  mesh.name = 'body';
  bodyGroup.add(mesh);
  warnings.push(...body.warnings);

  const calyx = buildCalyxMesh(project.calyx, project.body.sections);
  assignSolidUV(calyx.geometry, ATLAS_PATCHES.calyx);
  const calyxMesh = new THREE.Mesh(calyx.geometry, mainMaterial);
  calyxMesh.name = 'calyx';
  bodyGroup.add(calyxMesh);
  warnings.push(...calyx.warnings);

  const stem = buildStemMesh(project.stem, project.body.sections);
  assignSolidUV(stem.geometry, ATLAS_PATCHES.stem);
  const stemMesh = new THREE.Mesh(stem.geometry, mainMaterial);
  stemMesh.name = 'stem';
  bodyGroup.add(stemMesh);
  warnings.push(...stem.warnings);

  const eyes = buildEyeMesh(project.eyes, project.body.sections);
  assignSolidUV(eyes.geometry, ATLAS_PATCHES.eye);
  const eyeMesh = new THREE.Mesh(eyes.geometry, mainMaterial);
  eyeMesh.name = 'eyes';
  bodyGroup.add(eyeMesh);

  const mouth = buildMouthMesh(project.mouth, project.body.sections);
  assignSolidUV(mouth.geometry, ATLAS_PATCHES.mouth);
  const mouthMesh = new THREE.Mesh(mouth.geometry, mainMaterial);
  mouthMesh.name = 'mouth';
  bodyGroup.add(mouthMesh);

  lastWarnings = warnings;
}

let lastPaintedColors = { ...store.getProject().colors };

function rebuildAtlasTexture(): void {
  atlasTexture.dispose();
  atlasTexture = createAtlasTexture(store.getProject().colors);
  mainMaterial.map = atlasTexture;
  mainMaterial.needsUpdate = true;
  lastPaintedColors = { ...store.getProject().colors };
}

/**
 * undo/redo・プロジェクト読込は色を含む全フィールドを一括で戻すため、
 * それらの経路でも色が変わっていればアトラスを再生成する。
 * ただしスライダードラッグ中に毎回テクスチャを作り直すのは重いため、
 * 実際に色が変わったときだけ再生成する。
 */
function syncAtlasIfColorsChanged(): void {
  const colors = store.getProject().colors;
  const changed = (Object.keys(colors) as Array<keyof typeof colors>).some(
    (key) => colors[key] !== lastPaintedColors[key],
  );
  if (changed) rebuildAtlasTexture();
}

const cameraRig = new ViewerCameraRig();
cameraRig.setTarget(new THREE.Vector3(0, 0, store.getProject().body.totalHeight / 2));
cameraRig.setDistance(store.getProject().camera.distanceMm);

const controls = new ViewerControls(
  cameraRig.camera,
  canvas,
  new THREE.Vector3(0, 0, store.getProject().body.totalHeight / 2),
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

const toggleWireframeBtn = document.getElementById('toggle-wireframe') as HTMLButtonElement;
toggleWireframeBtn.addEventListener('click', () => {
  mainMaterial.wireframe = !mainMaterial.wireframe;
  toggleWireframeBtn.classList.toggle('active', mainMaterial.wireframe);
});

const dimReadout = document.getElementById('dim-readout')!;

mountReferencePanel(document.getElementById('panel-reference')!, {
  getProject: () => store.getProject(),
  scene,
  getCamera: () => cameraRig.camera,
  domElement: canvas,
});

const panelCtx: PanelContext = { store };

const mountedPanels: MountedPanel[] = [
  mountProjectPanel(document.getElementById('panel-project')!, panelCtx),
  mountBodyPanel(document.getElementById('panel-body')!, panelCtx),
  mountCalyxPanel(document.getElementById('panel-calyx')!, panelCtx),
  mountStemPanel(document.getElementById('panel-stem')!, panelCtx),
  mountFacePanel(document.getElementById('panel-face')!, panelCtx),
  mountColorPanel(document.getElementById('panel-color')!, panelCtx),
  mountPrintPanel(document.getElementById('panel-print')!, panelCtx),
];

const exportPanelContainer = document.getElementById('panel-export')!;
exportPanelContainer.innerHTML = '<h3 style="margin:8px 0 2px;font-size:12px;color:#555">エクスポート</h3><p style="font-size:11px;color:#888">（次のタスクで実装）</p>';

const rightSummary = document.getElementById('panel-right-summary')!;
const bottomContent = document.getElementById('panel-bottom-content')!;

function updateDerivedPanels(): void {
  const project = store.getProject();
  dimReadout.textContent = `全高: ${formatMm(project.body.totalHeight)}`;

  rightSummary.innerHTML = '';
  const heightLine = document.createElement('div');
  heightLine.textContent = `全高: ${formatMm(project.body.totalHeight)}`;
  rightSummary.appendChild(heightLine);
  const maxRx = Math.max(...project.body.sections.map((s) => s.rx));
  const maxRy = Math.max(...project.body.sections.map((s) => s.ry));
  const widthLine = document.createElement('div');
  widthLine.textContent = `最大幅: ${formatMm(maxRx * 2)} / 最大奥行き: ${formatMm(maxRy * 2)}`;
  rightSummary.appendChild(widthLine);

  if (lastWarnings.length === 0) {
    const ok = document.createElement('div');
    ok.className = 'warning-green';
    ok.textContent = '警告なし';
    rightSummary.appendChild(ok);
  } else {
    for (const w of lastWarnings) {
      const line = document.createElement('div');
      line.className = 'warning-yellow';
      line.textContent = `⚠ ${w}`;
      rightSummary.appendChild(line);
    }
  }

  bottomContent.innerHTML = '';
  const table = document.createElement('table');
  table.style.fontSize = '11px';
  table.style.borderCollapse = 'collapse';
  const header = document.createElement('tr');
  ['t', 'z(mm)', 'rx(mm)', 'ry(mm)', 'n'].forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    th.style.border = '1px solid #ddd';
    th.style.padding = '2px 6px';
    header.appendChild(th);
  });
  table.appendChild(header);
  for (const s of project.body.sections) {
    const tr = document.createElement('tr');
    [s.t.toFixed(2), s.z.toFixed(1), s.rx.toFixed(1), s.ry.toFixed(1), s.n.toFixed(2)].forEach((v) => {
      const td = document.createElement('td');
      td.textContent = v;
      td.style.border = '1px solid #eee';
      td.style.padding = '2px 6px';
      tr.appendChild(td);
    });
    table.appendChild(tr);
  }
  bottomContent.appendChild(table);

  if (lastWarnings.length > 0) {
    const log = document.createElement('div');
    log.style.marginTop = '6px';
    log.innerHTML = lastWarnings.map((w) => `⚠ ${w}`).join('<br>');
    bottomContent.appendChild(log);
  }
}

function onStoreChanged(): void {
  rebuildBodyMesh();
  syncAtlasIfColorsChanged();
  for (const panel of mountedPanels) panel.refresh();
  updateDerivedPanels();
}
store.subscribe(onStoreChanged);

rebuildBodyMesh();
updateDerivedPanels();

window.addEventListener('beforeunload', (e) => {
  if (store.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, cameraRig.camera);
}
animate();
