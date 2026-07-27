import type { BodySection, CowLegParams, CowParams } from '../../core/params';
import type { PanelContext, MountedPanel } from './context';
import { colorField, numberField, sliderField, sectionHeading, type Field } from '../widgets';

type SectionFieldSet = { rx: Field<number>; ry: Field<number>; cx: Field<number>; n: Field<number> };

/** BodySection[] を胴体/頭で共通に編集する小さなセクション表を作る。 */
function mountSectionTable(
  container: HTMLElement,
  ctx: PanelContext,
  getSections: (cow: CowParams) => BodySection[],
): SectionFieldSet[] {
  const project = ctx.store.getProject();
  const sections = getSections(project.cow);
  const fields: SectionFieldSet[] = [];

  sections.forEach((section, index) => {
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

    const make = (label: string, key: 'rx' | 'ry' | 'cx' | 'n', min: number, max: number, step: number): Field<number> => {
      const field = sliderField(
        label,
        section[key],
        min,
        max,
        step,
        () => ctx.store.recordHistorySnapshot(),
        (v) => {
          ctx.store.updateLive((p) => {
            getSections(p.cow)[index]![key] = v;
          });
        },
      );
      box.appendChild(field.el);
      return field;
    };

    const rowFields: SectionFieldSet = {
      rx: make('幅rx(mm)', 'rx', 0, 25, 0.1),
      ry: make('奥行きry(mm)', 'ry', 0, 25, 0.1),
      cx: make('X中心オフセット(mm)', 'cx', -10, 10, 0.1),
      n: make('丸み(スーパー楕円指数)', 'n', 1.5, 4.0, 0.05),
    };
    fields.push(rowFields);
    container.appendChild(box);
  });

  return fields;
}

function refreshSectionTable(
  fields: SectionFieldSet[],
  sections: BodySection[],
): void {
  sections.forEach((s, i) => {
    const f = fields[i];
    if (!f) return;
    f.rx.refresh(s.rx);
    f.ry.refresh(s.ry);
    f.cx.refresh(s.cx);
    f.n.refresh(s.n);
  });
}

function mountLegGroup(
  container: HTMLElement,
  ctx: PanelContext,
  title: string,
  which: 'front' | 'back',
): Record<keyof CowLegParams, Field<number>> {
  const box = document.createElement('div');
  box.style.border = '1px solid #ddd';
  box.style.borderRadius = '4px';
  box.style.padding = '4px';
  box.style.margin = '4px 0';
  const heading = document.createElement('div');
  heading.textContent = title;
  heading.style.fontSize = '11px';
  heading.style.color = '#666';
  box.appendChild(heading);

  const project = ctx.store.getProject();
  const leg = project.cow.legs[which];

  const make = (
    label: string,
    key: keyof CowLegParams,
    min: number,
    max: number,
    step: number,
  ): Field<number> => {
    const field = sliderField(
      label,
      leg[key],
      min,
      max,
      step,
      () => ctx.store.recordHistorySnapshot(),
      (v) => {
        ctx.store.updateLive((p) => (p.cow.legs[which][key] = v));
      },
    );
    box.appendChild(field.el);
    return field;
  };

  const fields: Record<keyof CowLegParams, Field<number>> = {
    radius: make('太さ(mm)', 'radius', 0.3, 10, 0.1),
    length: make('長さ(mm)', 'length', 1, 30, 0.5),
    distortion: make('断面歪み', 'distortion', 0, 0.5, 0.01),
    squash: make('潰し率', 'squash', 0, 0.5, 0.01),
    embed: make('本体への埋め込み(mm)', 'embed', 0, 5, 0.1),
  };
  container.appendChild(box);
  return fields;
}

