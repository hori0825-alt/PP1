// Region (刺繍領域) ↔ EditShape (編集可能な外周+穴) の相互変換。
// ノード編集は EditShape 上で行い、編集後に Region へ戻して digitize に渡す。

import { signedArea } from "../core/geometry";
import type { Region } from "../core/region";
import type { ThreadColor } from "../core/types";
import type { EditPath } from "./path";
import { pathToPolyline } from "./path";
import { pointsToPath } from "./simplify";
import type { ToNodesOptions } from "./simplify";

export interface EditShape {
  outer: EditPath;
  holes: EditPath[];
  color: ThreadColor;
}

/** Region を編集可能形状に変換 (稠密輪郭 → ノード列) */
export function regionToEditShape(region: Region, options?: ToNodesOptions): EditShape {
  return {
    outer: pointsToPath(region.outer, true, options),
    holes: region.holes.map((h) => pointsToPath(h, true, options)),
    color: region.color,
  };
}

/**
 * 編集可能形状を Region に戻す (ノード列 → 稠密ポリライン)。
 * 外周は正の符号付き面積、穴は負になるよう向きを正規化する。
 */
export function editShapeToRegion(shape: EditShape, samplesPerSegment = 8): Region {
  const outer = pathToPolyline(shape.outer, samplesPerSegment);
  const normalizedOuter = signedArea(outer) < 0 ? outer.slice().reverse() : outer;
  const holes = shape.holes
    .map((h) => pathToPolyline(h, samplesPerSegment))
    .filter((h) => h.length >= 3)
    .map((h) => (signedArea(h) > 0 ? h.slice().reverse() : h));
  return { outer: normalizedOuter, holes, color: shape.color };
}
