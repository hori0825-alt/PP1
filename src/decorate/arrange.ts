// 装飾配置 (ミラー・放射・万華鏡・回転コピー)。DOM 非依存・テスト可能。
// Region[] を入力にコピー配置した Region[] を返す。色は保持する。
// 反転で外周/穴の巻き方向が反転するため normalizeRegion で正す。

import { signedArea } from "../core/geometry";
import type { Region } from "../core/region";
import type { Point } from "../core/types";

export interface Center {
  x: number;
  y: number;
}

/** 外周を正の符号付き面積、穴を負に揃える (反転後の修復) */
export function normalizeRegion(r: Region): Region {
  const outer = signedArea(r.outer) < 0 ? [...r.outer].reverse() : r.outer;
  const holes = r.holes.map((h) => (signedArea(h) > 0 ? [...h].reverse() : h));
  return { outer, holes, color: r.color, selfIntersecting: r.selfIntersecting };
}

function rotateAround(p: Point, c: Center, ang: number): Point {
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

function mapRegion(r: Region, f: (p: Point) => Point): Region {
  return normalizeRegion({
    outer: r.outer.map(f),
    holes: r.holes.map((h) => h.map(f)),
    color: r.color,
  });
}

/** 軸 (x=axis または y=axis) で反転したコピーを作る */
export function rotateRegion(r: Region, center: Center, angleRad: number): Region {
  return mapRegion(r, (p) => rotateAround(p, center, angleRad));
}

/**
 * ミラー。axis='x' は垂直線 x=at で左右反転、axis='y' は水平線 y=at で上下反転。
 * keepOriginal=true で元 + 反転、false で反転のみ。
 */
export function makeMirror(
  regions: Region[],
  axis: "x" | "y",
  at = 0,
  keepOriginal = true,
): Region[] {
  const flip = (p: Point): Point =>
    axis === "x" ? { x: 2 * at - p.x, y: p.y } : { x: p.x, y: 2 * at - p.y };
  const mirrored = regions.map((r) => mapRegion(r, flip));
  return keepOriginal ? [...regions, ...mirrored] : mirrored;
}

export interface RadialOptions {
  /** 総個数 (元を含む) */
  count: number;
  center?: Center;
  /** 各コピーを配置角度ぶん自転させる (デフォルト true) */
  rotateEach?: boolean;
}

/**
 * 放射状 (円形・リース) コピー。中心まわりに count 個を等角配置する。
 * rotateEach=false なら自転せず平行移動的に回す (中心からの相対位置のみ回転)。
 */
export function makeRadial(regions: Region[], options: RadialOptions): Region[] {
  const center = options.center ?? { x: 0, y: 0 };
  const count = Math.max(1, Math.floor(options.count));
  const out: Region[] = [];
  for (let i = 0; i < count; i++) {
    const ang = (2 * Math.PI * i) / count;
    for (const r of regions) {
      out.push(options.rotateEach === false ? translateOrbit(r, center, ang) : rotateRegion(r, center, ang));
    }
  }
  return out;
}

/** 自転させずに中心まわりの位置だけ回す (各コピーの向きは元のまま) */
function translateOrbit(r: Region, center: Center, ang: number): Region {
  // 重心を回転先へ移動する平行移動
  const cx = r.outer.reduce((s, p) => s + p.x, 0) / r.outer.length;
  const cy = r.outer.reduce((s, p) => s + p.y, 0) / r.outer.length;
  const dest = rotateAround({ x: cx, y: cy }, center, ang);
  const dx = dest.x - cx;
  const dy = dest.y - cy;
  return mapRegion(r, (p) => ({ x: p.x + dx, y: p.y + dy }));
}

export interface KaleidoscopeOptions {
  /** セグメント数 (各セグメントは回転コピー + 鏡像のペア) */
  segments: number;
  center?: Center;
}

/**
 * 万華鏡配置。segments 個の扇形に、回転コピーと鏡像を交互に並べる。
 * 結果は 2*segments 個 (元を含む)。
 */
export function makeKaleidoscope(regions: Region[], options: KaleidoscopeOptions): Region[] {
  const center = options.center ?? { x: 0, y: 0 };
  const seg = Math.max(1, Math.floor(options.segments));
  const out: Region[] = [];
  for (let i = 0; i < seg; i++) {
    const ang = (2 * Math.PI * i) / seg;
    // 回転コピー
    for (const r of regions) out.push(rotateRegion(r, center, ang));
    // 同じ扇のミラー (中心を通る角度 ang の線で反射 → 回転 + x反転 + 逆回転)
    for (const r of regions) {
      const mirroredThenRotated = mapRegion(r, (p) => {
        const local = rotateAround(p, center, -ang);
        const flipped = { x: 2 * center.x - local.x, y: local.y };
        return rotateAround(flipped, center, ang);
      });
      out.push(mirroredThenRotated);
    }
  }
  return out;
}