export function mountCowPanel(container: HTMLElement, ctx: PanelContext): MountedPanel {
  container.innerHTML = '';
  container.appendChild(sectionHeading('牛'));

  const project = ctx.store.getProject();

  // ---- 胴体 ----
  container.appendChild(sectionHeading('胴体（断面表）'));
  const torsoFields = mountSectionTable(container, ctx, (cow) => cow.torso.sections);

  // ---- 頭 ----
  container.appendChild(sectionHeading('頭（断面表）'));
  const headTiltField = sliderField(
    '首の傾き(deg)',
    project.cow.head.tilt,
    -30,
    60,
    1,
    () => ctx.store.recordHistorySnapshot(),
    (v) => ctx.store.updateLive((p) => (p.cow.head.tilt = v)),
  );
  container.appendChild(headTiltField.el);
  const headFields = mountSectionTable(container, ctx, (cow) => cow.head.sections);

  // ---- 脚 ----
  container.appendChild(sectionHeading('脚'));
  const frontLegFields = mountLegGroup(container, ctx, '前脚', 'front');
  const backLegFields = mountLegGroup(container, ctx, '後脚', 'back');
  const legSpacingField = sliderField(
    '左右の間隔(mm)',
    project.cow.legs.spacingX,
    2,
    30,
    0.5,
    () => ctx.store.recordHistorySnapshot(),
    (v) => ctx.store.updateLive((p) => (p.cow.legs.spacingX = v)),
  );
  container.appendChild(legSpacingField.el);
  const frontTField = sliderField(
    '前脚の位置(胴体上のt)',
    project.cow.legs.frontT,
    0,
    1,
    0.01,
    () => ctx.store.recordHistorySnapshot(),
    (v) => ctx.store.updateLive((p) => (p.cow.legs.frontT = v)),
  );
  container.appendChild(frontTField.el);
  const backTField = sliderField(
    '後脚の位置(胴体上のt)',
    project.cow.legs.backT,
    0,
    1,
    0.01,
    () => ctx.store.recordHistorySnapshot(),
    (v) => ctx.store.updateLive((p) => (p.cow.legs.backT = v)),
  );
  container.appendChild(backTField.el);

  // ---- 耳 ----
  container.appendChild(sectionHeading('耳'));
  const earFields = {
    sizeX: sliderField('横幅(mm)', project.cow.ears.sizeX, 1, 10, 0.1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.ears.sizeX = v))),
    sizeY: sliderField('縦幅(mm)', project.cow.ears.sizeY, 1, 10, 0.1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.ears.sizeY = v))),
    tilt: sliderField('傾き(deg)', project.cow.ears.tilt, -60, 60, 1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.ears.tilt = v))),
    relief: sliderField('盛り上がり(mm)', project.cow.ears.relief, 0, 4, 0.05, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.ears.relief = v))),
    attachHeight: sliderField('取り付け位置(頭上のt)', project.cow.ears.attachHeight, 0, 1, 0.01, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.ears.attachHeight = v))),
    spacing: sliderField('側面からの角度バイアス(deg)', project.cow.ears.spacing, 0, 89, 1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.ears.spacing = v))),
  };
  Object.values(earFields).forEach((f) => container.appendChild(f.el));

  // ---- 角 ----
  container.appendChild(sectionHeading('角'));
  const hornFields = {
    length: sliderField('長さ(mm)', project.cow.horns.length, 1, 20, 0.5, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.horns.length = v))),
    radiusStart: sliderField('根元の太さ(mm)', project.cow.horns.radiusStart, 0.3, 6, 0.1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.horns.radiusStart = v))),
    radiusEnd: sliderField('先端の太さ(mm)', project.cow.horns.radiusEnd, 0.3, 6, 0.1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.horns.radiusEnd = v))),
    tilt: sliderField('外向き＋上向きの角度(deg)', project.cow.horns.tilt, 0, 80, 1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.horns.tilt = v))),
    attachHeight: sliderField('取り付け位置(頭上のt)', project.cow.horns.attachHeight, 0, 1, 0.01, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.horns.attachHeight = v))),
    spacing: sliderField('側面からの角度バイアス(deg)', project.cow.horns.spacing, 0, 89, 1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.horns.spacing = v))),
  };
  Object.values(hornFields).forEach((f) => container.appendChild(f.el));

  // ---- しっぽ ----
  container.appendChild(sectionHeading('しっぽ'));
  const tailFields = {
    radius: sliderField('太さ(mm)', project.cow.tail.radius, 0.3, 6, 0.1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.tail.radius = v))),
    length: sliderField('長さ(mm)', project.cow.tail.length, 2, 30, 0.5, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.tail.length = v))),
    tilt: sliderField('垂れ角度(deg)', project.cow.tail.tilt, 0, 80, 1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.tail.tilt = v))),
    distortion: sliderField('断面歪み', project.cow.tail.distortion, 0, 0.5, 0.01, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.tail.distortion = v))),
    tuftSize: sliderField('先端房の大きさ(mm)', project.cow.tail.tuftSize, 0.5, 6, 0.1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.tail.tuftSize = v))),
  };
  Object.values(tailFields).forEach((f) => container.appendChild(f.el));

  // ---- 目 ----
  container.appendChild(sectionHeading('目'));
  const eyeFields = {
    spacing: sliderField('側面からの角度バイアス(deg)', project.cow.eyes.spacing, 0, 89, 1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.eyes.spacing = v))),
    height: sliderField('取り付け位置(頭上のt)', project.cow.eyes.height, 0, 1, 0.01, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.eyes.height = v))),
    sizeX: sliderField('横幅(mm)', project.cow.eyes.sizeX, 0.3, 5, 0.1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.eyes.sizeX = v))),
    sizeY: sliderField('縦幅(mm)', project.cow.eyes.sizeY, 0.3, 5, 0.1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.eyes.sizeY = v))),
    relief: sliderField('盛り上がり(mm)', project.cow.eyes.relief, 0, 2, 0.02, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.eyes.relief = v))),
  };
  Object.values(eyeFields).forEach((f) => container.appendChild(f.el));

  // ---- 鼻 ----
  container.appendChild(sectionHeading('鼻'));
  const nostrilFields = {
    spacing: sliderField('中央からの角度バイアス(deg・負値で下)', project.cow.nostrils.spacing, -45, 45, 1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.nostrils.spacing = v))),
    height: sliderField('取り付け位置(頭上のt)', project.cow.nostrils.height, 0, 1, 0.01, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.nostrils.height = v))),
    size: sliderField('大きさ(mm)', project.cow.nostrils.size, 0.2, 3, 0.05, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.nostrils.size = v))),
    relief: sliderField('彫り込み(mm)', project.cow.nostrils.relief, 0, 1, 0.02, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.nostrils.relief = v))),
  };
  Object.values(nostrilFields).forEach((f) => container.appendChild(f.el));

  // ---- 斑点 ----
  container.appendChild(sectionHeading('斑点模様'));
  const spotSeedField = numberField('乱数シード', project.cow.spots.seed, (v) => ctx.store.updateWithHistory((p) => (p.cow.spots.seed = Math.round(v))), { min: 0, max: 9999, step: 1 });
  container.appendChild(spotSeedField.el);
  const spotFields = {
    count: sliderField('数', project.cow.spots.count, 0, 20, 1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.spots.count = Math.round(v)))),
    minSize: sliderField('最小の大きさ(mm)', project.cow.spots.minSize, 0.5, 10, 0.1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.spots.minSize = v))),
    maxSize: sliderField('最大の大きさ(mm)', project.cow.spots.maxSize, 0.5, 12, 0.1, () => ctx.store.recordHistorySnapshot(), (v) => ctx.store.updateLive((p) => (p.cow.spots.maxSize = v))),
  };
  Object.values(spotFields).forEach((f) => container.appendChild(f.el));

  // ---- 色 ----
  container.appendChild(sectionHeading('色'));
  const colorFields = {
    body: colorField('本体', project.cow.colors.body, (v) => ctx.store.updateWithHistory((p) => (p.cow.colors.body = v))),
    spot: colorField('斑点', project.cow.colors.spot, (v) => ctx.store.updateWithHistory((p) => (p.cow.colors.spot = v))),
    horn: colorField('角', project.cow.colors.horn, (v) => ctx.store.updateWithHistory((p) => (p.cow.colors.horn = v))),
    nose: colorField('鼻', project.cow.colors.nose, (v) => ctx.store.updateWithHistory((p) => (p.cow.colors.nose = v))),
    eye: colorField('目', project.cow.colors.eye, (v) => ctx.store.updateWithHistory((p) => (p.cow.colors.eye = v))),
  };
  Object.values(colorFields).forEach((f) => container.appendChild(f.el));

  function refresh(): void {
    const p = ctx.store.getProject();
    refreshSectionTable(torsoFields, p.cow.torso.sections);
    headTiltField.refresh(p.cow.head.tilt);
    refreshSectionTable(headFields, p.cow.head.sections);

    (Object.keys(frontLegFields) as Array<keyof CowLegParams>).forEach((k) =>
      frontLegFields[k].refresh(p.cow.legs.front[k]),
    );
    (Object.keys(backLegFields) as Array<keyof CowLegParams>).forEach((k) =>
      backLegFields[k].refresh(p.cow.legs.back[k]),
    );
    legSpacingField.refresh(p.cow.legs.spacingX);
    frontTField.refresh(p.cow.legs.frontT);
    backTField.refresh(p.cow.legs.backT);

    earFields.sizeX.refresh(p.cow.ears.sizeX);
    earFields.sizeY.refresh(p.cow.ears.sizeY);
    earFields.tilt.refresh(p.cow.ears.tilt);
    earFields.relief.refresh(p.cow.ears.relief);
    earFields.attachHeight.refresh(p.cow.ears.attachHeight);
    earFields.spacing.refresh(p.cow.ears.spacing);

    hornFields.length.refresh(p.cow.horns.length);
    hornFields.radiusStart.refresh(p.cow.horns.radiusStart);
    hornFields.radiusEnd.refresh(p.cow.horns.radiusEnd);
    hornFields.tilt.refresh(p.cow.horns.tilt);
    hornFields.attachHeight.refresh(p.cow.horns.attachHeight);
    hornFields.spacing.refresh(p.cow.horns.spacing);

    tailFields.radius.refresh(p.cow.tail.radius);
    tailFields.length.refresh(p.cow.tail.length);
    tailFields.tilt.refresh(p.cow.tail.tilt);
    tailFields.distortion.refresh(p.cow.tail.distortion);
    tailFields.tuftSize.refresh(p.cow.tail.tuftSize);

    eyeFields.spacing.refresh(p.cow.eyes.spacing);
    eyeFields.height.refresh(p.cow.eyes.height);
    eyeFields.sizeX.refresh(p.cow.eyes.sizeX);
    eyeFields.sizeY.refresh(p.cow.eyes.sizeY);
    eyeFields.relief.refresh(p.cow.eyes.relief);

    nostrilFields.spacing.refresh(p.cow.nostrils.spacing);
    nostrilFields.height.refresh(p.cow.nostrils.height);
    nostrilFields.size.refresh(p.cow.nostrils.size);
    nostrilFields.relief.refresh(p.cow.nostrils.relief);

    spotSeedField.refresh(p.cow.spots.seed);
    spotFields.count.refresh(p.cow.spots.count);
    spotFields.minSize.refresh(p.cow.spots.minSize);
    spotFields.maxSize.refresh(p.cow.spots.maxSize);

    colorFields.body.refresh(p.cow.colors.body);
    colorFields.spot.refresh(p.cow.colors.spot);
    colorFields.horn.refresh(p.cow.colors.horn);
    colorFields.nose.refresh(p.cow.colors.nose);
    colorFields.eye.refresh(p.cow.colors.eye);
  }

  return { refresh };
}
