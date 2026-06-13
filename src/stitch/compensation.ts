// 縫い補正と密度補正 (DOM 非依存・テスト可能)。
//
// 用語の定義 (本実装の規約):
//   - sewAngle = タタミ/サテンのステッチが走る方向 (度)。
//   - Pull 補正: ステッチ方向に対して「直交」方向へ領域を広げる。
//     縫うと糸の張力で帯が細る (縫い縮み) ぶんを見越して予め太らせる。
//   - Push 補正: ステッチ方向に「沿って」領域をわずかに縮める。
//     ステッチ端で布が押し出される (はみ出す) ぶんを抑える。
//
// 実装はステッチ方向を x 軸に回した座標系での重心基準スケール (異方拡縮)。
// 小さな補正値 (〜0.5mm) 向けの近似で、オフセットのような自己交差リスクがない。

import { polygonCentroid, signedArea } from "../core/geometry";
import type { Region } from "../core/region";
import type { Point } from "../core/types";

export interface CompensationParams {
  /** Pull 補正量 (内部単位)。直交方向の片側拡張量 */
  pull: number;
  /** Push 補正量 (内部単位)。ステッチ方向の片側収縮量 */
  push: number;
  /** ステッチ方向 (ラジアン) */
  sewAngleRad: number;
}

/** 領域の正味面積 (内部単位²)。穴を差し引く */
export function regionArea(region: Region): number {
  return (
    Math.abs(signedArea(region.outer)) -
    region.holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0)
  );
}

/** 領域バウンディングの短辺 (内部単位)。Small Object 判定に使う */
export function regionMinExtent(region: Region): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of region.outer) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return Math.min(maxX - minX, maxY - minY);
}

/**
 * Pull/Push 補正を領域に適用する。
 * ステッチ方向を x 軸に回した系で、x (沿う方向) を push ぶん縮め、
 * y (直交方向) を pull ぶん広げる重心基準スケール。
 */
export function compensateRegion(region: Region, params: CompensationParams): Region {
  if (params.pull <= 0 && params.push <= 0) return region;

  const c = polygonCentroid(region.outer);
  const cos = Math.cos(-params.sewAngleRad);
  const sin = Math.sin(-params.sewAngleRad);
  const cosB = Math.cos(params.sewAngleRad);
  const sinB = Math.sin(params.sewAngleRad);

  // 回転系での半幅・半長を測る
  let hx = 0;
  let hy = 0;
  for (const p of region.outer) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    hx = Math.max(hx, Math.abs(rx));
    hy = Math.max(hy, Math.abs(ry));
  }
  if (hx < 1e-6 || hy < 1e-6) return region;

  const scaleX = Math.max(0.3, (hx - params.push) / hx); // 沿う方向: 縮める
  const scaleY = (hy + params.pull) / hy; // 直交方向: 広げる

  const transform = (p: Point): Point => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    let rx = dx * cos - dy * sin;
    let ry = dx * sin + dy * cos;
    rx *= scaleX;
    ry *= scaleY;
    // 回転を戻す
    return { x: c.x + rx * cosB - ry * sinB, y: c.y + rx * sinB + ry * cosB };
  };

  return {
    outer: region.outer.map(transform),
    holes: region.holes.map((h) => h.map(transform)),
    color: region.color,
    selfIntersecting: region.selfIntersecting,
  };
}

/**
 * 密度補正 (Auto Density)。小さい面では密度を下げる (行間隔を広げる) ことで
 * 目詰まり・布の硬化を防ぐ。大きい面は基準密度を維持する。
 * @returns 補正後の行間隔 (内部単位)
 */
export function densityCompensatedSpacing(
  areaUnits2: number,
  baseSpacing: number,
  enabled: boolean,
): number {
  if (!enabled) return baseSpacing;
  // 150mm² (=15000 内部単位²) 未満で徐々に間隔を広げ (密度を下げ)、最大 1.4 倍まで。
  // 小さい面・文字での目詰まりと布の硬化を防ぐ。
  const threshold = 15000;
  if (areaUnits2 >= threshold) return baseSpacing;
  const factor = 1 + (1 - areaUnits2 / threshold) * 0.4;
  return baseSpacing * factor;
}
