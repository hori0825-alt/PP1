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

/**
 * ブロック (糸色) ごとの「縫われた糸長」(内部単位)。
 * 各 Run 内の連続ステッチ間距離の総和。Run 間の渡り (ジャンプ/糸切り) は含めず、
 * 実際に布へ縫い込まれる糸の長さの近似とする (糸量・コストの見積り用)。
 */
export function stitchedLengthByBlock(plan: StitchPlan): number[] {
  return plan.blocks.map((block) => {
    let len = 0;
    for (const run of block.runs) {
      for (let i = 1; i < run.stitches.length; i++) {
        len += distance(run.stitches[i - 1], run.stitches[i]);
      }
    }
    return len;
  });
}

/** 総縫い糸長 (内部単位)。全色の縫い糸長の合計 */
export function totalStitchedLength(plan: StitchPlan): number {
  return stitchedLengthByBlock(plan).reduce((s, v) => s + v, 0);
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
