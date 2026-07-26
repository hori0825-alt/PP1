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
import { runPrintChecks, type CheckItem } from './inspect/checks';
import { formatCheckReport } from './inspect/report';
import { exportObjText, buildMtlText } from './export/obj';
import { exportStlBinary } from './export/stl';
import { exportGlbBinary } from './export/glb';
import { buildExportZip } from './export/zip';
import { buildReadmePrintText } from './export/readme';
import { serializeProject } from './state/persistence';

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
let lastGeometries: {
  body: THREE.BufferGeometry;
  calyx: THREE.BufferGeometry;
  stem: THREE.BufferGeometry;
  eye: THREE.BufferGeometry;
  mouth: THREE.BufferGeometry;
} | null = null;

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
  lastGeometries = {
    body: body.geometry,
    calyx: calyx.geometry,
    stem: stem.geometry,
    eye: eyes.geometry,
    mouth: mouth.geometry,
  };
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

const rightSummary = document.getElementById('panel-right-summary')!;
const bottomContent = document.getElementById('panel-bottom-content')!;

const SEVERITY_CLASS: Record<CheckItem['severity'], string> = {
  red: 'warning-red',
  yellow: 'warning-yellow',
  green: 'warning-green',
};
const SEVERITY_MARK: Record<CheckItem['severity'], string> = { red: '●', yellow: '●', green: '●' };

let lastCheckResults: CheckItem[] = [];

/** 現在の3パーツジオメトリに対して6.8節の検査を実行する。 */
function runChecksNow(): CheckItem[] {
  if (!lastGeometries) return [];
  const project = store.getProject();
  lastCheckResults = runPrintChecks({
    bodyGeometry: lastGeometries.body,
    calyxGeometry: lastGeometries.calyx,
    stemGeometry: lastGeometries.stem,
    eyeGeometry: lastGeometries.eye,
    mouthGeometry: lastGeometries.mouth,
    project,
    textureReady: true,
  });
  return lastCheckResults;
}

let checkDebounceTimer: number | undefined;
function scheduleChecksDebounced(): void {
  window.clearTimeout(checkDebounceTimer);
  // パラメータ変更後500msのデバウンスで検査する（6.8節）。常時は実行しない。
  checkDebounceTimer = window.setTimeout(() => {
    runChecksNow();
    renderCheckLists();
  }, 500);
}

function renderCheckLists(): void {
  rightSummary.querySelectorAll('.check-item').forEach((el) => el.remove());
  const nonGreen = lastCheckResults.filter((r) => r.severity !== 'green');
  const summaryHeading = document.createElement('div');
  summaryHeading.className = 'check-item';
  summaryHeading.style.marginTop = '6px';
  summaryHeading.style.fontWeight = 'bold';
  summaryHeading.textContent = '印刷検査（要注意項目）';
  rightSummary.appendChild(summaryHeading);
  if (nonGreen.length === 0) {
    const ok = document.createElement('div');
    ok.className = 'check-item warning-green';
    ok.textContent = '● 警告なし';
    rightSummary.appendChild(ok);
  } else {
    for (const r of nonGreen) {
      const line = document.createElement('div');
      line.className = `check-item ${SEVERITY_CLASS[r.severity]}`;
      line.textContent = `${SEVERITY_MARK[r.severity]} ${r.label}: ${r.message}`;
      rightSummary.appendChild(line);
    }
  }

  const logContainer = bottomContent.querySelector('#check-log')!;
  logContainer.innerHTML = '';
  for (const r of lastCheckResults) {
    const line = document.createElement('div');
    line.className = SEVERITY_CLASS[r.severity];
    line.textContent = `${SEVERITY_MARK[r.severity]} ${r.label}: ${r.message}`;
    logContainer.appendChild(line);
  }
}

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

  if (lastWarnings.length > 0) {
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

  const logHeading = document.createElement('div');
  logHeading.style.marginTop = '6px';
  logHeading.style.fontWeight = 'bold';
  logHeading.textContent = '印刷検査ログ（6.8節・パラメータ変更後500msでデバウンス実行）';
  bottomContent.appendChild(logHeading);
  const logContainer = document.createElement('div');
  logContainer.id = 'check-log';
  bottomContent.appendChild(logContainer);

  renderCheckLists();
}

async function getAtlasPngBytes(): Promise<Uint8Array> {
  const sourceCanvas = atlasTexture.image as HTMLCanvasElement;
  const blob = await new Promise<Blob | null>((resolve) => sourceCanvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('テクスチャの PNG 変換に失敗しました');
  return new Uint8Array(await blob.arrayBuffer());
}

const exportStatusEl = document.createElement('div');
exportStatusEl.style.fontSize = '11px';
exportStatusEl.style.marginTop = '4px';

async function handleExportZip(): Promise<void> {
  const project = store.getProject();
  const results = runChecksNow();
  renderCheckLists();

  exportStatusEl.textContent = '書き出し中…';
  try {
    const objText = exportObjText(bodyGroup);
    const mtlText = buildMtlText();
    const stlBuffer = exportStlBinary(bodyGroup);
    const glbBuffer = await exportGlbBinary(bodyGroup, project.exportSettings.glbMmZUp);
    const pngBytes = await getAtlasPngBytes();
    const printCheckText = formatCheckReport(results);
    const readmeText = buildReadmePrintText(project);
    const projectJson = serializeProject(project);

    const zipBytes = buildExportZip({
      objText,
      mtlText,
      pngBytes,
      glbBytes: new Uint8Array(glbBuffer),
      stlBytes: new Uint8Array(stlBuffer),
      projectJson,
      printCheckText,
      readmeText,
    });

    const blob = new Blob([zipBytes as BlobPart], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.exportSettings.fileNamePrefix || 'model'}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    store.markSaved();
    exportStatusEl.textContent = `書き出し完了（赤 ${results.filter((r) => r.severity === 'red').length} 件 / 黄 ${results.filter((r) => r.severity === 'yellow').length} 件）`;
  } catch (err) {
    exportStatusEl.textContent = `書き出しに失敗しました: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const exportPanelContainer = document.getElementById('panel-export')!;
exportPanelContainer.innerHTML = '';
{
  const heading = document.createElement('h3');
  heading.style.margin = '8px 0 2px';
  heading.style.fontSize = '12px';
  heading.style.color = '#555';
  heading.textContent = 'エクスポート';
  exportPanelContainer.appendChild(heading);

  const note = document.createElement('div');
  note.style.fontSize = '11px';
  note.style.color = '#888';
  note.textContent = 'model.obj / model.mtl / texture.png / model.glb / model.stl / project.json / print_check.txt / README_print.txt を ZIP でまとめて出力します。';
  exportPanelContainer.appendChild(note);

  const exportBtn = document.createElement('button');
  exportBtn.textContent = 'ZIP をエクスポート';
  exportBtn.style.display = 'block';
  exportBtn.style.marginTop = '4px';
  exportBtn.addEventListener('click', () => {
    void handleExportZip();
  });
  exportPanelContainer.appendChild(exportBtn);
  exportPanelContainer.appendChild(exportStatusEl);
}

function onStoreChanged(): void {
  rebuildBodyMesh();
  syncAtlasIfColorsChanged();
  for (const panel of mountedPanels) panel.refresh();
  updateDerivedPanels();
  scheduleChecksDebounced();
}
store.subscribe(onStoreChanged);

rebuildBodyMesh();
updateDerivedPanels();
runChecksNow();
renderCheckLists();

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
