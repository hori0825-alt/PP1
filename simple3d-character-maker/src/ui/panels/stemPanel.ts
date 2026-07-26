import type { StemParams } from '../../core/params';
import type { PanelContext, MountedPanel } from './context';
import { sliderField, sectionHeading, type Field } from '../widgets';

type StemFieldKey = keyof StemParams;

export function mountStemPanel(container: HTMLElement, ctx: PanelContext): MountedPanel {
  container.innerHTML = '';
  container.appendChild(sectionHeading('茎'));

  const project = ctx.store.getProject();

  function updateField(key: StemFieldKey, value: number): void {
    ctx.store.updateLive((p) => (p.stem[key] = value));
  }

  const make = (
    label: string,
    key: StemFieldKey,
    min: number,
    max: number,
    step: number,
  ): Field<number> => {
    const field = sliderField(
      label,
      project.stem[key],
      min,
      max,
      step,
      () => ctx.store.recordHistorySnapshot(),
      (v) => updateField(key, v),
    );
    container.appendChild(field.el);
    return field;
  };

  const fields: Record<StemFieldKey, Field<number>> = {
    radius: make('半径(mm)', 'radius', 0.5, 10, 0.05),
    length: make('長さ(mm)', 'length', 2, 40, 0.5),
    tilt: make('傾き(deg)', 'tilt', 0, 45, 1),
    squash: make('潰し率', 'squash', 0, 0.6, 0.01),
    distortion: make('断面歪み', 'distortion', 0, 0.5, 0.01),
    embed: make('ヘタ中央への埋め込み(mm)', 'embed', 0, 5, 0.05),
  };

  const warning = document.createElement('div');
  warning.style.fontSize = '11px';
  container.appendChild(warning);

  function updateWarning(): void {
    const r = ctx.store.getProject().stem.radius;
    if (r < 0.8) {
      warning.textContent = `⚠ 半径が危険域です（赤: 0.8mm未満） 現在 ${r.toFixed(2)}mm`;
      warning.className = 'warning-red';
    } else if (r < 1.2) {
      warning.textContent = `⚠ 半径が推奨値未満です（黄: 1.2mm未満） 現在 ${r.toFixed(2)}mm`;
      warning.className = 'warning-yellow';
    } else {
      warning.textContent = '';
      warning.className = '';
    }
  }
  updateWarning();

  function refresh(): void {
    const p = ctx.store.getProject();
    (Object.keys(fields) as StemFieldKey[]).forEach((key) => {
      fields[key].refresh(p.stem[key]);
    });
    updateWarning();
  }

  return { refresh };
}
