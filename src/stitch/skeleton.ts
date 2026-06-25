// 線画アウトライン: 領域を骨格化 (Zhang-Suen thinning) して中心線を取り、
// サテン列 (太い線) またはビーン (三重) 縫い (細い線) で「線」として縫う。
//
// 目的:
//   - ロゴ・アニメ絵・チュートリアル風の線画を、塗り (タタミ) ではなく線として縫う。
//   - サテンの光沢で品質を保ちつつ、塗りに比べ針数・糸切りを大幅に削減する。
//   - analyzeStroke は単純な1本のリボン専用だが、本モジュールは分岐した線
//     ネットワーク (ベアの輪郭など) も骨格グラフを辿って扱える。

import { mm } from "../core/constants";
import type { Region } from "../core/region";
import type { Point, StitchRun } from "../core/types";
import { resamplePolyline, satinFromRails } from "./satin";
import type { GeneratorResult } from "./types";

export interface SkeletonStitchParams {
  /** ラスタ化解像度 (units/px)。小さいほど精密だが重い。既定 0.25mm */
  unitsPerPixel?: number;
  /** サテン列のステッチ長 (中心線の再サンプル間隔)。既定 2.0mm */
  stitchLength?: number;
  /** この幅以上はサテン列、未満はビーン(三重)縫い。既定 1.0mm */
  satinMinWidth?: number;
  /** 線とみなす最大幅 (内部単位)。これを超える太い面はアウトライン化しない。既定 8mm */
  maxWidth?: number;
}

interface Raster {
  mask: Uint8Array;
  w: number;
  h: number;
  ox: number; // ピクセル px の中心 x = ox + (px + 0.5) * upp
  oy: number;
  upp: number;
}

const round = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** 領域 (外周 - 穴) を upp(units/px) でラスタ化する。even-odd 規則で穴も処理。 */
function rasterize(region: Region, upp: number): Raster | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of region.outer) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return null;
  const pad = 2;
  const ox = minX - pad * upp;
  const oy = minY - pad * upp;
  const w = Math.ceil((maxX - minX) / upp) + 2 * pad + 1;
  const h = Math.ceil((maxY - minY) / upp) + 2 * pad + 1;
  if (w < 3 || h < 3 || w * h > 4_000_000) return null;
  const mask = new Uint8Array(w * h);
  const rings = [region.outer, ...region.holes];
  for (let py = 0; py < h; py++) {
    const y = oy + (py + 0.5) * upp;
    const xs: number[] = [];
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        if (a.y > y === b.y > y) continue;
        const t = (y - a.y) / (b.y - a.y);
        xs.push((a.x + (b.x - a.x) * t - ox) / upp);
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(xs[i] - 0.5));
      const x1 = Math.min(w - 1, Math.floor(xs[i + 1] - 0.5));
      for (let px = x0; px <= x1; px++) mask[py * w + px] = 1;
    }
  }
  return { mask, w, h, ox, oy, upp };
}

/** 元マスクの距離変換 (背景までの近似ユークリッド距離, px)。線の半幅推定に使う。 */
function distanceTransform(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  const D = 1;
  const D2 = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + D);
      if (y > 0) m = Math.min(m, d[i - w] + D);
      if (x > 0 && y > 0) m = Math.min(m, d[i - w - 1] + D2);
      if (x < w - 1 && y > 0) m = Math.min(m, d[i - w + 1] + D2);
      d[i] = m;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let m = d[i];
      if (x < w - 1) m = Math.min(m, d[i + 1] + D);
      if (y < h - 1) m = Math.min(m, d[i + w] + D);
      if (x < w - 1 && y < h - 1) m = Math.min(m, d[i + w + 1] + D2);
      if (x > 0 && y < h - 1) m = Math.min(m, d[i + w - 1] + D2);
      d[i] = m;
    }
  }
  return d;
}

/** Zhang-Suen 細線化。mask を 1px 幅の骨格へ破壊的に変換する。 */
function thinZhangSuen(mask: Uint8Array, w: number, h: number): void {
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x];
  const toClear: number[] = [];
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      toClear.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (mask[y * w + x] === 0) continue;
          const p2 = at(x, y - 1);
          const p3 = at(x + 1, y - 1);
          const p4 = at(x + 1, y);
          const p5 = at(x + 1, y + 1);
          const p6 = at(x, y + 1);
          const p7 = at(x - 1, y + 1);
          const p8 = at(x - 1, y);
          const p9 = at(x - 1, y - 1);
          const nb = [p2, p3, p4, p5, p6, p7, p8, p9];
          let b = 0;
          for (const v of nb) b += v;
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let k = 0; k < 8; k++) if (nb[k] === 0 && nb[(k + 1) % 8] === 1) a++;
          if (a !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }
          toClear.push(y * w + x);
        }
      }
      if (toClear.length > 0) {
        changed = true;
        for (const i of toClear) mask[i] = 0;
      }
    }
  }
}

