// StitchPlan に対する純粋な集計・幾何ユーティリティ (DOM 非依存)。

import type { Point, StitchPlan } from "./types";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 総針数 (通常ステッチのみ。ジャンプ・色替えは含まない) */
export function countStitches(plan: StitchPlan): number {
  let n = 0;
  for (const block of plan.blocks) {
    for (const run of block.runs) n += run.stitches.length;
  }
  return n;
}

/** 明示的な糸切り回数 (connection === 'trim' の数。色替えによる暗黙の糸切りは含まない) */
export function countTrims(plan: StitchPlan): number {
  let n = 0;
  for (const block of plan.blocks) {
    for (let i = 0; i < block.runs.length; i++) {
      // ブロック先頭 Run の connection は色替えに吸収されるため数えない
      if (i > 0 && block.runs[i].connection === "trim") n++;
    }
  }
  return n;
}

/** 色替え回数 (ブロック数 - 1) */
export function countColorChanges(plan: StitchPlan): number {
  return Math.max(0, plan.blocks.length - 1);
}

/** 全ステッチのバウンディングボックス。ステッチが無い場合は null */
export function planBounds(plan: StitchPlan): Bounds | null {
  let b: Bounds | null = null;
  for (const block of plan.blocks) {
    for (const run of block.runs) {
      for (const p of run.stitches) {
        if (b === null) {
          b = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
        } else {
          if (p.x < b.minX) b.minX = p.x;
          if (p.y < b.minY) b.minY = p.y;
          if (p.x > b.maxX) b.maxX = p.x;
          if (p.y > b.maxY) b.maxY = p.y;
        }
      }
    }
  }
  return b;
}
