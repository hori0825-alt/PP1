// 自動針数削減。
// 12,000 針 (PP1 上限) を超えた場合に、品質への影響が小さい順に
// 対策を積み重ねて適用し、削減前後の針数と適用内容を報告する。
//
// 適用順:
//   1. タタミ密度を下げる (行間隔 +20% ×2段階)
//   2. 小さい領域を削除 (5mm² → 10mm²)
//   3. ステッチ長を伸ばす (+30%)
//   4. サイズ縮小 (90% → 80%) ※ allowShrink=true のときのみ
//
// サイズ縮小はデザインの寸法を勝手に変える破壊的操作なので既定では行わない。
// ロゴ等は寸法が要件であることが多く、収まらない場合は針数超過として
// 利用者に知らせる方が安全 (バリデーションが error を出す)。

import { MAX_STITCH_COUNT, TATAMI_DEFAULT } from "../core/constants";
import { signedArea } from "../core/geometry";
import { countStitches } from "../core/plan";
import type { Region } from "../core/region";
import type { StitchPlan } from "../core/types";
import type { DigitizeOptions } from "../stitch/digitize";
import { digitizeRegions } from "../stitch/digitize";

export interface ReduceResult {
  plan: StitchPlan;
  before: number;
  after: number;
  /** 適用した対策の説明 (UI 表示用) */
  applied: string[];
  /** 削減後の生成オプション */
  options: DigitizeOptions;
  /** 適用したサイズ倍率 (1 = 縮小なし) */
  scale: number;
  /** 削除・縮小後の領域 */
  regions: Region[];
}

function scaleRegions(regions: Region[], f: number): Region[] {
  const s = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x * f, y: p.y * f });
  return regions.map((r) => ({
    ...r,
    outer: r.outer.map(s),
    holes: r.holes.map((h) => h.map(s)),
  }));
}

function dropSmallRegions(regions: Region[], minAreaUnits2: number): Region[] {
  return regions.filter((r) => {
    const net =
      Math.abs(signedArea(r.outer)) - r.holes.reduce((sum, h) => sum + Math.abs(signedArea(h)), 0);
    return net >= minAreaUnits2;
  });
}

interface Strategy {
  label: string;
  apply: (state: { regions: Region[]; options: DigitizeOptions; scale: number }) => void;
}

export function autoReduce(
  regions: Region[],
  name: string,
  baseOptions: DigitizeOptions = {},
  limit: number = MAX_STITCH_COUNT,
  allowShrink = false,
): ReduceResult {
  const state = {
    regions: regions.slice(),
    options: { ...baseOptions },
    scale: 1,
  };

  const baseSpacing = baseOptions.rowSpacing ?? TATAMI_DEFAULT.rowSpacing;
  const baseLength = baseOptions.stitchLength ?? TATAMI_DEFAULT.stitchLength;

  const strategies: Strategy[] = [
    {
      label: "タタミ密度を下げる (行間隔 +20%)",
      apply: (s) => {
        s.options.rowSpacing = Math.round(baseSpacing * 1.2);
      },
    },
    {
      label: "タタミ密度をさらに下げる (行間隔 +44%)",
      apply: (s) => {
        s.options.rowSpacing = Math.round(baseSpacing * 1.44);
      },
    },
    {
      label: "5mm² 未満の小さい領域を削除",
      apply: (s) => {
        s.regions = dropSmallRegions(s.regions, 500);
      },
    },
    {
      label: "10mm² 未満の小さい領域を削除",
      apply: (s) => {
        s.regions = dropSmallRegions(s.regions, 1000);
      },
    },
    {
      label: "ステッチ長を伸ばす (+30%)",
      apply: (s) => {
        s.options.stitchLength = Math.round(baseLength * 1.3);
      },
    },
    // サイズ縮小は破壊的なので allowShrink のときだけ最終手段として加える
    ...(allowShrink
      ? [
          {
            label: "サイズを 90% に縮小",
            apply: (s: { regions: Region[]; options: DigitizeOptions; scale: number }) => {
              s.regions = scaleRegions(s.regions, 0.9 / s.scale);
              s.scale = 0.9;
            },
          },
          {
            label: "サイズを 80% に縮小",
            apply: (s: { regions: Region[]; options: DigitizeOptions; scale: number }) => {
              s.regions = scaleRegions(s.regions, 0.8 / s.scale);
              s.scale = 0.8;
            },
          },
        ]
      : []),
  ];

  let result = digitizeRegions(state.regions, name, state.options);
  const before = countStitches(result.plan);
  const applied: string[] = [];

  let after = before;
  for (const strategy of strategies) {
    if (after <= limit) break;
    strategy.apply(state);
    applied.push(strategy.label);
    result = digitizeRegions(state.regions, name, state.options);
    after = countStitches(result.plan);
  }

  return {
    plan: result.plan,
    before,
    after,
    applied,
    options: state.options,
    scale: state.scale,
    regions: state.regions,
  };
}
