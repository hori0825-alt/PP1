// StitchPlan の統計集計。
// シーケンスビュー (Phase 4.5) と診断 (Phase 5) の表示に使う。

import { STITCHES_PER_MINUTE } from "../core/constants";
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
}

export function planStats(plan: StitchPlan): PlanStats {
  let stitchCount = 0;
  let trims = 0;
  let jumps = 0;
  const travels: number[] = [];
  const perColor: ColorStats[] = [];
  let prevEnd: { x: number; y: number } | null = null;

  for (const block of plan.blocks) {
    const cs: ColorStats = { thread: block.thread, stitches: 0, trims: 0, runs: 0 };
    for (let ri = 0; ri < block.runs.length; ri++) {
      const run = block.runs[ri];
      if (run.stitches.length === 0) continue;
      cs.runs++;
      cs.stitches += run.stitches.length;
      stitchCount += run.stitches.length;

      if (prevEnd !== null) {
        const d = Math.hypot(run.stitches[0].x - prevEnd.x, run.stitches[0].y - prevEnd.y);
        if (ri === 0) {
          // ブロック間 = 色替え移動
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
  };
}
