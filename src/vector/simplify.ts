// 稠密な輪郭点列 (Region.outer など) を編集可能なノード列 (EditPath) に変換する。
// Douglas-Peucker でノード候補を抽出し、各候補の屈曲角から corner/smooth を判定する。
// 逆変換 (pathToPolyline) は path.ts にある。

import { douglasPeucker, simplifyClosed } from "../core/geometry";
import type { Point } from "../core/types";
import type { EditNode, EditPath } from "./path";

export interface ToNodesOptions {
  /** DP 許容誤差 (内部単位)。デフォルト 0.4mm 相当の 4 */
  tolerance?: number;
  /** この角度 (度) より鋭い屈曲は corner、ゆるい屈曲は smooth。デフォルト 50° */
  cornerAngleDeg?: number;
}

/** 3点 a-b-c の b における屈曲角 (度)。直線なら 0、鋭角なら大きい */
function turnAngleDeg(a: Point, b: Point, c: Point): number {
  const v1x = b.x - a.x;
  const v1y = b.y - a.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const l1 = Math.hypot(v1x, v1y);
  const l2 = Math.hypot(v2x, v2y);
  if (l1 < 1e-9 || l2 < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** 稠密点列を EditPath に変換する */
export function pointsToPath(points: Point[], closed: boolean, options: ToNodesOptions = {}): EditPath {
  const tolerance = options.tolerance ?? 4;
  const cornerAngle = options.cornerAngleDeg ?? 50;

  const simplified = closed ? simplifyClosed(points, tolerance) : douglasPeucker(points, tolerance);
  const n = simplified.length;
  const nodes: EditNode[] = simplified.map((p, i) => {
    const prev = simplified[(i - 1 + n) % n];
    const next = simplified[(i + 1) % n];
    // 開パスの端点は corner 固定
    const isEnd = !closed && (i === 0 || i === n - 1);
    const angle = isEnd ? 999 : turnAngleDeg(prev, p, next);
    return { x: p.x, y: p.y, type: angle >= cornerAngle ? "corner" : "smooth" };
  });
  return { nodes, closed };
}