/** 骨格を折れ線群 (ピクセルインデックス列) に辿る。ノード (端点・分岐) で区切る。 */
function tracePaths(skel: Uint8Array, w: number, h: number): number[][] {
  const neighbors = (i: number): number[] => {
    const x = i % w;
    const y = (i / w) | 0;
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (skel[ny * w + nx]) out.push(ny * w + nx);
      }
    }
    return out;
  };
  const deg = new Map<number, number>();
  const pixels: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!skel[i]) continue;
    deg.set(i, neighbors(i).length);
    pixels.push(i);
  }
  const used = new Set<string>();
  const key = (a: number, b: number): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const paths: number[][] = [];

  const walkFrom = (start: number): void => {
    for (const first of neighbors(start)) {
      if (used.has(key(start, first))) continue;
      const path = [start, first];
      used.add(key(start, first));
      let prev = start;
      let cur = first;
      while ((deg.get(cur) ?? 0) === 2) {
        let next = -1;
        for (const nb of neighbors(cur)) {
          if (nb !== prev && !used.has(key(cur, nb))) {
            next = nb;
            break;
          }
        }
        if (next < 0) break;
        used.add(key(cur, next));
        path.push(next);
        prev = cur;
        cur = next;
      }
      paths.push(path);
    }
  };

  // ノード (端点 deg=1 / 分岐 deg>=3) から辿る
  for (const i of pixels) if ((deg.get(i) ?? 0) !== 2) walkFrom(i);
  // 残った純粋なループ (全 deg=2) を拾う
  for (const i of pixels) {
    for (const nb of neighbors(i)) {
      if (!used.has(key(i, nb))) {
        walkFrom(i);
        break;
      }
    }
  }
  return paths;
}

/** 中心線を左右へ ±half オフセットしたレール対を作る (頂点法線の平均)。 */
function offsetRails(c: Point[], half: number): { left: Point[]; right: Point[] } {
  const n = c.length;
  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < n; i++) {
    let nx = 0;
    let ny = 0;
    const add = (a: Point, b: Point): void => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy);
      if (l < 1e-9) return;
      nx += -dy / l;
      ny += dx / l;
    };
    if (i > 0) add(c[i - 1], c[i]);
    if (i < n - 1) add(c[i], c[i + 1]);
    const l = Math.hypot(nx, ny);
    if (l > 1e-9) {
      nx /= l;
      ny /= l;
    }
    left.push({ x: c[i].x + nx * half, y: c[i].y + ny * half });
    right.push({ x: c[i].x - nx * half, y: c[i].y - ny * half });
  }
  return { left, right };
}

/** ビーン (三重) 縫い: 中心線を 前→後→前 の3回なぞって細い線を太く・高品質に縫う。 */
function beanRun(center: Point[]): StitchRun {
  const fwd = center.map(round);
  const back = [...fwd].reverse();
  const stitches = [...fwd, ...back.slice(1), ...fwd.slice(1)];
  return { stitches, connection: "trim" };
}

/**
 * 領域を「線」として骨格化してステッチ化する。
 * 細すぎる/太すぎる、または骨格が取れない場合は runs 空を返し、呼び出し側が
 * 通常のフィルにフォールバックする。
 */
export function skeletonStitch(region: Region, params: SkeletonStitchParams = {}): GeneratorResult {
  const upp = params.unitsPerPixel ?? mm(0.25);
  const satinMinWidth = params.satinMinWidth ?? mm(1.0);
  const maxWidth = params.maxWidth ?? mm(8);
  const stitchLength = params.stitchLength ?? mm(2.0);

  const r = rasterize(region, upp);
  if (!r) return { runs: [], warnings: [] };

  const dist = distanceTransform(r.mask, r.w, r.h); // 半幅(px)、細線化前のマスクで計算
  const skel = r.mask.slice();
  thinZhangSuen(skel, r.w, r.h);
  const paths = tracePaths(skel, r.w, r.h);
  if (paths.length === 0) return { runs: [], warnings: [] };

  const toUnit = (i: number): Point => ({
    x: r.ox + ((i % r.w) + 0.5) * r.upp,
    y: r.oy + (((i / r.w) | 0) + 0.5) * r.upp,
  });

  const runs: StitchRun[] = [];
  let tooWide = false;
  for (const path of paths) {
    if (path.length < 3) continue;
    const widthsPx = path.map((i) => dist[i] * 2).sort((a, b) => a - b);
    const width = (widthsPx[Math.floor(widthsPx.length / 2)] || 0) * r.upp;
    if (width > maxWidth) {
      tooWide = true;
      continue; // 太い面はアウトライン化しない (塗りに任せる)
    }
    let center = resamplePolyline(path.map(toUnit), stitchLength);
    if (center.length < 2) continue;
    if (width >= satinMinWidth) {
      const { left, right } = offsetRails(center, width / 2);
      runs.push(satinFromRails(left, right));
    } else {
      runs.push(beanRun(center));
    }
  }
  // 全パスが太すぎてアウトライン化できなかった場合はフィルに任せる
  if (runs.length === 0 && tooWide) return { runs: [], warnings: [] };
  return { runs, warnings: [] };
}
