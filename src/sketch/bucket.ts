// バケツ塗り: 線で囲まれた範囲をタップすると、その形の「面」を作る。
//
//   1. 見える線をグリッド (既定 0.2mm) に描き込んで「壁」を作る
//   2. 手描きの小さな隙間を閉じるため、壁を少し太らせてから塗り広げる (flood fill)
//   3. 塗った範囲を線の中心まで広げる (刺繍の定石: 面は線の下に潜り込ませ、
//      縫い縮みで隙間が出ないようにする。線は上のレイヤーで後から縫う)
//   4. 範囲の輪郭をたどり、外周と穴に分けて滑らかなベクターにする
//
// グリッドを使うが、出力は平滑化したベクターなので刺繍の形は滑らか。

import { chaikinClosedMm, signedAreaMm, simplify } from "./geom";
import type { StrokeEl, Vec } from "./model";

export type BucketResult =
  | { ok: true; outer: Vec[]; holes: Vec[][]; areaMm2: number }
  | { ok: false; reason: "on-line" | "open" | "tiny" };

export interface BucketOptions {
  /** グリッド解像度 (mm/セル) */
  res?: number;
  /** この幅 (mm) までの線の隙間を閉じる */
  gapCloseMm?: number;
  /** 作業範囲 (mm、中心原点の正方形) */
  areaMm?: number;
}

export function bucketFill(strokes: StrokeEl[], at: Vec, opts: BucketOptions = {}): BucketResult {
  const res = opts.res ?? 0.2;
  const areaMm = opts.areaMm ?? 104;
  const half = areaMm / 2;
  const N = Math.round(areaMm / res);
  const toCell = (v: number) => (v + half) / res;

  // 1. 壁 (線) を描き込む。太さは線の太さ (細すぎる線は最低 0.4mm 扱い)
  const wall = new Uint8Array(N * N);
  let maxHalfW = 0;
  for (const s of strokes) {
    const r = Math.max(0.2, s.width / 2);
    maxHalfW = Math.max(maxHalfW, r);
    const pts = s.closed && s.points.length > 2 ? [...s.points, s.points[0]] : s.points;
    if (pts.length === 1) stampCapsule(wall, N, toCell(pts[0].x), toCell(pts[0].y), toCell(pts[0].x), toCell(pts[0].y), r / res);
    for (let i = 1; i < pts.length; i++) {
      stampCapsule(
        wall,
        N,
        toCell(pts[i - 1].x),
        toCell(pts[i - 1].y),
        toCell(pts[i].x),
        toCell(pts[i].y),
        r / res,
      );
    }
  }

  const cx = Math.floor(toCell(at.x));
  const cy = Math.floor(toCell(at.y));
  if (cx < 0 || cy < 0 || cx >= N || cy >= N) return { ok: false, reason: "open" };
  if (wall[cy * N + cx]) return { ok: false, reason: "on-line" };

  // 2. 隙間を閉じた壁で塗り広げる
  const gapR = Math.max(0, Math.round(((opts.gapCloseMm ?? 1.0) / 2) / res));
  const closedWall = gapR > 0 ? dilate(wall, N, gapR, null) : wall;
  // タップ位置が太らせた壁に埋もれたら、元の壁で塗る (細い隙間の中をタップした場合)
  const barrier = closedWall[cy * N + cx] ? wall : closedWall;
  const region = new Uint8Array(N * N);
  const stack = [cy * N + cx];
  region[cy * N + cx] = 1;
  let touchesEdge = false;
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % N;
    const y = (i / N) | 0;
    if (x === 0 || y === 0 || x === N - 1 || y === N - 1) {
      touchesEdge = true;
      break;
    }
    const nb = [i - 1, i + 1, i - N, i + N];
    for (const j of nb) {
      if (!region[j] && !barrier[j]) {
        region[j] = 1;
        stack.push(j);
      }
    }
  }
  if (touchesEdge) return { ok: false, reason: "open" };

  // 3. 線の下へ潜り込ませる (壁のセルにだけ広げる = 隣の区画には漏れない)
  const underR = Math.round(Math.min(1.5, maxHalfW) / res) + gapR;
  const grown = underR > 0 ? dilate(region, N, underR, barrier === wall ? wall : closedWall) : region;

  // 4. 輪郭をたどってベクター化
  const loops = traceLoops(grown, N);
  if (loops.length === 0) return { ok: false, reason: "tiny" };
  const toMm = (p: [number, number]): Vec => ({ x: p[0] * res - half, y: p[1] * res - half });
  const rings = loops
    .map((loop) => {
      const mmLoop = loop.map(toMm);
      return { ring: smoothRing(mmLoop), area: signedAreaMm(mmLoop) };
    })
    .filter((r) => r.ring.length >= 3);
  const outers = rings.filter((r) => r.area > 0).sort((a, b) => b.area - a.area);
  if (outers.length === 0 || outers[0].area < 0.5) return { ok: false, reason: "tiny" };
  const holes = rings.filter((r) => r.area < -0.3).map((r) => r.ring);
  return { ok: true, outer: outers[0].ring, holes, areaMm2: outers[0].area };
}

