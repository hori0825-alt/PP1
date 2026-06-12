// Region[] → StitchPlan のデジタイズパイプライン。
// Phase 3 時点では同色をまとめて素朴な順序で縫う。
// 縫い順・糸切りの本格的な最適化は Phase 4 (src/plan/) が担当する。

import { TATAMI_DEFAULT, TRIM_THRESHOLDS } from "../core/constants";
import type { Region } from "../core/region";
import type { ColorBlock, Connection, StitchPlan, StitchRun } from "../core/types";
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
}

export interface DigitizeResult {
  plan: StitchPlan;
  warnings: string[];
}

/**
 * 前の Run の終点と次の Run の始点の距離から接続方法を決める。
 * sameObject = true (同一領域内: 下縫い→本縫い、連結成分間) では
 * どんなに離れていても糸切りせず渡り糸にする。
 */
function decideConnection(prev: StitchRun | null, next: StitchRun, sameObject: boolean): Connection {
  if (!prev || prev.stitches.length === 0 || next.stitches.length === 0) {
    return sameObject ? "jump" : "trim";
  }
  const a = prev.stitches[prev.stitches.length - 1];
  const b = next.stitches[0];
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  if (d < TRIM_THRESHOLDS.neverTrimBelow) return "continuous";
  if (sameObject || d < TRIM_THRESHOLDS.trimAbove) return "jump";
  return "trim";
}

/**
 * 領域群をタタミでデジタイズして StitchPlan を作る。
 * 同色の領域は1つの ColorBlock にまとめる (色替え最小化の基本)。
 */
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

  // 同色ごとにグループ化 (出現順を保つ)
  const groups = new Map<string, { color: Region["color"]; regions: Region[] }>();
  for (const region of regions) {
    const key = `${region.color.r},${region.color.g},${region.color.b}`;
    const g = groups.get(key);
    if (g) g.regions.push(region);
    else groups.set(key, { color: region.color, regions: [region] });
  }

  const blocks: ColorBlock[] = [];
  for (const group of groups.values()) {
    const runs: StitchRun[] = [];
    for (const region of group.regions) {
      const regionRuns: StitchRun[] = [];

      if (options.underlay && options.underlay.length > 0) {
        const u = fillUnderlay(region, { types: options.underlay, topAngleDeg: params.angleDeg });
        regionRuns.push(...u.runs);
        warnings.push(...u.warnings);
      }

      const fill = tatamiFill(region, params);
      regionRuns.push(...fill.runs);
      warnings.push(...fill.warnings);

      const processed = postprocessRuns(regionRuns);
      for (let i = 0; i < processed.length; i++) {
        // i === 0: 前の領域からの接続 (糸切り許可)。i > 0: 同一領域内 (糸切り禁止)
        const prev = i === 0 ? (runs.length > 0 ? runs[runs.length - 1] : null) : processed[i - 1];
        processed[i] = {
          stitches: processed[i].stitches,
          connection: decideConnection(prev, processed[i], i > 0),
        };
      }
      runs.push(...processed);
    }
    if (runs.length > 0) {
      blocks.push({ thread: group.color, runs });
    }
  }

  return { plan: { name, blocks }, warnings };
}
