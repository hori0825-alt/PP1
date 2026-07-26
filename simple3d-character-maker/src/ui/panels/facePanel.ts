import type { EyeParams, MouthParams, MouthPreset } from '../../core/params';
import type { PanelContext, MountedPanel } from './context';
import { sliderField, selectField, sectionHeading, type Field } from '../widgets';

type EyeFieldKey = keyof EyeParams;
type MouthNumberKey = Exclude<keyof MouthParams, 'preset'>;

const MOUTH_PRESETS: readonly MouthPreset[] = ['soft', 'strong', 'line', 'none'];

export function mountFacePanel(container: HTMLElement, ctx: PanelContext): MountedPanel {
  container.innerHTML = '';
  container.appendChild(sectionHeading('顔 - 目'));

  const project = ctx.store.getProject();

  function updateEye(key: EyeFieldKey, value: number): void {
    ctx.store.updateLive((p) => (p.eyes[key] = value));
  }

  const makeEye = (label: string, key: EyeFieldKey, min: number, max: number, step: number): Field<number> => {
    const field = sliderField(
      label,
      project.eyes[key],
      min,
      max,
      step,
      () => ctx.store.recordHistorySnapshot(),
      (v) => updateEye(key, v),
    );
    container.appendChild(field.el);
    return field;
  };

  const eyeFields: Record<EyeFieldKey, Field<number>> = {
    spacing: makeEye('左右間隔(mm)', 'spacing', 1, 30, 0.1),
    height: makeEye('高さ位置(本体t)', 'height', 0, 1, 0.01),
    sizeX: makeEye('横サイズ(mm)', 'sizeX', 0.3, 8, 0.1),
    sizeY: makeEye('縦サイズ(mm)', 'sizeY', 0.3, 8, 0.1),
    tilt: makeEye('傾き(deg)', 'tilt', -45, 45, 1),
    relief: makeEye('盛り上がり(mm)', 'relief', 0, 0.8, 0.02),
  };

  container.appendChild(sectionHeading('顔 - 口'));

  const presetField = selectField('プリセット', project.mouth.preset, MOUTH_PRESETS, (v) =>
    ctx.store.updateWithHistory((p) => (p.mouth.preset = v)),
  );
  container.appendChild(presetField.el);

  function updateMouth(key: MouthNumberKey, value: number): void {
    ctx.store.updateLive((p) => (p.mouth[key] = value));
  }

  const makeMouth = (label: string, key: MouthNumberKey, min: number, max: number, step: number): Field<number> => {
    const field = sliderField(
      label,
      project.mouth[key],
      min,
      max,
      step,
      () => ctx.store.recordHistorySnapshot(),
      (v) => updateMouth(key, v),
    );
    container.appendChild(field.el);
    return field;
  };

  const mouthFields: Record<MouthNumberKey, Field<number>> = {
    width: makeMouth('幅(mm)', 'width', 1, 20, 0.1),
    curveHeight: makeMouth('カーブの高さ(mm)', 'curveHeight', 0, 6, 0.1),
    thickness: makeMouth('太さ(mm)', 'thickness', 0.3, 4, 0.1),
    relief: makeMouth('盛り上げ(+)/彫り込み(-)(mm)', 'relief', -1, 1, 0.02),
    height: makeMouth('高さ位置(本体t)', 'height', 0, 1, 0.01),
  };

  const note = document.createElement('div');
  note.style.fontSize = '11px';
  note.style.color = '#888';
  note.textContent = '※ 彫り込み(relief<0)はPhase1では見た目のみです（実際のブーリアン減算はPhase1.5）。';
  container.appendChild(note);

  function refresh(): void {
    const p = ctx.store.getProject();
    (Object.keys(eyeFields) as EyeFieldKey[]).forEach((key) => eyeFields[key].refresh(p.eyes[key]));
    presetField.refresh(p.mouth.preset);
    (Object.keys(mouthFields) as MouthNumberKey[]).forEach((key) => mouthFields[key].refresh(p.mouth[key]));
  }

  return { refresh };
}
