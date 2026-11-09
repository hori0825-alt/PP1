// PP1 Sketch の幾何ユーティリティ (mm 空間)。

import type { Vec } from "./model";

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function polylineLength(pts: Vec[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

/** 近すぎる点を間引く (手描きの細かい震えを除く) */
export function dedupe(pts: Vec[], minGap: number): Vec[] {
  if (pts.length === 0) return [];
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (dist(out[out.length - 1], pts[i]) >= minGap) out.push(pts[i]);
  }
  const last = pts[pts.length - 1];
  if (out.length === 1 || dist(out[out.length - 1], last) > 1e-6) {
    if (out.length > 1 && dist(out[out.length - 1], last) < minGap * 0.5) out[out.length - 1] = last;
    else if (out[out.length - 1] !== last) out.push(last);
  }
  return out;
}

/** 開いた折れ線の Chaikin 平滑化 (端点は固定) */
export function chaikinOpen(pts: Vec[], iterations: number): Vec[] {
  let p = pts;
  for (let it = 0; it < iterations && p.length > 2; it++) {
    const out: Vec[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      if (i > 0) out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      if (i < p.length - 2) out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

/** 閉路の Chaikin 平滑化 */
export function chaikinClosedMm(pts: Vec[], iterations: number): Vec[] {
  let p = pts;
  for (let it = 0; it < iterations && p.length > 2; it++) {
    const out: Vec[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    p = out;
  }
  return p;
}

function segDist(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Douglas-Peucker (開いた折れ線) */
export function simplify(pts: Vec[], tol: number): Vec[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [i0, i1] = stack.pop()!;
    let maxD = -1;
    let maxI = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = segDist(pts[i], pts[i0], pts[i1]);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > tol && maxI > 0) {
      keep[maxI] = 1;
      stack.push([i0, maxI], [maxI, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * 手描きの線を刺繍向けに整える: 震えを間引き → 平滑化 → 点数削減。
 * 線がガタつくとサテンが波打つため、ここで滑らかにしておく。
 */
export function cleanStroke(raw: Vec[]): Vec[] {
  const d = dedupe(raw, 0.25);
  if (d.length < 3) return d;
  return simplify(chaikinOpen(d, 2), 0.04);
}

/** 閉じた輪郭を整える */
export function cleanRing(raw: Vec[]): Vec[] {
  let d = dedupe(raw, 0.25);
  if (d.length > 3 && dist(d[0], d[d.length - 1]) < 0.3) d = d.slice(0, -1);
  if (d.length < 3) return d;
  const smoothed = chaikinClosedMm(d, 2);
  // 閉路の DP は始点を固定した開路として扱えば十分
  const s = simplify([...smoothed, smoothed[0]], 0.04);
  s.pop();
  return s.length >= 3 ? s : smoothed;
}

export function signedAreaMm(ring: Vec[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function pointInRing(p: Vec, ring: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 面 (外周 - 穴) の内側か */
export function pointInShape(p: Vec, outer: Vec[], holes: Vec[][]): boolean {
  if (!pointInRing(p, outer)) return false;
  for (const h of holes) if (pointInRing(p, h)) return false;
  return true;
}

/** 点と折れ線の最短距離 */
export function distToPolyline(p: Vec, pts: Vec[], closed = false): number {
  if (pts.length === 1) return dist(p, pts[0]);
  let best = Infinity;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    best = Math.min(best, segDist(p, pts[i], pts[(i + 1) % pts.length]));
  }
  return best;
}

/** 閉路上で p に最も近い頂点の添字 */
export function nearestVertex(ring: Vec[], p: Vec): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = (ring[i].x - p.x) ** 2 + (ring[i].y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** 閉路を start 番目の頂点から始まるよう回転する */
export function rotateRing<T>(ring: T[], start: number): T[] {
  return [...ring.slice(start), ...ring.slice(0, start)];
}

/**
 * 鋭い角 (曲がり角 > maxTurnDeg) で折れ線を分割する。
 * サテンは急な角で折り返すと糸が団子になるため、角ごとに別の帯として縫う。
 */
export function splitAtCorners(pts: Vec[], maxTurnDeg: number): Vec[][] {
  if (pts.length < 3) return [pts];
  const limit = (maxTurnDeg * Math.PI) / 180;
  const parts: Vec[][] = [];
  let cur: Vec[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    cur.push(pts[i]);
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const a1 = Math.atan2(b.y - a.y, b.x - a.x);
    const a2 = Math.atan2(c.y - b.y, c.x - b.x);
    let turn = Math.abs(a2 - a1);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > limit && polylineLength(cur) > 1.0) {
      parts.push(cur);
      cur = [pts[i]];
    }
  }
  cur.push(pts[pts.length - 1]);
  parts.push(cur);
  return parts.filter((p) => p.length >= 2);
}

export function bbox(pts: Vec[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function centroid(pts: Vec[]): Vec {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}
