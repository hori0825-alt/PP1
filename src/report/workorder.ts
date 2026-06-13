// 作業指示書のデータ組み立て (DOM 非依存・テスト可能)。
// StitchPlan + プロジェクト + 布地レシピから、PDF/HTML に出す情報をまとめる。
// HTML レンダリングと印刷は UI 層 (src/ui/report.ts)。

import { UNIT_MM } from "../core/constants";
import { countColorChanges, countStitches, countTrims, planBounds } from "../core/plan";
import type { StitchPlan } from "../core/types";
import { assignBrotherThreads } from "../export/pec";
import { getRecipe } from "../fabric/recipes";
import { planStats } from "../plan/stats";

export interface ThreadUsage {
  /** 縫い順 (1始まり) */
  order: number;
  /** Brother パレット色番号 */
  pecIndex: number;
  name: string;
  rgb: { r: number; g: number; b: number };
  stitches: number;
}

export interface WorkOrder {
  projectId: string;
  designName: string;
  fileName: string;
  createdAt: string;
  /** 作業指示書の発行日時 (ISO) */
  issuedAt: string;
  totalStitches: number;
  colorCount: number;
  colorChanges: number;
  trims: number;
  widthMm: number;
  heightMm: number;
  estMinutes: number;
  threads: ThreadUsage[];
  fabric: {
    name: string;
    recommendedThread: string;
    recommendedNeedle: string;
  };
  /** 12,000 針超過などの注意 */
  notes: string[];
}

export function buildWorkOrder(
  plan: StitchPlan,
  opts: { projectId: string; designName: string; fileName: string; createdAt: string; fabricId: string },
): WorkOrder {
  const stats = planStats(plan);
  const bounds = planBounds(plan);
  const brother = assignBrotherThreads(plan);
  const recipe = getRecipe(opts.fabricId);

  const threads: ThreadUsage[] = plan.blocks.map((block, i) => {
    const stitches = block.runs.reduce((n, r) => n + r.stitches.length, 0);
    const th = brother[i];
    return {
      order: i + 1,
      pecIndex: th.pecIndex,
      name: th.name ?? `#${th.pecIndex}`,
      rgb: { r: th.r, g: th.g, b: th.b },
      stitches,
    };
  });

  const notes: string[] = [];
  if (stats.stitchCount > 12000) notes.push(`針数 ${stats.stitchCount} が PP1 上限 12,000 を超えています`);
  if (bounds) {
    const w = (bounds.maxX - bounds.minX) * UNIT_MM;
    const h = (bounds.maxY - bounds.minY) * UNIT_MM;
    if (w > 100 || h > 100) notes.push(`サイズ ${w.toFixed(0)}×${h.toFixed(0)}mm が 100mm 枠を超えています`);
  }

  return {
    projectId: opts.projectId,
    designName: opts.designName,
    fileName: opts.fileName,
    createdAt: opts.createdAt,
    issuedAt: new Date().toISOString(),
    totalStitches: countStitches(plan),
    colorCount: stats.colorCount,
    colorChanges: countColorChanges(plan),
    trims: countTrims(plan),
    widthMm: bounds ? (bounds.maxX - bounds.minX) * UNIT_MM : 0,
    heightMm: bounds ? (bounds.maxY - bounds.minY) * UNIT_MM : 0,
    estMinutes: stats.estMinutes,
    threads,
    fabric: {
      name: recipe.name,
      recommendedThread: recipe.recommendedThread,
      recommendedNeedle: recipe.recommendedNeedle,
    },
    notes,
  };
}
