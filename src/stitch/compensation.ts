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
  // パーツ固有プロパティ (fillType / angleDeg 等) を保ったまま輪郭だけ補正するための土台
  const withGeometry = (outer: Point[], holes: Point[][]): Region => ({
    ...region,
    outer,
    holes,
  });
  if (params.pull <= 0 && params.push <= 0) return region;
  // 極小領域は補正をスキップ (補正量が領域サイズと同程度だと潰れる)
  if (regionMinExtent(region) < 20) return region;

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

  return withGeometry(
    region.outer.map(transform),
    region.holes.map((h) => h.map(transform)),
  );
}

/** 外周点列の主軸 (最大分散方向 = 長軸) の角度 (ラジアン)。PCA の固有方向 */
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

/**
 * サテン列向けの Pull 補正。
 *
 * サテンは糸が列を横断して張るため、張力で列の「幅」が縮む (縫い縮み)。これを
 * 見越して、主軸 (長軸) に直交する方向 = 列幅を pull ぶん (片側) 予め広げる。
 *
 * 汎用の compensateRegion は「ステッチ方向に直交する向き」を広げる規約で、これは
 * タタミ (行方向に縮む) 向き。サテンの実際の縫い方向 (列を横断) とは軸が合わないため、
 * サテン列にはこの専用補正を使う。
 *
 * 幅を広げるだけ (縮めない) ので列が潰れず、汎用補正が弾いていた細い列
 * (regionMinExtent < 2mm) にも安全に適用できる。むしろ細い列ほど縫い縮みの比率が
 * 大きいため、ここを補正できることがサテン品質の要になる。
 */
export function compensateSatinColumn(region: Region, pull: number): Region {
  if (pull <= 0) return region;
  const theta = principalAngle(region.outer); // 長軸の角度
  const c = polygonCentroid(region.outer);
  const cos = Math.cos(-theta);
  const sin = Math.sin(-theta);
  const cosB = Math.cos(theta);
  const sinB = Math.sin(theta);
  // 長軸を x 軸に回した系で、短軸 (= 列幅) の半幅を測る
  let hy = 0;
  for (const p of region.outer) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const ry = dx * sin + dy * cos;
    hy = Math.max(hy, Math.abs(ry));
  }
  if (hy < 1e-6) return region;
  // 片側拡張量は列の半幅を超えない (幅は最大でも2倍まで) ようクランプ (過拡張防止)
  const eff = Math.min(pull, hy);
  const scaleY = (hy + eff) / hy;
  const transform = (p: Point): Point => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const rx = dx * cos - dy * sin;
    let ry = dx * sin + dy * cos;
    ry *= scaleY; // 列幅だけを広げる (長軸方向 rx は不変)
    return { x: c.x + rx * cosB - ry * sinB, y: c.y + rx * sinB + ry * cosB };
  };
  return {
    ...region,
    outer: region.outer.map(transform),
    holes: region.holes.map((h) => h.map(transform)),
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
  // 極小領域は密度補正をスキップ (走査行が通らなくなる)
  if (areaUnits2 < 100) return baseSpacing;
  // 150mm² (=15000 内部単位²) 未満で徐々に間隔を広げ (密度を下げ)、最大 1.4 倍まで。
  // 小さい面・文字での目詰まりと布の硬化を防ぐ。
  const threshold = 15000;
  if (areaUnits2 >= threshold) return baseSpacing;
  const factor = 1 + (1 - areaUnits2 / threshold) * 0.4;
  return baseSpacing * factor;
}
