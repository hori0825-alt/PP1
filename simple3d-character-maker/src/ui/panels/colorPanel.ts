import type { ColorParams } from '../../core/params';
import type { PanelContext, MountedPanel } from './context';
import { colorField, sectionHeading, type Field } from '../widgets';

type ColorKey = keyof ColorParams;
const LABELS: Record<ColorKey, string> = {
  body: '本体',
  calyx: 'ヘタ',
  stem: '茎',
  eye: '目',
  mouth: '口',
};

export function mountColorPanel(container: HTMLElement, ctx: PanelContext): MountedPanel {
  container.innerHTML = '';
  container.appendChild(sectionHeading('色'));

  const project = ctx.store.getProject();
  const fields: Record<ColorKey, Field<string>> = {} as Record<ColorKey, Field<string>>;

  (Object.keys(LABELS) as ColorKey[]).forEach((key) => {
    const field = colorField(LABELS[key], project.colors[key], (v) => {
      ctx.store.updateWithHistory((p) => (p.colors[key] = v));
    });
    container.appendChild(field.el);
    fields[key] = field;
  });

  function refresh(): void {
    const p = ctx.store.getProject();
    (Object.keys(fields) as ColorKey[]).forEach((key) => fields[key].refresh(p.colors[key]));
  }

  return { refresh };
}
