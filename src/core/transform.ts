// 領域・点のアフィン変換 (平行移動・回転・スケール)。
// 文字配置 (Phase 8) や装飾配置 (ミラー/万華鏡, Phase 11) で共用する。

import type { Region } from "./region";
import type { Point } from "./types";

export interface Transform {
  /** 平行移動 (内部単位) */
  tx?: number;
  ty?: number;
  /** 原点まわりの回転 (ラジアン) */
  rotation?: number;
  /** スケール (1 = 等倍) */
  scale?: number;
  /** 左右反転 (x を反転) */
  flipX?: boolean;
  /** 上下反転 (y を反転) */
  flipY?: boolean;
}

export function transformPoint(p: Point, t: Transform): Point {
  const s = t.scale ?? 1;
  const sx = (t.flipX ? -1 : 1) * s;
  const sy = (t.flipY ? -1 : 1) * s;
  let x = p.x * sx;
  let y = p.y * sy;
  if (t.rotation) {
    const c = Math.cos(t.rotation);
    const sn = Math.sin(t.rotation);
    const rx = x * c - y * sn;
    const ry = x * sn + y * c;
    x = rx;
    y = ry;
  }
  return { x: x + (t.tx ?? 0), y: y + (t.ty ?? 0) };
}

export function transformPath(path: Point[], t: Transform): Point[] {
  return path.map((p) => transformPoint(p, t));
}

/**
 * 領域を変換する。flipX/flipY が片方だけ true のとき外周/穴の向き
 * (符号付き面積) が反転するため、呼び出し側で必要なら正規化すること。
 */
export function transformRegion(region: Region, t: Transform): Region {
  return {
    outer: transformPath(region.outer, t),
    holes: region.holes.map((h) => transformPath(h, t)),
    color: region.color,
    selfIntersecting: region.selfIntersecting,
  };
}
