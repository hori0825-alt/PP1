// Phase 1 動作確認用のデモ StitchPlan。
// 2色 × 各1つの正方形をジグザグ走査 (簡易タタミ) で埋める。
// Phase 3 で本物のステッチジェネレーターに置き換わる。

import { TATAMI_DEFAULT, mm } from "../core/constants";
import type { Point, StitchPlan, StitchRun } from "../core/types";

/** 矩形を水平ジグザグ走査で埋める1本の連続 Run を生成 */
function zigzagFill(cx: number, cy: number, size: number): StitchRun {
  const half = size / 2;
  const { rowSpacing, stitchLength } = TATAMI_DEFAULT;
  const stitches: Point[] = [];
  const rows = Math.floor(size / rowSpacing);
  for (let r = 0; r <= rows; r++) {
    const y = Math.round(cy - half + r * rowSpacing);
    const leftToRight = r % 2 === 0;
    const cols = Math.floor(size / stitchLength);
    for (let c = 0; c <= cols; c++) {
      const t = c / cols;
      const x = Math.round(leftToRight ? cx - half + size * t : cx + half - size * t);
      stitches.push({ x, y });
    }
  }
  return { stitches, connection: "trim" };
}

export function buildDemoPlan(): StitchPlan {
  return {
    name: "PHASE1",
    blocks: [
      {
        thread: { r: 237, g: 23, b: 31, name: "Red" },
        runs: [zigzagFill(mm(-20), mm(0), mm(25))],
      },
      {
        thread: { r: 10, g: 85, b: 163, name: "Blue" },
        runs: [zigzagFill(mm(20), mm(0), mm(25))],
      },
    ],
  };
}
