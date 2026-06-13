// 実機テスト用サンプルを samples/ に生成する。
//   npx vite-node scripts/build-samples.ts
//
// 各サンプルについて .pes / .dst / メタ情報(JSON) を出力し、
// samples/README.md に一覧表を書き出す。決定的なので再実行で同じ結果になる。

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UNIT_MM } from "../src/core/constants";
import { countColorChanges, countStitches, countTrims, planBounds } from "../src/core/plan";
import { writeDst } from "../src/export/dst";
import { writePes } from "../src/export/pes";
import { planToSvg } from "../src/export/svgPreview";
import { validatePlan } from "../src/export/validate";
import { planStats } from "../src/plan/stats";
import { allSamples } from "../src/samples/designs";
import { digitizeRegions } from "../src/stitch/digitize";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../samples");
mkdirSync(outDir, { recursive: true });

interface Row {
  id: string;
  name: string;
  purpose: string;
  stitches: number;
  colors: number;
  colorChanges: number;
  trims: number;
  sizeMm: string;
  estMin: number;
}

const rows: Row[] = [];

for (const sample of allSamples()) {
  const { plan } = digitizeRegions(sample.regions, sample.name, sample.options);
  const v = validatePlan(plan);
  if (!v.ok) {
    throw new Error(`サンプル ${sample.id} が検証に失敗しました: ${v.issues.map((i) => i.message).join(", ")}`);
  }
  const stats = planStats(plan);
  const b = planBounds(plan) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  writeFileSync(resolve(outDir, `${sample.id}.pes`), writePes(plan).data);
  writeFileSync(resolve(outDir, `${sample.id}.dst`), writeDst(plan));
  writeFileSync(resolve(outDir, `${sample.id}.svg`), planToSvg(plan));
  writeFileSync(
    resolve(outDir, `${sample.id}.json`),
    JSON.stringify(
      {
        id: sample.id,
        name: sample.name,
        purpose: sample.purpose,
        expect: sample.expect,
        actual: {
          stitches: countStitches(plan),
          colors: stats.colorCount,
          colorChanges: countColorChanges(plan),
          trims: countTrims(plan),
          maxTravelMm: +(stats.travel.max * UNIT_MM).toFixed(1),
          estMinutes: +stats.estMinutes.toFixed(1),
        },
      },
      null,
      2,
    ),
  );

  rows.push({
    id: sample.id,
    name: sample.name,
    purpose: sample.purpose,
    stitches: countStitches(plan),
    colors: stats.colorCount,
    colorChanges: countColorChanges(plan),
    trims: countTrims(plan),
    sizeMm: `${((b.maxX - b.minX) * UNIT_MM).toFixed(0)}×${((b.maxY - b.minY) * UNIT_MM).toFixed(0)}`,
    estMin: Math.ceil(stats.estMinutes),
  });
  // eslint-disable-next-line no-console
  console.log(`✓ ${sample.id}: ${countStitches(plan)}針 / 色替え${countColorChanges(plan)} / 糸切り${countTrims(plan)}`);
}

const readme = `# 実機テスト用サンプル

\`npx vite-node scripts/build-samples.ts\` で再生成できます (決定的)。
各サンプルの \`.pes\` を Brother PP1 / Artspira に転送し、下表の
「期待値」どおりに縫えるか (特に糸切り回数) を確認してください。

| ID | 名称 | 確認内容 | 針数 | 色 | 色替え | 糸切り | サイズmm | 目安 |
|----|------|----------|-----:|---:|------:|------:|---------|-----:|
${rows
  .map(
    (r) =>
      `| ${r.id} | ${r.name} | ${r.purpose} | ${r.stitches} | ${r.colors} | ${r.colorChanges} | ${r.trims} | ${r.sizeMm} | ${r.estMin}分 |`,
  )
  .join("\n")}

## 実機確認のポイント

- **a-solid-circle**: 縫っている途中で糸が切られないこと (糸切り0回)。
  面の塗りが連続した1本のステッチで縫われる。
- **b-donut**: 中央の穴が糸で埋まらないこと。青→黄の色替えが1回だけ。
- **c-scatter**: 同じ赤の花びら同士が無駄に糸切りされないこと。
  糸切りは離れた領域への移動 (10mm超) のみ。

各 \`.json\` に期待値と実測値を記録しています。
`;
writeFileSync(resolve(outDir, "README.md"), readme);
// eslint-disable-next-line no-console
console.log(`\nsamples/ に ${rows.length} サンプル × (pes/dst/json) + README.md を生成しました`);