/** 線分 (太さ r セル) をグリッドに描き込む */
export function stampCapsule(
  grid: Uint8Array,
  N: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: number,
): void {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
  const x1 = Math.min(N - 1, Math.ceil(Math.max(ax, bx) + r));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
  const y1 = Math.min(N - 1, Math.ceil(Math.max(ay, by) + r));
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + dx * t - px;
      const qy = ay + dy * t - py;
      if (qx * qx + qy * qy <= r2) grid[y * N + x] = 1;
    }
  }
}

/**
 * 円形の膨張 (半径 r セル)。allowed を渡すと、そのセルにだけ広げる。
 * 距離変換 (2パスのチャンファー) で計算するので r が大きくても速い。
 */
export function dilate(src: Uint8Array, N: number, r: number, allowed: Uint8Array | null): Uint8Array {
  if (allowed) {
    // 許可セルの中だけを伝って広げる (BFS で測地距離)
    const out = src.slice();
    const distArr = new Int32Array(N * N).fill(-1);
    let frontier: number[] = [];
    for (let i = 0; i < src.length; i++) {
      if (src[i]) {
        distArr[i] = 0;
        frontier.push(i);
      }
    }
    for (let step = 1; step <= r && frontier.length > 0; step++) {
      const next: number[] = [];
      for (const i of frontier) {
        const x = i % N;
        const nbs = [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, i - N, i + N];
        for (const j of nbs) {
          if (j < 0 || j >= N * N || distArr[j] >= 0 || !allowed[j]) continue;
          distArr[j] = step;
          out[j] = 1;
          next.push(j);
        }
      }
      frontier = next;
    }
    return out;
  }
  // 無条件の膨張: チャンファー距離 (3-4) で近似円
  const INF = 1 << 29;
  const d = new Int32Array(N * N);
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : INF;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - N] + 3);
        if (x > 0) v = Math.min(v, d[i - N - 1] + 4);
        if (x < N - 1) v = Math.min(v, d[i - N + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = N - 1; y >= 0; y--) {
    for (let x = N - 1; x >= 0; x--) {
      const i = y * N + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < N - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < N - 1) {
        v = Math.min(v, d[i + N] + 3);
        if (x < N - 1) v = Math.min(v, d[i + N + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + N - 1] + 4);
      }
      d[i] = v;
    }
  }
  const out = new Uint8Array(N * N);
  const lim = r * 3;
  for (let i = 0; i < d.length; i++) if (d[i] <= lim) out[i] = 1;
  return out;
}

/**
 * セル境界をたどって閉路を作る。内側を右手に見る向きでたどるので、
 * 外周は符号付き面積が正、穴は負になる (+y 下の画面座標)。
 */
export function traceLoops(mask: Uint8Array, N: number): [number, number][][] {
  const W = N + 1;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N && mask[y * N + x] === 1;
  const edges = new Map<number, number[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = y0 * W + x0;
    const v = y1 * W + x1;
    const l = edges.get(k);
    if (l) l.push(v);
    else edges.set(k, [v]);
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) add(x, y, x + 1, y);
      if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!inside(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const loops: [number, number][][] = [];
  for (const [start, outs] of edges) {
    while (outs.length > 0) {
      const loop: [number, number][] = [[start % W, (start / W) | 0]];
      let prev = start;
      let cur = outs.pop()!;
      let guard = 0;
      while (cur !== start && guard++ < 4_000_000) {
        loop.push([cur % W, (cur / W) | 0]);
        const cands = edges.get(cur);
        if (!cands || cands.length === 0) break;
        let pick = 0;
        if (cands.length > 1) {
          // 斜めに接する角では内側 (右) へ曲がる方を選び、4連結の形を保つ
          const ix = (cur % W) - (prev % W);
          const iy = ((cur / W) | 0) - ((prev / W) | 0);
          let best = -Infinity;
          for (let c = 0; c < cands.length; c++) {
            const ox = (cands[c] % W) - (cur % W);
            const oy = ((cands[c] / W) | 0) - ((cur / W) | 0);
            const cross = ix * oy - iy * ox;
            if (cross > best) {
              best = cross;
              pick = c;
            }
          }
        }
        prev = cur;
        cur = cands.splice(pick, 1)[0];
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

/** 画素の階段を消して滑らかな輪郭にする */
export function smoothRing(ring: Vec[]): Vec[] {
  // 一直線上の頂点を除いてから平滑化
  const pruned: Vec[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[(i - 1 + ring.length) % ring.length];
    const b = ring[i];
    const c = ring[(i + 1) % ring.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 1e-9) pruned.push(b);
  }
  if (pruned.length < 3) return ring;
  const smooth = chaikinClosedMm(pruned, 3);
  const s = simplify([...smooth, smooth[0]], 0.03);
  s.pop();
  return s.length >= 3 ? s : smooth;
}
