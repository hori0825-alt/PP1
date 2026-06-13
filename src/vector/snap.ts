// Snap to Artwork: ノードを下絵 (元画像の輪郭やベクター輪郭) に吸着させる。
// 手動デジタイズ時に、参照パスの輪郭をなぞりやすくする。

import { pointSegmentDistance } from "../core/geometry";
import type { Point } from "../core/types";

/** 線分 ab 上で点 p に最も近い点を返す */
function closestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/**
 * 点 p を参照パス群の最寄りのエッジ上に吸着する。
 * threshold (内部単位) 以内に吸着先があればその点を、なければ p をそのまま返す。
 */
export function snapToArtwork(p: Point, refPaths: Point[][], threshold: number): Point {
  let best: Point | null = null;
  let bestD = threshold;
  for (const path of refPaths) {
    for (let i = 0; i < path.length; i++) {
      const a = path[i];
      const b = path[(i + 1) % path.length];
      const d = pointSegmentDistance(p, a, b);
      if (d < bestD) {
        bestD = d;
        best = closestOnSegment(p, a, b);
      }
    }
  }
  return best ?? p;
}
