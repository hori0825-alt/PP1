import * as THREE from 'three';
import type { ProjectData, ReferenceImage } from '../core/params';
import {
  createReferencePlane,
  computeCalibrationScale,
  type ReferencePlaneHandle,
} from '../viewer/overlay';

export interface ReferencePanelDeps {
  getProject: () => ProjectData;
  scene: THREE.Scene;
  getCamera: () => THREE.Camera;
  domElement: HTMLElement;
  onChange?: () => void;
}

const VIEWS: Array<{ view: ReferenceImage['view']; label: string }> = [
  { view: 'front', label: '正面' },
  { view: 'side', label: '側面' },
  { view: 'top', label: '上面' },
];

interface CalibrationState {
  ref: ReferenceImage;
  handle: ReferencePlaneHandle;
  points: THREE.Vector2[];
}

export function mountReferencePanel(container: HTMLElement, deps: ReferencePanelDeps): void {
  const handles = new Map<ReferenceImage, ReferencePlaneHandle>();
  let calibration: CalibrationState | null = null;
  const raycaster = new THREE.Raycaster();

  function findRef(view: ReferenceImage['view']): ReferenceImage | undefined {
    return deps.getProject().referenceImages.find((r) => r.view === view);
  }

  async function syncPlane(ref: ReferenceImage): Promise<void> {
    const existing = handles.get(ref);
    if (existing) {
      existing.update(ref);
      return;
    }
    const handle = await createReferencePlane(ref);
    handles.set(ref, handle);
    deps.scene.add(handle.carrier);
  }

  function removePlane(ref: ReferenceImage): void {
    const handle = handles.get(ref);
    if (handle) {
      deps.scene.remove(handle.carrier);
      handle.dispose();
      handles.delete(ref);
    }
  }

  function notifyChange(): void {
    deps.onChange?.();
    render();
  }

  function onCanvasClick(event: MouseEvent): void {
    if (!calibration) return;
    const rect = deps.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, deps.getCamera());
    const hits = raycaster.intersectObject(calibration.handle.mesh, false);
    const hit = hits[0];
    if (!hit || !hit.uv) return;

    calibration.points.push(hit.uv.clone());
    if (calibration.points.length >= 2) {
      const [p1, p2] = calibration.points;
      const state = calibration;
      calibration = null;
      deps.domElement.style.cursor = '';
      const input = window.prompt('クリックした2点間の実寸をmmで入力してください（例: 50）');
      const realLengthMm = input ? Number.parseFloat(input) : NaN;
      if (Number.isFinite(realLengthMm) && realLengthMm > 0) {
        try {
          const { scale } = computeCalibrationScale(
            p1!,
            p2!,
            state.handle.imageWidthPx,
            state.handle.imageHeightPx,
            realLengthMm,
          );
          state.ref.scale = scale;
          state.ref.calibration = {
            p1: { x: p1!.x, y: p1!.y },
            p2: { x: p2!.x, y: p2!.y },
            realLengthMm,
          };
          void syncPlane(state.ref);
          notifyChange();
        } catch (err) {
          window.alert(err instanceof Error ? err.message : String(err));
        }
      }
    }
  }
  deps.domElement.addEventListener('click', onCanvasClick);

  function startCalibration(ref: ReferenceImage): void {
    const handle = handles.get(ref);
    if (!handle) return;
    calibration = { ref, handle, points: [] };
    deps.domElement.style.cursor = 'crosshair';
    window.alert('画像上で実寸が分かっている2点をクリックしてください。');
  }

  function handleFile(view: ReferenceImage['view'], file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const existingIndex = deps.getProject().referenceImages.findIndex((r) => r.view === view);
      const ref: ReferenceImage = {
        view,
        dataUrl,
        visible: true,
        opacity: 0.5,
        scale: 1,
        offset: { x: 0, y: 0 },
        rotation: 0,
        flipX: false,
        locked: false,
      };
      if (existingIndex >= 0) {
        const old = deps.getProject().referenceImages[existingIndex]!;
        removePlane(old);
        deps.getProject().referenceImages[existingIndex] = ref;
      } else {
        deps.getProject().referenceImages.push(ref);
      }
      void syncPlane(ref).then(notifyChange);
    };
    reader.readAsDataURL(file);
  }

  function render(): void {
    container.innerHTML = '';
    const heading = document.createElement('h2');
    heading.textContent = '参照画像';
    container.appendChild(heading);

    for (const { view, label } of VIEWS) {
      const ref = findRef(view);
      const section = document.createElement('div');
      section.className = 'ref-section';

      const title = document.createElement('div');
      title.textContent = label;
      title.style.fontWeight = 'bold';
      section.appendChild(title);

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) handleFile(view, file);
      });
      section.appendChild(fileInput);

      if (ref) {
        void syncPlane(ref);

        section.appendChild(
          makeCheckboxRow('表示', ref.visible, (v) => {
            ref.visible = v;
            void syncPlane(ref).then(notifyChange);
          }),
        );
        section.appendChild(
          makeRangeRow('不透明度', ref.opacity, 0, 1, 0.01, (v) => {
            ref.opacity = v;
            void syncPlane(ref).then(notifyChange);
          }),
        );
        section.appendChild(
          makeNumberRow('拡大率', ref.scale, (v) => {
            ref.scale = v;
            void syncPlane(ref).then(notifyChange);
          }),
        );
        section.appendChild(
          makeNumberRow('Xオフセット(mm)', ref.offset.x, (v) => {
            ref.offset.x = v;
            void syncPlane(ref).then(notifyChange);
          }),
        );
        section.appendChild(
          makeNumberRow('Yオフセット(mm)', ref.offset.y, (v) => {
            ref.offset.y = v;
            void syncPlane(ref).then(notifyChange);
          }),
        );
        section.appendChild(
          makeNumberRow('回転(deg)', ref.rotation, (v) => {
            ref.rotation = v;
            void syncPlane(ref).then(notifyChange);
          }),
        );
        section.appendChild(
          makeCheckboxRow('左右反転', ref.flipX, (v) => {
            ref.flipX = v;
            void syncPlane(ref).then(notifyChange);
          }),
        );
        section.appendChild(
          makeCheckboxRow('ロック', ref.locked, (v) => {
            ref.locked = v;
          }),
        );

        const calibrateBtn = document.createElement('button');
        calibrateBtn.textContent = 'キャリブレーション（2点+実寸mm）';
        calibrateBtn.addEventListener('click', () => startCalibration(ref));
        section.appendChild(calibrateBtn);

        if (ref.calibration) {
          const info = document.createElement('div');
          info.textContent = `実寸基準: ${ref.calibration.realLengthMm}mm`;
          info.style.fontSize = '11px';
          section.appendChild(info);
        }
      }

      container.appendChild(section);
    }
  }

  render();
}

function makeCheckboxRow(
  label: string,
  value: boolean,
  onChange: (v: boolean) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  row.appendChild(labelEl);
  row.appendChild(input);
  return row;
}

function makeRangeRow(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field-row';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => onChange(Number.parseFloat(input.value)));
  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  row.appendChild(labelEl);
  row.appendChild(input);
  return row;
}

function makeNumberRow(label: string, value: number, onChange: (v: number) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field-row';
  const input = document.createElement('input');
  input.type = 'number';
  input.value = String(value);
  input.step = '0.1';
  input.addEventListener('change', () => onChange(Number.parseFloat(input.value)));
  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  row.appendChild(labelEl);
  row.appendChild(input);
  return row;
}
