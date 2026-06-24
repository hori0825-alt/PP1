// 2D 幾何ユーティリティ (DOM 非依存)。
// パスは閉路を前提とした頂点列 (末尾→先頭が暗黙に接続)。座標は内部単位 (0.1mm)。

import type { Point } from "./types";

/** 符号付き面積 (シューレース / 2)。画面座標系 (+y 下) で時計回りが正 */
export function signedArea(path: Point[]): number {
  let s = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    const b = path[(i + 1) % path.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function pathBounds(path: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of path) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** 点がポリゴン内部にあるか (レイキャスティング) */
export function pointInPolygon(p: Point, path: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const a = path[i];
    const b = path[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 点から線分 ab への距離 */
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function dpRecurse(path: Point[], first: number, last: number, tolerance: number, keep: boolean[]): void {
  let maxD = -1;
  let maxI = -1;
  for (let i = first + 1; i < last; i++) {
    const d = pointSegmentDistance(path[i], path[first], path[last]);
    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }
  if (maxD > tolerance && maxI >= 0) {
    keep[maxI] = true;
    dpRecurse(path, first, maxI, tolerance, keep);
    dpRecurse(path, maxI, last, tolerance, keep);
  }
}

/**
 * Douglas-Peucker による点数削減 (開いた折れ線として処理)。
 * 閉路に使う場合は simplifyClosed を使うこと。
 */
export function douglasPeucker(path: Point[], tolerance: number): Point[] {
  if (path.length <= 2) return path.slice();
  const keep = new Array<boolean>(path.length).fill(false);
  keep[0] = true;
  keep[path.length - 1] = true;
  dpRecurse(path, 0, path.length - 1, tolerance, keep);
  return path.filter((_, i) => keep[i]);
}

/**
 * 閉路の Douglas-Peucker。最遠点ペアを固定アンカーにして2つの開折れ線として簡略化する。
 */
export function simplifyClosed(path: Point[], tolerance: number): Point[] {
  if (path.length <= 4) return path.slice();
  // 先頭から最も遠い点を対角アンカーにする
  let far = 0;
  let maxD = -1;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i].x - path[0].x, path[i].y - path[0].y);
    if (d > maxD) {
      maxD = d;
      far = i;
    }
  }
  const a = douglasPeucker(path.slice(0, far + 1), tolerance);
  const b = douglasPeucker([...path.slice(far), path[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/**
 * Chaikin のコーナーカットによる閉路スムージング。
 * 1回の適用で各辺が 1/4・3/4 点に置き換わり、角が丸まる。
 */
export function chaikinClosed(path: Point[], iterations = 1): Point[] {
  let pts = path;
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) return pts.slice();
    const next: Point[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      next.push({ x: a.x + (b.x - a.x) * 0.25, y: a.y + (b.y - a.y) * 0.25 });
      next.push({ x: a.x + (b.x - a.x) * 0.75, y: a.y + (b.y - a.y) * 0.75 });
    }
    pts = next;
  }
  return pts;
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

/**
 * 角を保存する Chaikin スムージング (閉路)。
 * 各頂点の屈曲角が cornerAngleDeg 以上なら「角」とみなして位置を固定し、
 * それ未満のゆるい頂点だけを丸める。ロゴ・文字の直角やセリフ、星型の尖りを
 * 残しつつ、曲線部のピクセル階段だけを滑らかにする。
 * Douglas-Peucker で簡略化した後 (=意味のある頂点だけ残った状態) に適用する前提。
 */
export function chaikinClosedPreserveCorners(
  path: Point[],
  iterations: number,
  cornerAngleDeg = 60,
): Point[] {
  let pts = path;
  for (let it = 0; it < iterations; it++) {
    const n = pts.length;
    if (n < 3) return pts.slice();
    const next: Point[] = [];
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n];
      const cur = pts[i];
      const nxt = pts[(i + 1) % n];
      if (turnAngleDeg(prev, cur, nxt) >= cornerAngleDeg) {
        next.push({ x: cur.x, y: cur.y }); // 角は固定して丸めない
      } else {
        // ゆるい頂点は前後へ 1/4 ずつ寄せた2点に置換 (角を切り落として丸める)
        next.push({ x: cur.x + (prev.x - cur.x) * 0.25, y: cur.y + (prev.y - cur.y) * 0.25 });
        next.push({ x: cur.x + (nxt.x - cur.x) * 0.25, y: cur.y + (nxt.y - cur.y) * 0.25 });
      }
    }
    pts = next;
  }
  return pts;
}

/**
 * 方向ベクトル (dx,dy) からステッチ角度 (度) を求める。
 * ステッチの向きは 180° 周期 (逆向きでも縫い目は同じ) なので [0,180) に正規化する。
 */
export function angleDegFromVector(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  deg = ((deg % 180) + 180) % 180;
  return deg;
}

/** ポリゴンの面積重心。退化時は先頭点を返す */
export function polygonCentroid(path: Point[]): Point {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const q = path[(i + 1) % path.length];
    const cross = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
    a += cross;
  }
  if (Math.abs(a) < 1e-9) return path[0];
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

function orient(a: Point, b: Point, c: Point): number {
  return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

/** 線分 ab と cd が (端点共有を除いて) 交差するか */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

/** 閉路の自己交差を検出 (隣接辺は除く)。O(n^2) */
export function selfIntersects(path: Point[]): boolean {
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const a = path[i];
    const b = path[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // 隣接 (末尾→先頭)
      const c = path[j];
      const d = path[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}
