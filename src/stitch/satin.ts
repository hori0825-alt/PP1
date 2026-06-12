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

/**
 * 細長い領域からサテンを生成する。
 * 主軸が垂直になる向きに回転し、水平スライスの左右端をレールにする。
 * 幅が maxWidth を超えるスライスがあれば警告 (呼び出し側でタタミへ切替可能)。
 */
export function satinFromRegion(region: Region, params: SatinParams): GeneratorResult {
  const warnings: string[] = [];
  const theta = principalAngle(region.outer);
  // 主軸を y 軸に向ける回転角。scanRegion は -angle 回転するので angle = theta + 90°
  const angleRad = theta + Math.PI / 2;
  const { rows } = scanRegion(region, angleRad, params.spacing);

  const left: Point[] = [];
  const right: Point[] = [];
  let maxW = 0;
  let branched = false;
  for (const row of rows) {
    if (row.length === 0) continue;
    if (row.length > 1) branched = true;
    // 分岐がある行は最も広い区間を使う
    let seg = row[0];
    for (const s of row) {
      if (s.x2 - s.x1 > seg.x2 - seg.x1) seg = s;
    }
    maxW = Math.max(maxW, seg.x2 - seg.x1);
    left.push({ x: seg.x1, y: seg.y });
    right.push({ x: seg.x2, y: seg.y });
  }
  if (left.length < 2) {
    return { runs: [], warnings: ["領域が小さすぎてサテンを生成できません"] };
  }
  if (branched) {
    warnings.push("分岐のある形状です。サテンは最も広い帯のみ縫います (タタミを推奨)");
  }
  if (maxW > params.maxWidth) {
    warnings.push(
      `サテン幅 ${(maxW / 10).toFixed(1)}mm が上限 ${(params.maxWidth / 10).toFixed(1)}mm を超えています (タタミへの変換を推奨)`,
    );
  }

  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const un = (p: Point): Point => rotatePoint(p, cos, sin);
  return { runs: [satinFromRails(left.map(un), right.map(un))], warnings };
}
