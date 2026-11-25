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

// ------------------------------------------------------------------ 滑らかな曲線

/** 頂点 i での曲がる角度 (度) */
function turnDeg(a: Vec, b: Vec, c: Vec): number {
  const a1 = Math.atan2(b.y - a.y, b.x - a.x);
  const a2 = Math.atan2(c.y - b.y, c.x - b.x);
  let t = Math.abs(a2 - a1);
  if (t > Math.PI) t = 2 * Math.PI - t;
  return (t * 180) / Math.PI;
}

/** はっきり曲げた角 (cornerDeg 以上曲がる頂点) の番号 */
export function cornerIndices(pts: Vec[], closed: boolean, cornerDeg = 65): number[] {
  const n = pts.length;
  const out: number[] = [];
  if (n < 3) return out;
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const a = pts[(i - 1 + n) % n];
    const c = pts[(i + 1) % n];
    if (turnDeg(a, pts[i], c) >= cornerDeg) out.push(i);
  }
  return out;
}

/** Catmull-Rom (centripetal) で p1→p2 の区間を補間する */
function catmullRom(p0: Vec, p1: Vec, p2: Vec, p3: Vec, steps: number, out: Vec[]): void {
  const tj = (ti: number, a: Vec, b: Vec) => ti + Math.max(1e-4, Math.sqrt(dist(a, b)));
  const t0 = 0;
  const t1 = tj(t0, p0, p1);
  const t2 = tj(t1, p1, p2);
  const t3 = tj(t2, p2, p3);
  const lerp = (a: Vec, b: Vec, ta: number, tb: number, t: number): Vec => {
    const u = tb - ta < 1e-9 ? 0 : (t - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  };
  for (let s = 1; s <= steps; s++) {
    const t = t1 + ((t2 - t1) * s) / steps;
    const a1 = lerp(p0, p1, t0, t1, t);
    const a2 = lerp(p1, p2, t1, t2, t);
    const a3 = lerp(p2, p3, t2, t3, t);
    const b1 = lerp(a1, a2, t0, t2, t);
    const b2 = lerp(a2, a3, t1, t3, t);
    out.push(lerp(b1, b2, t1, t2, t));
  }
}

/** 角で区切った1区間を、点を通る滑らかな曲線にする */
function smoothPiece(p: Vec[], step: number): Vec[] {
  if (p.length < 3) return p.slice();
  const out: Vec[] = [p[0]];
  // 端は延長した仮の点を使い、区間の向きをそのまま保つ
  const first = { x: 2 * p[0].x - p[1].x, y: 2 * p[0].y - p[1].y };
  const last = { x: 2 * p[p.length - 1].x - p[p.length - 2].x, y: 2 * p[p.length - 1].y - p[p.length - 2].y };
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = i === 0 ? first : p[i - 1];
    const p3 = i + 2 < p.length ? p[i + 2] : last;
    const steps = Math.max(1, Math.ceil(dist(p[i], p[i + 1]) / step));
    catmullRom(p0, p[i], p[i + 1], p3, steps, out);
  }
  return out;
}

/**
 * 描いた線の点を通る滑らかな曲線 (step mm おきの点列) にする。
 * はっきり曲げた角 (cornerDeg 以上) は角のまま残す。閉じた線は始点に戻らない点列を返す。
 */
export function smoothCurve(pts: Vec[], closed: boolean, step = 0.25, cornerDeg = 65): Vec[] {
  if (pts.length < 3) return pts.slice();
  const corners = cornerIndices(pts, closed, cornerDeg);
  if (!closed) {
    const cuts = [0, ...corners, pts.length - 1];
    const out: Vec[] = [];
    for (let k = 0; k < cuts.length - 1; k++) {
      const piece = smoothPiece(pts.slice(cuts[k], cuts[k + 1] + 1), step);
      out.push(...(k === 0 ? piece : piece.slice(1)));
    }
    return out;
  }
  const n = pts.length;
  if (corners.length === 0) {
    // 角のない閉じた線: 前後の点を回り込んで使う
    const out: Vec[] = [];
    for (let i = 0; i < n; i++) {
      const steps = Math.max(1, Math.ceil(dist(pts[i], pts[(i + 1) % n]) / step));
      out.push(pts[i]);
      const seg: Vec[] = [];
      catmullRom(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n], pts[(i + 2) % n], steps, seg);
      seg.pop(); // 次の頂点は次の区間で入れる
      out.push(...seg);
    }
    return out;
  }
  // 角のある閉じた線: 角から角へ区切って滑らかにする (始点は元の始点のまま)
  const out: Vec[] = [];
  const cs = corners;
  for (let k = 0; k < cs.length; k++) {
    const a = cs[k];
    const b = cs[(k + 1) % cs.length];
    const piece: Vec[] = [];
    for (let i = a; ; i = (i + 1) % n) {
      piece.push(pts[i]);
      if (i === b && piece.length > 1) break;
      if (piece.length > n + 1) break;
    }
    const sm = smoothPiece(piece, step);
    out.push(...sm.slice(0, -1));
  }
  // 元の始点 (pts[0]) から始まるように回す
  let best = 0;
  let bd = Infinity;
  out.forEach((q, i) => {
    const d = dist(q, pts[0]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return [...out.slice(best), ...out.slice(0, best)];
}

/**
 * 曲線に沿って針の位置を決める。曲線からのずれ (弦の膨らみ) が sag mm 以内に収まるよう、
 * 急なカーブほど針目を短くする (minLen 〜 maxLen)。path は密な点列 (smoothCurve の結果)。
 */
export function resampleAdaptive(path: Vec[], maxLen: number, minLen = 1.0, sag = 0.1): Vec[] {
  if (path.length < 2) return path.slice();
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + dist(path[i - 1], path[i]));
  const total = cum[cum.length - 1];
  if (total < 1e-6) return [path[0]];
  const at = (s: number): Vec => {
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= s) lo = m;
      else hi = m;
    }
    const L = cum[hi] - cum[lo];
    const u = L < 1e-9 ? 0 : (s - cum[lo]) / L;
    return { x: path[lo].x + (path[hi].x - path[lo].x) * u, y: path[lo].y + (path[hi].y - path[lo].y) * u };
  };
  // s0 から s1 までの弦から、間の点がどれだけ離れるか
  const deviation = (s0: number, s1: number): number => {
    const a = at(s0);
    const b = at(s1);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    let worst = 0;
    // s0 より後ろの最初の点から調べる (二分探索)
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= s0) lo = m + 1;
      else hi = m;
    }
    for (let i = lo; i < path.length && cum[i] < s1; i++) {
      const p = path[i];
      const d = L < 1e-9 ? dist(p, a) : Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L;
      if (d > worst) worst = d;
    }
    return worst;
  };
  const out: Vec[] = [path[0]];
  let s = 0;
  while (total - s > 1e-6) {
    const rest = total - s;
    if (rest <= maxLen && deviation(s, total) <= sag) {
      // 残りが1針で縫えるなら終点へ
      out.push(path[path.length - 1]);
      break;
    }
    let len = Math.min(maxLen, rest);
    while (len > minLen && deviation(s, s + len) > sag) len -= 0.1;
    len = Math.max(Math.min(minLen, rest), len);
    // 残りが半端 (最短より短い針目) にならないよう、最後の2針は均等に。
    // 2つに分けると最短を下回るなら、少し長めの1針にする
    if (rest - len < minLen && rest > len) len = rest < 2 * minLen ? rest : rest / 2;
    s += len;
    out.push(at(s));
  }
  return out;
}
