// サテン縫い。
// - satinFromRails: 左右レール (対になる点列) からジグザグを生成する共通コア
// - satinAlongPath: 中心線 + 幅からレールを作る (線のサテン/ジグザグライン用)
// - satinFromRegion: 細長い領域を主軸方向にスライスしてレールを抽出する
//   (本格的なスケルトン抽出は後フェーズ。PCA 主軸スライスで実用範囲をカバー)

import { SATIN_DEFAULT } from "../core/constants";
import type { Region } from "../core/region";
import type { Point, StitchRun } from "../core/types";
import { rotatePoint, scanRegion } from "./scanline";
import type { GeneratorResult, SatinParams } from "./types";

/** 左右レールからジグザグステッチを生成する (1本の連続 Run) */
export function satinFromRails(left: Point[], right: Point[]): StitchRun {
  const n = Math.min(left.length, right.length);
  const stitches: Point[] = [];
  for (let i = 0; i < n; i++) {
    stitches.push({ x: Math.round(left[i].x), y: Math.round(left[i].y) });
    stitches.push({ x: Math.round(right[i].x), y: Math.round(right[i].y) });
  }
  return { stitches, connection: "trim" };
}

/** 折れ線を等間隔 spacing で再サンプルする (両端を含む) */
export function resamplePolyline(path: Point[], spacing: number): Point[] {
  const lengths: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  }
  const total = lengths[lengths.length - 1];
  if (total < 1e-9) return [path[0]];
  const count = Math.max(1, Math.round(total / spacing));
  const out: Point[] = [];
  let seg = 0;
  for (let k = 0; k <= count; k++) {
    const target = (total * k) / count;
    while (seg + 1 < lengths.length - 1 && lengths[seg + 1] < target) seg++;
    const segLen = lengths[seg + 1] - lengths[seg];
    const u = segLen < 1e-9 ? 0 : (target - lengths[seg]) / segLen;
    out.push({
      x: path[seg].x + (path[seg + 1].x - path[seg].x) * u,
      y: path[seg].y + (path[seg + 1].y - path[seg].y) * u,
    });
  }
  return out;
}

/**
 * 中心線 + 幅からサテン (またはジグザグライン) を生成する。
 * 各サンプル点で進行方向の法線に ±width/2 オフセットしてレールを作る。
 */
export function satinAlongPath(
  path: Point[],
  width: number,
  spacing: number = SATIN_DEFAULT.spacing,
  maxWidth: number = SATIN_DEFAULT.maxWidth,
): GeneratorResult {
  const warnings: string[] = [];
  if (path.length < 2) return { runs: [], warnings: ["サテンの中心線が短すぎます"] };
  if (width > maxWidth) {
    warnings.push(
      `サテン幅 ${(width / 10).toFixed(1)}mm が上限 ${(maxWidth / 10).toFixed(1)}mm を超えています (タタミへの変換を推奨)`,
    );
  }
  const samples = resamplePolyline(path, spacing);
  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < samples.length; i++) {
    const prev = samples[Math.max(0, i - 1)];
    const next = samples[Math.min(samples.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    left.push({ x: samples[i].x + (nx * width) / 2, y: samples[i].y + (ny * width) / 2 });
    right.push({ x: samples[i].x - (nx * width) / 2, y: samples[i].y - (ny * width) / 2 });
  }
  return { runs: [satinFromRails(left, right)], warnings };
}

/** 外周点列から PCA で主軸角度を求める */
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

/** ある走査角度でのサテンレールと評価値 */
interface SatinBuild {
  left: Point[];
  right: Point[];
  /** 最大の 1 針スパン (レール間距離、内部単位) */
  maxW: number;
  /** 分岐 (1 行に複数区間) が出た行数 */
  branchCount: number;
  angleRad: number;
}

/** 指定角度で領域を走査し、各行の最も広い区間をレールにする */
function buildSatinAtAngle(region: Region, angleRad: number, spacing: number): SatinBuild {
  const { rows } = scanRegion(region, angleRad, spacing);
  const left: Point[] = [];
  const right: Point[] = [];
  let maxW = 0;
  let branchCount = 0;
  for (const row of rows) {
    if (row.length === 0) continue;
    if (row.length > 1) branchCount++;
    let seg = row[0];
    for (const s of row) {
      if (s.x2 - s.x1 > seg.x2 - seg.x1) seg = s;
    }
    maxW = Math.max(maxW, seg.x2 - seg.x1);
    left.push({ x: seg.x1, y: seg.y });
    right.push({ x: seg.x2, y: seg.y });
  }
  return { left, right, maxW, branchCount, angleRad };
}

/** 多角形 poly に対し、点 O から方向 (dx,dy) (単位) へ伸ばした半直線の最近交点 */
function rayHitPolygon(
  poly: Point[],
  O: Point,
  dx: number,
  dy: number,
  maxDist: number,
): Point | null {
  let bestT = Infinity;
  let best: Point | null = null;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const det = -ex * dy + dx * ey;
    if (Math.abs(det) < 1e-9) continue; // 平行
    const wx = O.x - a.x;
    const wy = O.y - a.y;
    const u = (-wx * dy + dx * wy) / det; // 辺上の位置 [0,1]
    const t = (ex * wy - ey * wx) / det; // 半直線上の距離
    if (u >= -1e-6 && u <= 1 + 1e-6 && t > 1e-3 && t <= maxDist && t < bestT) {
      bestT = t;
      best = { x: O.x + dx * t, y: O.y + dy * t };
    }
  }
  return best;
}

