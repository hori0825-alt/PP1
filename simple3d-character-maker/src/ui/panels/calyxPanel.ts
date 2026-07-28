import type { PanelContext, MountedPanel } from './context';
import { sliderField, checkboxField, sectionHeading, type Field } from '../widgets';

// pitch/curvature は現在のドーム形状生成では未使用（将来拡張用に予約）のため
// UI には出さない。
type LeafFieldKey = 'angle' | 'length' | 'width' | 'thickness' | 'embed';

export function mountCalyxPanel(container: HTMLElement, ctx: PanelContext): MountedPanel {
  container.innerHTML = '';
  container.appendChild(sectionHeading('ヘタ（5枚）'));

  const project = ctx.store.getProject();

  const baseTField = sliderField(
    '本体上の高さ位置 baseT',
    project.calyx.baseT,
    0,
    1,
    0.01,
    () => ctx.store.recordHistorySnapshot(),
    (v) => {
      ctx.store.updateLive((p) => (p.calyx.baseT = v));
    },
  );
  container.appendChild(baseTField.el);

  const symmetricField = checkboxField(
    '左右対称（全葉を同じ値にする）',
    project.calyx.symmetric,
    (v) => ctx.store.updateWithHistory((p) => (p.calyx.symmetric = v)),
  );
  container.appendChild(symmetricField.el);

  function updateLeafField(index: number, key: LeafFieldKey, value: number): void {
    ctx.store.updateLive((p) => {
      if (p.calyx.symmetric) {
        for (const leaf of p.calyx.leaves) leaf[key] = value;
      } else {
        p.calyx.leaves[index]![key] = value;
      }
    });
  }

  const leafFields: Array<Record<LeafFieldKey, Field<number>>> = [];

  project.calyx.leaves.forEach((leaf, index) => {
    const box = document.createElement('div');
    box.style.border = '1px solid #ddd';
    box.style.borderRadius = '4px';
    box.style.padding = '4px';
    box.style.margin = '4px 0';
    const title = document.createElement('div');
    title.textContent = `葉 ${index + 1}（角度 ${leaf.angle.toFixed(0)}°）`;
    title.style.fontSize = '11px';
    title.style.color = '#666';
    box.appendChild(title);

    const make = (
      label: string,
      key: LeafFieldKey,
      min: number,
      max: number,
      step: number,
    ): Field<number> => {
      const field = sliderField(
        label,
        leaf[key],
        min,
        max,
        step,
        () => ctx.store.recordHistorySnapshot(),
        (v) => updateLeafField(index, key, v),
      );
      box.appendChild(field.el);
      return field;
    };

    const fields: Record<LeafFieldKey, Field<number>> = {
      angle: make('方位角(deg)', 'angle', 0, 360, 1),
      length: make('谷のくびれの広さ(mm)', 'length', 0, 8, 0.25),
      width: make('裂片先端までの半径(mm)', 'width', 2, 14, 0.25),
      thickness: make('盛り上がり高さ(mm)', 'thickness', 0.3, 6, 0.1),
      embed: make('本体への埋め込み(mm)', 'embed', 0, 4, 0.05),
    };
    leafFields.push(fields);
    container.appendChild(box);
  });

  function refresh(): void {
    const p = ctx.store.getProject();
    baseTField.refresh(p.calyx.baseT);
    symmetricField.refresh(p.calyx.symmetric);
    p.calyx.leaves.forEach((leaf, i) => {
      const fields = leafFields[i];
      if (!fields) return;
      (Object.keys(fields) as LeafFieldKey[]).forEach((key) => {
        fields[key].refresh(leaf[key]);
      });
    });
  }

  return { refresh };
}
