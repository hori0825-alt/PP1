// ストローク (線) 解析。
// 細長い領域 (リボン化した線画・文字ステム) を「中心線 + 幅」に畳む。
//
// 手法 (レール対形成):
//   1. 外周上で最も離れた2頂点を「線の両端 (tip)」とみなす。
//   2. 外周をこの2点で2つの弧 (= 線の両側のレール) に分割する。
//   3. 両レールを同数 N にリサンプルし対応付け、各対の中点列を中心線、
//      対の距離を幅プロファイルとする。
//   4. 中央値を代表幅、中心線の長さを線長とする。
//
// これにより曲線・L字の線でも、外周トレースで生じる「二重輪郭 (リボン)」を
// 1本の中心線へ正しく畳める (PCA 単軸近似より曲線追従に強い)。

import type { Region } from "../core/region";
import type { Point } from "../core/types";

export interface StrokeAnalysis {
  /** 中心線 (N 点) */
  centerline: Point[];
  /** 左レール (N 点、両端 tip を含む) */
  left: Point[];
  /** 右レール (N 点、左レールと対応) */
  right: Point[];
  /** 各対の幅 */
  widths: number[];
  /** 代表幅 (中央値) */
  width: number;
  /** 中心線の長さ */
  length: number;
  /** 最大対幅 (一貫性チェック用) */
  maxPairedWidth: number;
}

export interface StrokeAnalyzeOptions {
  /** レールのサンプル点数。未指定なら頂点数から自動 */
  samples?: number;
}

/** 開いた折れ線を弧長等間隔に N 点へリサンプルする (両端を含む) */
export function resampleN(pts: Point[], n: number): Point[] {
  if (pts.length === 0) return [];
  if (pts.length === 1 || n <= 1) return new Array(Math.max(1, n)).fill(pts[0]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = cum[cum.length - 1];
  if (total < 1e-9) return new Array(n).fill(pts[0]);
  const out: Point[] = [];
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (seg + 1 < pts.length - 1 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const u = segLen < 1e-9 ? 0 : (target - cum[seg]) / segLen;
    out.push({
      x: pts[seg].x + (pts[seg + 1].x - pts[seg].x) * u,
      y: pts[seg].y + (pts[seg + 1].y - pts[seg].y) * u,
    });
  }
  return out;
}

/** 外周上で i から j まで前方向 (添字増、ループ) に辿る頂点列 (両端含む) */
function arcBetween(outer: Point[], i: number, j: number): Point[] {
  const out: Point[] = [];
  let k = i;
  const n = outer.length;
  for (;;) {
    out.push(outer[k]);
    if (k === j) break;
    k = (k + 1) % n;
  }
  return out;
}

/**
 * 領域をストローク (中心線 + 幅) として解析する。
 * 穴あき・頂点不足・退化時は null。判定 (線かどうか) は looksLikeStroke で行う。
 */
export function analyzeStroke(region: Region, options: StrokeAnalyzeOptions = {}): StrokeAnalysis | null {
  if (region.holes.length > 0) return null;
  const o = region.outer;
  if (o.length < 4) return null;

  // 両端 tip = PCA 主軸への射影が最小/最大の頂点。
  // (最遠2点だと長方形で対角コーナーを拾い、レール分割が崩れるため主軸射影を使う)
  let mx = 0;
  let my = 0;
  for (const p of o) {
    mx += p.x;
    my += p.y;
  }
  mx /= o.length;
  my /= o.length;
  let cxx = 0;
  let cxy = 0;
  let cyy = 0;
  for (const p of o) {
    const dx = p.x - mx;
    const dy = p.y - my;
    cxx += dx * dx;
    cxy += dx * dy;
    cyy += dy * dy;
  }
  const axisAngle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const ax = Math.cos(axisAngle);
  const ay = Math.sin(axisAngle);
  let bi = 0;
  let bj = 0;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let i = 0; i < o.length; i++) {
    const t = (o[i].x - mx) * ax + (o[i].y - my) * ay;
    if (t < tMin) {
      tMin = t;
      bi = i;
    }
    if (t > tMax) {
      tMax = t;
      bj = i;
    }
  }
  if (bi === bj) return null;

  const arc1 = arcBetween(o, bi, bj); // tip i → tip j (片側のレール)
  const arc2 = arcBetween(o, bj, bi); // tip j → tip i (反対側)
  const n = Math.max(16, Math.min(256, options.samples ?? o.length * 2));
  const left = resampleN(arc1, n);
  const right = resampleN(arc2, n).reverse(); // i → j に揃える

  const centerline: Point[] = [];
  const widths: number[] = [];
  for (let k = 0; k < n; k++) {
    centerline.push({ x: (left[k].x + right[k].x) / 2, y: (left[k].y + right[k].y) / 2 });
    widths.push(Math.hypot(left[k].x - right[k].x, left[k].y - right[k].y));
  }
  let length = 0;
  for (let k = 1; k < n; k++) {
    length += Math.hypot(centerline[k].x - centerline[k - 1].x, centerline[k].y - centerline[k - 1].y);
  }
  const sorted = [...widths].sort((a, b) => a - b);
  const width = sorted[sorted.length >> 1];
  return { centerline, left, right, widths, width, length, maxPairedWidth: Math.max(...widths) };
}

export interface StrokeVerdictOptions {
  /** これを超える幅は線とみなさない (デフォルト 7mm) */
  maxStrokeWidth?: number;
  /** 線長 / 幅 がこれ以上なら線 (デフォルト 3) */
  minElongation?: number;
}

/** 解析結果が「線らしい」か (細長く、幅が上限以下) を判定する */
export function looksLikeStroke(a: StrokeAnalysis, options: StrokeVerdictOptions = {}): boolean {
  const maxW = options.maxStrokeWidth ?? 70; // 7mm (内部単位)
  const minElong = options.minElongation ?? 3;
  if (a.width < 1e-6) return false;
  if (a.width > maxW) return false;
  if (a.length / a.width < minElong) return false;
  return true;
}
