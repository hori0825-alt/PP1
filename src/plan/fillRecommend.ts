// パーツごとの縫い方推奨。各領域の形状を解析して三重縫い(outline)か塗り(auto)かを判定する。

import { mm } from "../core/constants";
import type { Region } from "../core/region";
import type { FillType } from "../core/types";
import { regionArea, regionMinExtent } from "../stitch/compensation";
import { analyzeStroke, looksLikeStroke } from "../vector/stroke";

export interface FillRecommendation {
  regionIndex: number;
  color: { r: number; g: number; b: number; name?: string };
  current: FillType | undefined;
  recommended: FillType;
  reason: string;
  estimatedReduction: number;
  accepted: boolean;
}

export function recommendFillTypes(regions: Region[]): FillRecommendation[] {
  const recs: FillRecommendation[] = [];
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const nearWhite = r.color.r > 235 && r.color.g > 235 && r.color.b > 235;
    if (nearWhite) continue;

    const extent = regionMinExtent(r);
    const area = regionArea(r);
    const strokeA = analyzeStroke(r);
    const isStroke = strokeA !== null && looksLikeStroke(strokeA);

    let recommended: FillType;
    let reason: string;
    let reduction: number;

    if (isStroke && strokeA) {
      recommended = "outline";
      const w = (strokeA.width / 10).toFixed(1);
      reason = `細長い線 (幅${w}mm) → 三重縫い`;
      reduction = 70;
    } else if (extent < mm(3)) {
      recommended = "outline";
      reason = `短辺${(extent / 10).toFixed(1)}mm → 三重縫い`;
      reduction = 50;
    } else if (area < mm(3) * mm(3)) {
      recommended = "outline";
      const a = (area / 100).toFixed(1);
      reason = `面積${a}mm² (小) → 三重縫い`;
      reduction = 50;
    } else {
      recommended = "auto";
      const a = (area / 100).toFixed(0);
      reason = `面積${a}mm² → 塗り`;
      reduction = 0;
    }

    recs.push({
      regionIndex: i,
      color: r.color,
      current: r.fillType,
      recommended,
      reason,
      estimatedReduction: reduction,
      accepted: recommended !== (r.fillType ?? "auto"),
    });
  }
  return recs;
}