/**
 * 中心線追従でレールを張り直す。各ステッチを局所的な中心線の「直交」方向へ
 * 境界まで伸ばすことで、湾曲・テーパした列でも 1 針が局所幅 (=最短) になる。
 * これが「サテンの縫い角度を自動で変化させる」実体。
 */
function centerlineRails(
  outer: Point[],
  railL: Point[],
  railR: Point[],
  spacing: number,
  maxWidth: number,
): { left: Point[]; right: Point[]; maxW: number } | null {
  const n = Math.min(railL.length, railR.length);
  if (n < 2) return null;
  const center: Point[] = [];
  for (let i = 0; i < n; i++) {
    center.push({ x: (railL[i].x + railR[i].x) / 2, y: (railL[i].y + railR[i].y) / 2 });
  }
  const samples = resamplePolyline(center, spacing);
  if (samples.length < 2) return null;

  const left: Point[] = [];
  const right: Point[] = [];
  let maxW = 0;
  const maxDist = maxWidth * 3;
  for (let i = 0; i < samples.length; i++) {
    const prev = samples[Math.max(0, i - 1)];
    const next = samples[Math.min(samples.length - 1, i + 1)];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1;
    const nx = -ty / tl; // 中心線接線の法線 (= 縫い方向)
    const ny = tx / tl;
    const hitP = rayHitPolygon(outer, samples[i], nx, ny, maxDist);
    const hitN = rayHitPolygon(outer, samples[i], -nx, -ny, maxDist);
    if (!hitP || !hitN) continue; // 片側でも境界に当たらなければこのサンプルは捨てる
    left.push(hitP);
    right.push(hitN);
    maxW = Math.max(maxW, Math.hypot(hitP.x - hitN.x, hitP.y - hitN.y));
  }
  if (left.length < 2) return null;
  return { left, right, maxW };
}

/**
 * 細長い領域からサテンを生成する。
 * 主軸が垂直になる向きに回転し、水平スライスの左右端をレールにする (基準)。
 *
 * 角度最適化 (optimizeAngle, 既定 on): 列の中心線を抽出し、各ステッチを中心線の
 * 局所直交方向へ張り直す (centerlineRails)。固定角の走査では湾曲・テーパした列で
 * ステッチが斜めに伸びて長くなるが、中心線追従なら 1 針が常に局所幅 (=最短) になり、
 * 引っ掛かり・たるみを抑えられる。分岐形状は列が破綻するため最適化せず基準のまま
 * (呼び出し側がタタミへフォールバックする)。
 *
 * 幅が maxWidth を超えるスライスがあれば警告 (呼び出し側でタタミへ切替可能)。
 */
export function satinFromRegion(region: Region, params: SatinParams): GeneratorResult {
  const warnings: string[] = [];
  const theta = principalAngle(region.outer);
  // 主軸を y 軸に向ける回転角。scanRegion は -angle 回転するので angle = theta + 90°
  const baseAngle = theta + Math.PI / 2;
  const base = buildSatinAtAngle(region, baseAngle, params.spacing);
  if (base.left.length < 2) {
    return { runs: [], warnings: ["領域が小さすぎてサテンを生成できません"] };
  }

  const cos = Math.cos(baseAngle);
  const sin = Math.sin(baseAngle);
  const un = (p: Point): Point => rotatePoint(p, cos, sin);
  // 基準レールを原座標へ戻す
  let railL = base.left.map(un);
  let railR = base.right.map(un);
  let maxW = base.maxW;
  const branched = base.branchCount > 0;

  // 中心線追従でストロークを短縮 (分岐形状は対象外)。
  // テーパ形状などでは直交キャストが基準より長くなり得るため、
  // 最大スパンが基準を上回らない場合のみ採用する (短縮目的に反しない)。
  if ((params.optimizeAngle ?? true) && !branched) {
    const perp = centerlineRails(region.outer, railL, railR, params.spacing, params.maxWidth);
    if (perp && perp.maxW <= maxW + 1) {
      railL = perp.left;
      railR = perp.right;
      maxW = perp.maxW;
    }
  }

  if (branched) {
    warnings.push("分岐のある形状です。サテンは最も広い帯のみ縫います (タタミを推奨)");
  }
  if (maxW > params.maxWidth) {
    warnings.push(
      `サテン幅 ${(maxW / 10).toFixed(1)}mm が上限 ${(params.maxWidth / 10).toFixed(1)}mm を超えています (タタミへの変換を推奨)`,
    );
  }

  return { runs: [satinFromRails(railL, railR)], warnings };
}
