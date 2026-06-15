// ストローク (線) のステッチ生成。
// 細長い領域を中心線サテン (太い線) またはランニング (細い線) で縫う。
//
// 目的:
//   - リボン化した線画を「中心線1本」に畳んで二重縫いを解消する。
//   - 細い線は中心線ランニングで縫い、面塗りに比べ針数を大幅に削減する。
//   - 太い線は実際の両レールに沿ったサテンコラムで形に忠実に縫う。
//
// 下縫いは付けない (細い帯に edge/tatami 下縫いは不要・針数増の原因)。呼び出し
// 側 (digitize) は、ストロークが生成できた領域では fillUnderlay をスキップする。

import { RUNNING_DEFAULT_LEN, SATIN_DEFAULT } from "../core/constants";
import type { Region } from "../core/region";
import type { Point, StitchRun } from "../core/types";
import { analyzeStroke, looksLikeStroke, resampleN } from "../vector/stroke";
import { resamplePolyline, satinFromRails } from "./satin";
import type { GeneratorResult } from "./types";

export interface StrokeStitchParams {
  /** サテン密度 (内部単位)。未指定は SATIN_DEFAULT.spacing */
  spacing?: number;
  /** ランニングのステッチ長 (内部単位) */
  runStitchLength?: number;
  /** この幅以下は中心線ランニングにする (内部単位)。デフォルト 1.0mm */
  fineWidth?: number;
  /** 線とみなす最大幅 (内部単位)。デフォルト 7mm */
  maxWidth?: number;
  /** true なら明示指定 (fillType="stroke")。細長さ判定を緩め、幅上限のみで線化する */
  force?: boolean;
}

export interface StrokeStitchResult extends GeneratorResult {
  /** 縫い方タグ (シーケンス表示用)。生成できなければ "tatami" */
  tag: "running" | "satin" | "tatami";
}

const round = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });

/**
 * 領域をストロークとして縫う。線でない/生成できない場合は runs 空を返し、
 * 呼び出し側が通常のフィルにフォールバックする。
 */
export function strokeStitch(region: Region, params: StrokeStitchParams = {}): StrokeStitchResult {
  const maxWidth = params.maxWidth ?? SATIN_DEFAULT.maxWidth;
  const a = analyzeStroke(region);
  if (!a) return { runs: [], warnings: [], tag: "tatami" };

  // 明示指定 (force) は幅上限のみで線化。auto は細長さも要求する。
  const ok = params.force ? a.width <= maxWidth : looksLikeStroke(a, { maxStrokeWidth: maxWidth });
  if (!ok) return { runs: [], warnings: [], tag: "tatami" };

  const fine = params.fineWidth ?? 16; // 1.6mm 以下は単線ランニング (針数最小・潰れ防止)
  if (a.width <= fine) {
    // 細い線: 中心線ランニング (単線)。針数最小・潰れず綺麗。
    const pts = resamplePolyline(a.centerline, params.runStitchLength ?? RUNNING_DEFAULT_LEN).map(round);
    if (pts.length < 2) return { runs: [], warnings: [], tag: "tatami" };
    const run: StitchRun = { stitches: pts, connection: "trim" };
    return { runs: [run], warnings: [], tag: "running" };
  }

  // 太い線: 実レールに沿ったサテンコラム (テーパーや曲線に忠実)。
  const spacing = params.spacing ?? SATIN_DEFAULT.spacing;
  const n = Math.max(2, Math.round(a.length / spacing));
  const left = resampleN(a.left, n);
  const right = resampleN(a.right, n);
  const warnings: string[] = [];
  if (a.maxPairedWidth > maxWidth) {
    warnings.push(
      `線幅 ${(a.maxPairedWidth / 10).toFixed(1)}mm が上限 ${(maxWidth / 10).toFixed(1)}mm を超える区間があります`,
    );
  }
  return { runs: [satinFromRails(left, right)], warnings, tag: "satin" };
}
