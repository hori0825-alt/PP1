// 縫い順最適化 (Closest Join / Closest Point)。
// オブジェクト (領域) の巡回順を「前の終点 → 次の始点」の総移動距離が
// 短くなるように決める。貪欲法 (最近傍) + 2-opt 改善。

import type { Point } from "../core/types";

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * 点群 (オブジェクトの代表点) の巡回順を最適化する。
 * start が与えられた場合は「start に近い点から始める開経路」として最適化する。
 * 返り値は points のインデックス列。
 */
export function optimizeOrder(points: Point[], start: Point | null = null): number[] {
  const n = points.length;
  if (n <= 1) return points.map((_, i) => i);

  // --- 貪欲法 (最近傍) ---
  const used = new Array<boolean>(n).fill(false);
  const order: number[] = [];
  let cur = start;
  if (cur === null) {
    order.push(0);
    used[0] = true;
    cur = points[0];
  }
  while (order.length < n) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const d = dist(cur as Point, points[i]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    order.push(best);
    used[best] = true;
    cur = points[best];
  }

  // --- 2-opt 改善 (開経路。start は固定の仮想始点) ---
  const pathCost = (prev: Point | null, a: number): number =>
    prev === null ? 0 : dist(prev, points[a]);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const prev = i === 0 ? start : points[order[i - 1]];
        const next = j === n - 1 ? null : points[order[j + 1]];
        const oi = order[i];
        const oj = order[j];
        const before =
          pathCost(prev, oi) + (next === null ? 0 : dist(points[oj], next));
        const after =
          pathCost(prev, oj) + (next === null ? 0 : dist(points[oi], next));
        if (after < before - 1e-9) {
          // order[i..j] を反転
          let lo = i;
          let hi = j;
          while (lo < hi) {
            const t = order[lo];
            order[lo] = order[hi];
            order[hi] = t;
            lo++;
            hi--;
          }
          improved = true;
        }
      }
    }
  }
  return order;
}

/** 順序に従って訪問したときの総移動距離 (開経路、start 起点) */
export function orderTravelCost(points: Point[], order: number[], start: Point | null = null): number {
  let total = 0;
  let cur = start;
  for (const idx of order) {
    if (cur !== null) total += dist(cur, points[idx]);
    cur = points[idx];
  }
  return total;
}
