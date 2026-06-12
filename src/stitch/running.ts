// ランニングステッチ (アウトライン・接続線用) とジグザグライン。

import { RUNNING_DEFAULT_LEN } from "../core/constants";
import type { Point, StitchRun } from "../core/types";
import { resamplePolyline, satinAlongPath } from "./satin";
import type { GeneratorResult, RunningParams, ZigzagLineParams } from "./types";

/**
 * 折れ線に沿ったランニングステッチ。
 * closed = true なら終点から始点へ戻る辺も縫う。
 * double = true なら往復して開始点に戻る (二重走り)。
 */
export function runningStitch(
  path: Point[],
  params: Partial<RunningParams> = {},
  closed = false,
): GeneratorResult {
  const stitchLength = params.stitchLength ?? RUNNING_DEFAULT_LEN;
  if (path.length < 2) return { runs: [], warnings: ["ランニングの経路が短すぎます"] };

  const fullPath = closed ? [...path, path[0]] : path;
  const pts = resamplePolyline(fullPath, stitchLength).map((p) => ({
    x: Math.round(p.x),
    y: Math.round(p.y),
  }));

  let stitches = pts;
  if (params.double) {
    const back = [...pts].reverse().slice(1);
    stitches = [...pts, ...back];
  }
  return { runs: [{ stitches, connection: "trim" }], warnings: [] };
}

/** ジグザグライン (簡易サテンライン)。輪郭の縁取りなどに使う */
export function zigzagLine(path: Point[], params: ZigzagLineParams): GeneratorResult {
  return satinAlongPath(path, params.width, params.spacing);
}
