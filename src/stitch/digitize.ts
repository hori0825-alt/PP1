// Region[] → StitchPlan のデジタイズパイプライン (Phase 4: 縫い順最適化対応)。
//
// 手順:
//   1. 同色の領域を1つの ColorBlock にグループ化 (色替え最小化)
//   2. 色順は総面積の大きい順 (背景 → 前景でレイヤーが自然になる)
//   3. 同色内は重心の貪欲法 + 2-opt で巡回順を最適化 (Closest Join)
//   4. 各領域は「前のオブジェクトの終点」を startNear に渡して生成し、
//      開始点を自動的に近づける (Closest Point)
//   5. 接続は decideConnection: 3mm未満=continuous / 10mm未満=jump / 以遠=trim
//      (Always/Never/Auto Trim と Trim Distance を指定可能)
//   6. 同一領域内 (下縫い→本縫い等) は距離に関わらず糸切りしない

import { TATAMI_DEFAULT } from "../core/constants";
import { polygonCentroid, signedArea } from "../core/geometry";
import type { Region } from "../core/region";
import type { ColorBlock, Point, StitchPlan, StitchRun } from "../core/types";
import type { ConnectOptions, TrimMode } from "../plan/connect";
import { decideConnection } from "../plan/connect";
import { optimizeOrder } from "../plan/order";
import { postprocessRuns } from "./postprocess";
import { tatamiFill } from "./tatami";
import { fillUnderlay } from "./underlay";
import type { TatamiParams, UnderlayType } from "./types";

export interface DigitizeOptions {
  /** タタミ角度 (度) */
  angleDeg?: number;
  /** タタミ行間隔 */
  rowSpacing?: number;
  /** ステッチ長 */
  stitchLength?: number;
  /** 下縫い (デフォルトなし。布地レシピ連携は Phase 5.5) */
  underlay?: UnderlayType[];
  /** 縫い順最適化 (デフォルト true。false で入力順のまま) */
  optimizeOrder?: boolean;
  /** 糸切りモード: auto (距離判定) / never / always */
  trimMode?: TrimMode;
  /** auto 時の糸切り距離閾値 */
  trimDistance?: number;
}

export interface DigitizeResult {
  plan: StitchPlan;
  warnings: string[];
}

export function digitizeRegions(
  regions: Region[],
  name: string,
  options: DigitizeOptions = {},
): DigitizeResult {
  const warnings: string[] = [];
  const params: TatamiParams = {
    angleDeg: options.angleDeg ?? 45,
    rowSpacing: options.rowSpacing ?? TATAMI_DEFAULT.rowSpacing,
    stitchLength: options.stitchLength ?? TATAMI_DEFAULT.stitchLength,
  };
  const connectOptions: ConnectOptions = {
    trimMode: options.trimMode ?? "auto",
    trimDistance: options.trimDistance,
  };
  const doOptimize = options.optimizeOrder ?? true;

  // --- 1. 同色グループ化 ---
  const groups = new Map<string, { color: Region["color"]; regions: Region[]; area: number }>();
  for (const region of regions) {
    const key = `${region.color.r},${region.color.g},${region.color.b}`;
    const net =
      Math.abs(signedArea(region.outer)) -
      region.holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
    const g = groups.get(key);
    if (g) {
      g.regions.push(region);
      g.area += net;
    } else {
      groups.set(key, { color: region.color, regions: [region], area: net });
    }
  }

  // --- 2. 色順: 総面積の大きい順 (背景が先) ---
  const groupList = [...groups.values()];
  if (doOptimize) groupList.sort((a, b) => b.area - a.area);

  const blocks: ColorBlock[] = [];
  let currentEnd: Point | null = null; // 直前に縫った位置 (色をまたいで引き継ぐ)

  for (const group of groupList) {
    // --- 3. 同色内の巡回順最適化 (Closest Join) ---
    let ordered = group.regions;
    if (doOptimize && group.regions.length > 1) {
      const centroids = group.regions.map((r) => polygonCentroid(r.outer));
      const order = optimizeOrder(centroids, currentEnd);
      ordered = order.map((i) => group.regions[i]);
    }

    const runs: StitchRun[] = [];
    for (let idx = 0; idx < ordered.length; idx++) {
      const region = ordered[idx];
      const regionRuns: StitchRun[] = [];

      // --- 4. 前の終点近くから縫い始め、次のオブジェクト方向で縫い終わる ---
      if (options.underlay && options.underlay.length > 0) {
        const u = fillUnderlay(region, { types: options.underlay, topAngleDeg: params.angleDeg });
        regionRuns.push(...u.runs);
        warnings.push(...u.warnings);
      }

      const fillStart =
        regionRuns.length > 0
          ? regionRuns[regionRuns.length - 1].stitches[
              regionRuns[regionRuns.length - 1].stitches.length - 1
            ]
          : currentEnd;
      const exitNear =
        doOptimize && idx + 1 < ordered.length ? polygonCentroid(ordered[idx + 1].outer) : null;
      const fill = tatamiFill(region, params, fillStart ?? null, exitNear);
      regionRuns.push(...fill.runs);
      warnings.push(...fill.warnings);

      // --- 5./6. 接続決定 ---
      const processed = postprocessRuns(regionRuns);
      for (let i = 0; i < processed.length; i++) {
        // i === 0: 前の領域からの接続 (糸切り許可)。i > 0: 同一領域内 (糸切り禁止)
        const prevRun = i === 0 ? (runs.length > 0 ? runs[runs.length - 1] : null) : processed[i - 1];
        const from =
          prevRun && prevRun.stitches.length > 0
            ? prevRun.stitches[prevRun.stitches.length - 1]
            : i === 0
              ? currentEnd
              : null;
        processed[i] = {
          stitches: processed[i].stitches,
          connection: decideConnection(from, processed[i].stitches[0], i > 0, connectOptions),
        };
      }
      runs.push(...processed);
      if (runs.length > 0) {
        const lastRun = runs[runs.length - 1];
        currentEnd = lastRun.stitches[lastRun.stitches.length - 1];
      }
    }
    if (runs.length > 0) {
      blocks.push({ thread: group.color, runs });
    }
  }

  return { plan: { name, blocks }, warnings };
}
