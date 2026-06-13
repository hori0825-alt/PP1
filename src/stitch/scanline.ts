// スキャンライン基盤。
// 領域 (外周 + 穴) を角度付きの平行線で走査し、内部区間 (Seg) を行ごとに求める。
// 各交点には「どのリングの周上何 mm の位置か」を記録し、
// Travel on Edge (縁に沿った移動ステッチ) の経路計算に使う。
//
// タタミ (tatami.ts) と領域サテン (satin.ts) が共用する。

import type { Region } from "../core/region";
import type { Point } from "../core/types";

/** リング周上の位置参照 (Travel on Edge 用) */
export interface CrossRef {
  /** 0 = 外周、1.. = 穴 (holes[ring-1]) */
  ring: number;
  /** リング周に沿った弧長位置 */
  s: number;
}

/** 1本の走査線が領域内部を横切る区間 */
export interface Seg {
  row: number;
  y: number;
  x1: number;
  x2: number;
  /** x1 側の交点のリング位置 */
  c1: CrossRef;
  /** x2 側の交点のリング位置 */
  c2: CrossRef;
}

/** 回転済みリングの幾何 (周長の累積を持つ) */
export interface RingGeom {
  pts: Point[];
  /** prefix[i] = pts[0] から pts[i] までの弧長。prefix[n] = 周長 */
  prefix: number[];
  total: number;
}

export interface ScanResult {
  rows: Seg[][];
  rings: RingGeom[];
}

export function rotatePoint(p: Point, cos: number, sin: number): Point {
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

function buildRing(pts: Point[]): RingGeom {
  const prefix: number[] = [0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    prefix.push(prefix[i] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return { pts, prefix, total: prefix[pts.length] };
}

/** リング周上の弧長位置 s にある点を返す */
export function ringPointAt(ring: RingGeom, s: number): Point {
  const total = ring.total;
  let t = ((s % total) + total) % total;
  for (let i = 0; i < ring.pts.length; i++) {
    if (t <= ring.prefix[i + 1] - ring.prefix[i] + 1e-9) {
      const a = ring.pts[i];
      const b = ring.pts[(i + 1) % ring.pts.length];
      const len = ring.prefix[i + 1] - ring.prefix[i];
      const u = len < 1e-9 ? 0 : t / len;
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
    t -= ring.prefix[i + 1] - ring.prefix[i];
  }
  return ring.pts[0];
}

/**
 * リング周上 sFrom → sTo の縁沿い経路 (両端点を含む頂点列)。
 * 周回方向は短い方を選ぶ。経路上の頂点は弧長距離順に並べる。
 */
export function travelAlongRing(ring: RingGeom, sFrom: number, sTo: number): Point[] {
  const total = ring.total;
  const norm = (s: number): number => ((s % total) + total) % total;
  const from = norm(sFrom);
  const to = norm(sTo);
  const fwd = norm(to - from);
  const useForward = fwd <= total - fwd;
  const dist = useForward ? fwd : total - fwd;

  // 通過する頂点を「進行方向への弧長距離」で集めてソートする
  const via: { d: number; p: Point }[] = [];
  for (let j = 0; j < ring.pts.length; j++) {
    const vs = ring.prefix[j]; // 頂点 j の弧長位置
    const d = useForward ? norm(vs - from) : norm(from - vs);
    if (d > 1e-9 && d < dist - 1e-9) via.push({ d, p: ring.pts[j] });
  }
  via.sort((a, b) => a.d - b.d);

  return [ringPointAt(ring, from), ...via.map((v) => v.p), ringPointAt(ring, to)];
}

/** リング周上で点 p に最も近い位置を求める (Closest Join の入口/出口計算用) */
export function nearestOnRing(ring: RingGeom, p: Point): { s: number; point: Point; dist: number } {
  let best = { s: 0, point: ring.pts[0], dist: Infinity };
  const n = ring.pts.length;
  for (let i = 0; i < n; i++) {
    const a = ring.pts[i];
    const b = ring.pts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 < 1e-12 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.dist) {
      best = { s: ring.prefix[i] + Math.sqrt(len2) * t, point: q, dist: d };
    }
  }
  return best;
}

/**
 * 領域を角度 angleRad の平行線で走査する。
 * 返り値の座標は「回転済み空間」(走査線が水平になる向き)。
 * 呼び出し側が逆回転で元に戻す。
 */
export function scanRegion(region: Region, angleRad: number, rowSpacing: number): ScanResult {
  const cos = Math.cos(-angleRad);
  const sin = Math.sin(-angleRad);
  const ringsSrc = [region.outer, ...region.holes];
  const rings = ringsSrc.map((r) => buildRing(r.map((p) => rotatePoint(p, cos, sin))));

  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring.pts) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }

  const rows: Seg[][] = [];
  if (!Number.isFinite(minY)) return { rows, rings };

  const rowCount = Math.max(1, Math.floor((maxY - minY) / rowSpacing));
  for (let r = 0; r < rowCount; r++) {
    const y = minY + (r + 0.5) * rowSpacing;
    // 全リングとの交点を集める (偶奇規則)
    const crossings: { x: number; ref: CrossRef }[] = [];
    for (let ri = 0; ri < rings.length; ri++) {
      const ring = rings[ri];
      const n = ring.pts.length;
      for (let i = 0; i < n; i++) {
        const a = ring.pts[i];
        const b = ring.pts[(i + 1) % n];
        if (a.y > y === b.y > y) continue; // 半開区間規則で頂点の二重カウントを防ぐ
        const t = (y - a.y) / (b.y - a.y);
        const x = a.x + (b.x - a.x) * t;
        const s = ring.prefix[i] + Math.hypot(b.x - a.x, b.y - a.y) * t;
        crossings.push({ x, ref: { ring: ri, s } });
      }
    }
    crossings.sort((p, q) => p.x - q.x);
    const segs: Seg[] = [];
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      if (crossings[i + 1].x - crossings[i].x < 1e-6) continue;
      segs.push({
        row: rows.length,
        y,
        x1: crossings[i].x,
        x2: crossings[i + 1].x,
        c1: crossings[i].ref,
        c2: crossings[i + 1].ref,
      });
    }
    rows.push(segs);
  }
  return { rows, rings };
}
