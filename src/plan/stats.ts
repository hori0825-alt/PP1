// StitchPlan の統計集計。
// シーケンスビュー (Phase 4.5) と診断 (Phase 5) の表示に使う。

import { STITCHES_PER_MINUTE, UNIT_MM } from "../core/constants";
import { planBounds, stitchedLengthByBlock } from "../core/plan";
import type { StitchPlan, ThreadColor } from "../core/types";

export interface TravelStats {
  count: number;
  total: number;
  max: number;
  avg: number;
}

export interface ColorStats {
  thread: ThreadColor;
  stitches: number;
  trims: number;
  runs: number;
  /** 縫い糸長 (mm) */
  lengthMm: number;
}

export interface PlanStats {
  stitchCount: number;
  colorCount: number;
  colorChanges: number;
  trims: number;
  jumps: number;
  /** Run 間の移動 (jump/trim) の距離統計。ブロック間の色替え移動も含む */
  travel: TravelStats;
  perColor: ColorStats[];
  /** 推定縫製時間 (分) */
  estMinutes: number;
  /** デザインの幅 (mm) */
  widthMm: number;
  /** デザインの高さ (mm) */
  heightMm: number;
  /** 総縫い糸長 (mm) */
  totalLengthMm: number;
  /** ステッチ長の統計 (mm)。Run 内の連続ステッチ間距離 */
  stitchLen: { min: number; max: number; avg: number };
  /** ステッチ密度 (針/cm²) */
  densityPerCm2: number;
}

export function planStats(plan: StitchPlan): PlanStats {
  let stitchCount = 0;
  let trims = 0;
  let jumps = 0;
  const travels: number[] = [];
  const perColor: ColorStats[] = [];
  let prevEnd: { x: number; y: number } | null = null;
  let stitchLenSum = 0;
  let stitchLenCount = 0;
  let stitchLenMin = Infinity;
  let stitchLenMax = 0;

  const lengths = stitchedLengthByBlock(plan);

  for (let bi = 0; bi < plan.blocks.length; bi++) {
    const block = plan.blocks[bi];
    const cs: ColorStats = { thread: block.thread, stitches: 0, trims: 0, runs: 0, lengthMm: lengths[bi] * UNIT_MM };
    for (let ri = 0; ri < block.runs.length; ri++) {
      const run = block.runs[ri];
      if (run.stitches.length === 0) continue;
      cs.runs++;
      cs.stitches += run.stitches.length;
      stitchCount += run.stitches.length;

      for (let si = 1; si < run.stitches.length; si++) {
        const d = Math.hypot(run.stitches[si].x - run.stitches[si - 1].x, run.stitches[si].y - run.stitches[si - 1].y);
        const dMm = d * UNIT_MM;
        stitchLenSum += dMm;
        stitchLenCount++;
        if (dMm < stitchLenMin) stitchLenMin = dMm;
        if (dMm > stitchLenMax) stitchLenMax = dMm;
      }

      if (prevEnd !== null) {
        const d = Math.hypot(run.stitches[0].x - prevEnd.x, run.stitches[0].y - prevEnd.y);
        if (ri === 0) {
          if (d > 0) travels.push(d);
        } else if (run.connection === "trim") {
          trims++;
          cs.trims++;
          travels.push(d);
        } else if (run.connection === "jump") {
          jumps++;
          travels.push(d);
        }
      }
      prevEnd = run.stitches[run.stitches.length - 1];
    }
    if (cs.runs > 0) perColor.push(cs);
  }

  const total = travels.reduce((s, d) => s + d, 0);
  const bounds = planBounds(plan);
  const wMm = bounds ? (bounds.maxX - bounds.minX) * UNIT_MM : 0;
  const hMm = bounds ? (bounds.maxY - bounds.minY) * UNIT_MM : 0;
  const areaCm2 = (wMm * hMm) / 100;
  const totalLengthMm = lengths.reduce((s2, v) => s2 + v, 0) * UNIT_MM;

  return {
    stitchCount,
    colorCount: perColor.length,
    colorChanges: Math.max(0, perColor.length - 1),
    trims,
    jumps,
    travel: {
      count: travels.length,
      total,
      max: travels.length > 0 ? Math.max(...travels) : 0,
      avg: travels.length > 0 ? total / travels.length : 0,
    },
    perColor,
    estMinutes: stitchCount / STITCHES_PER_MINUTE,
    widthMm: wMm,
    heightMm: hMm,
    totalLengthMm,
    stitchLen: {
      min: stitchLenCount > 0 ? stitchLenMin : 0,
      max: stitchLenMax,
      avg: stitchLenCount > 0 ? stitchLenSum / stitchLenCount : 0,
    },
    densityPerCm2: areaCm2 > 0 ? stitchCount / areaCm2 : 0,
  };
}
