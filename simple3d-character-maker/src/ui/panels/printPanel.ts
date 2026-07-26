import type { PrintSettings } from '../../core/params';
import type { PanelContext, MountedPanel } from './context';
import { numberField, sectionHeading, type Field } from '../widgets';

type PrintKey = keyof PrintSettings;

export function mountPrintPanel(container: HTMLElement, ctx: PanelContext): MountedPanel {
  container.innerHTML = '';
  container.appendChild(sectionHeading('印刷設定'));

  const note = document.createElement('div');
  note.style.fontSize = '11px';
  note.style.color = '#888';
  note.textContent =
    'TODO(未決事項#2): 業者指定の最小肉厚・最小径が未確定のため、下記は暫定値です。';
  container.appendChild(note);

  const project = ctx.store.getProject();

  const make = (label: string, key: PrintKey, min: number, max: number): Field<number> => {
    const field = numberField(
      label,
      project.printSettings[key],
      (v) => ctx.store.updateWithHistory((p) => (p.printSettings[key] = v)),
      { min, max, step: 0.1 },
    );
    container.appendChild(field.el);
    return field;
  };

  const fields: Record<PrintKey, Field<number>> = {
    minWallThicknessMm: make('最小肉厚 参考値(mm)', 'minWallThicknessMm', 0.5, 10),
    minStemRadiusMm: make('茎の最小半径 黄警告閾値(mm)', 'minStemRadiusMm', 0.3, 5),
    minCalyxEmbedMm: make('ヘタの最小埋め込み(mm)', 'minCalyxEmbedMm', 0.2, 3),
  };

  function refresh(): void {
    const p = ctx.store.getProject();
    (Object.keys(fields) as PrintKey[]).forEach((key) => fields[key].refresh(p.printSettings[key]));
  }

  return { refresh };
}
