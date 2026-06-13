// Quick Trace のセンターライン抽出。
// 細長い領域の中心線を、主軸に直交するスライスの中点列として近似する。
// (完全なスケルトン抽出は重いため、細線・文字ステム向けの実用近似)
// アウトライン抽出は Region.outer をそのまま使えばよいので、ここではセンターライン専用。

import type { Region } from "../core/region";
import type { Point } from "../core/types";
import { rotatePoint, scanRegion } from "../stitch/scanline";
import { pointsToPath } from "./simplify";
import type { EditPath } from "./path";

/** 外周点列から PCA 主軸角を求める (satin と同じ手法) */
function principalAngle(pts: Point[]): number {
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let cxx = 0;
  let cxy = 0;
  let cyy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    cxx += dx * dx;
    cxy += dx * dy;
    cyy += dy * dy;
  }
  return 0.5 * Math.atan2(2 * cxy, cxx - cyy);
}

export interface CenterlineOptions {
  /** スライス間隔 (内部単位)。デフォルト 5 (0.5mm) */
  sliceSpacing?: number;
}

/**
 * 領域の中心線を Point[] で返す。主軸が縦になる向きにスライスし、
 * 各行の最も広い区間の中点をつなぐ。
 */
export function extractCenterline(region: Region, options: CenterlineOptions = {}): Point[] {
  const spacing = options.sliceSpacing ?? 5;
  const theta = principalAngle(region.outer);
  const angleRad = theta + Math.PI / 2; // 主軸を y 軸へ
  const { rows } = scanRegion(region, angleRad, spacing);

  const mids: Point[] = [];
  for (const row of rows) {
    if (row.length === 0) continue;
    let seg = row[0];
    for (const s of row) if (s.x2 - s.x1 > seg.x2 - seg.x1) seg = s;
    mids.push({ x: (seg.x1 + seg.x2) / 2, y: seg.y });
  }
  // 逆回転して元座標へ
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return mids.map((p) => {
    const q = rotatePoint(p, cos, sin);
    return { x: Math.round(q.x), y: Math.round(q.y) };
  });
}

/** センターラインを編集可能パス (開パス) として返す (Quick Trace 結果の手動編集用) */
export function centerlineToPath(region: Region, options?: CenterlineOptions): EditPath {
  const pts = extractCenterline(region, options);
  if (pts.length < 2) return { nodes: pts.map((p) => ({ x: p.x, y: p.y, type: "corner" as const })), closed: false };
  return pointsToPath(pts, false, { tolerance: 6 });
}
