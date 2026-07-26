import type { PanelContext, MountedPanel } from './context';
import { numberField, sliderField, checkboxField, sectionHeading, type Field } from '../widgets';
import { drawContourGraph } from '../graphs/contourGraph';

export function mountBodyPanel(container: HTMLElement, ctx: PanelContext): MountedPanel {
  container.innerHTML = '';
  container.appendChild(sectionHeading('本体'));

  const project = ctx.store.getProject();

  const totalHeightField = numberField(
    '全高(mm)',
    project.body.totalHeight,
    (v) => ctx.store.updateWithHistory((p) => (p.body.totalHeight = v)),
    { min: 5, max: 500 },
  );
  container.appendChild(totalHeightField.el);

  const flatBottomField = numberField(
    '底面平坦化(mm)',
    project.body.flatBottomHeight,
    (v) => ctx.store.updateWithHistory((p) => (p.body.flatBottomHeight = v)),
    { min: 0, max: 10 },
  );
  container.appendChild(flatBottomField.el);

  const symmetricField = checkboxField('左右対称ロック', project.body.symmetricX, (v) =>
    ctx.store.updateWithHistory((p) => (p.body.symmetricX = v)),
  );
  container.appendChild(symmetricField.el);

  container.appendChild(sectionHeading('断面表（t固定・各値をドラッグ調整）'));

  const sectionFields: Array<{
    rx: Field<number>;
    ry: Field<number>;
    cx: Field<number>;
    cy: Field<number>;
    n: Field<number>;
  }> = [];

  project.body.sections.forEach((section, index) => {
    const box = document.createElement('div');
    box.style.border = '1px solid #ddd';
    box.style.borderRadius = '4px';
    box.style.padding = '4px';
    box.style.margin = '4px 0';

    const title = document.createElement('div');
    title.textContent = `t=${section.t.toFixed(2)}（z=${section.z.toFixed(1)}mm）`;
    title.style.fontSize = '11px';
    title.style.color = '#666';
    box.appendChild(title);

    const rx = sliderField(
      '幅rx(mm)',
      section.rx,
      0,
      40,
      0.1,
      () => ctx.store.recordHistorySnapshot(),
      (v) => {
        ctx.store.updateLive((p) => (p.body.sections[index]!.rx = v));
      },
    );
    const ry = sliderField(
      '奥行きry(mm)',
      section.ry,
      0,
      40,
      0.1,
      () => ctx.store.recordHistorySnapshot(),
      (v) => {
        ctx.store.updateLive((p) => (p.body.sections[index]!.ry = v));
      },
    );
    const cx = sliderField(
      'X中心オフセット(mm)',
      section.cx,
      -20,
      20,
      0.1,
      () => ctx.store.recordHistorySnapshot(),
      (v) => {
        ctx.store.updateLive((p) => (p.body.sections[index]!.cx = v));
      },
    );
    const cy = sliderField(
      'Y中心オフセット(mm)',
      section.cy,
      -20,
      20,
      0.1,
      () => ctx.store.recordHistorySnapshot(),
      (v) => {
        ctx.store.updateLive((p) => (p.body.sections[index]!.cy = v));
      },
    );
    const n = sliderField(
      '丸み(スーパー楕円指数)',
      section.n,
      1.5,
      4.0,
      0.05,
      () => ctx.store.recordHistorySnapshot(),
      (v) => {
        ctx.store.updateLive((p) => (p.body.sections[index]!.n = v));
      },
    );

    box.appendChild(rx.el);
    box.appendChild(ry.el);
    box.appendChild(cx.el);
    box.appendChild(cy.el);
    box.appendChild(n.el);
    container.appendChild(box);

    sectionFields.push({ rx, ry, cx, cy, n });
  });

  container.appendChild(sectionHeading('輪郭グラフ（正面=rx, 側面=ry）'));
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 160;
  canvas.style.width = '100%';
  canvas.style.background = '#fff';
  canvas.style.border = '1px solid #ddd';
  container.appendChild(canvas);

  function redrawGraph(): void {
    drawContourGraph(canvas, ctx.store.getProject().body);
  }
  redrawGraph();

  function refresh(): void {
    const p = ctx.store.getProject();
    totalHeightField.refresh(p.body.totalHeight);
    flatBottomField.refresh(p.body.flatBottomHeight);
    symmetricField.refresh(p.body.symmetricX);
    p.body.sections.forEach((s, i) => {
      const f = sectionFields[i];
      if (!f) return;
      f.rx.refresh(s.rx);
      f.ry.refresh(s.ry);
      f.cx.refresh(s.cx);
      f.cy.refresh(s.cy);
      f.n.refresh(s.n);
    });
    redrawGraph();
  }

  return { refresh };
}
