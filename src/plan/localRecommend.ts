// オフライン解析: API を使わず、抽出済みのパーツ (Region) と統計から
// 刺繍設定の推奨値を計算する。ネットワーク不要・即時・無料で、エラーが出ない。
// AI アシスト (aiAssist.ts) と同じ AiRecommendation 形式を返すので UI を共有できる。

import { pathBounds, signedArea } from "../core/geometry";
import type { Region } from "../core/region";
import type { PlanStats } from "./stats";
import type { AiRecommendation } from "../ai/types";

/** Region の塗り面積 (内部単位²)。穴は差し引く */
function regionArea(r: Region): number {
  let a = Math.abs(signedArea(r.outer));
  for (const h of r.holes) a -= Math.abs(signedArea(h));
  return Math.max(0, a);
}

/** 色を "r,g,b" のキーにする */
function colorKey(c: { r: number; g: number; b: number }): string {
  return `${c.r},${c.g},${c.b}`;
}

/**
 * パーツ形状と統計から推奨設定を導く。
 * - 細い線・小パーツが中心 → サテン、面の下縫いは控えめ
 * - 大きな塗りが中心 → タタミ + エッジ/タタミ下縫い
 * - 混在 → 自動 (細→サテン / 広→タタミ)
 */
export function localRecommend(regions: Region[], stats: PlanStats | null): AiRecommendation {
  const tips: string[] = [];

  // 色数: 実際に検出された個別色の数
  const colors = new Set(regions.map((r) => colorKey(r.color)));
  const colorCount = Math.min(12, Math.max(2, colors.size || 2));

  // パーツごとに「細い/線的」か「広い塗り」かを面積で重み付け判定する
  let thinArea = 0;
  let wideArea = 0;
  let maxAreaMm2 = 0;
  let totalAreaMm2 = 0;
  // 背景候補 (最大面積のほぼ白パーツ)
  let bgColor: { r: number; g: number; b: number } | null = null;
  let bgArea = 0;

  for (const r of regions) {
    const area = regionArea(r);
    const areaMm2 = area / 100; // 1mm² = 100 内部単位²
    totalAreaMm2 += areaMm2;
    if (areaMm2 > maxAreaMm2) maxAreaMm2 = areaMm2;

    const b = pathBounds(r.outer);
    const wMm = (b.maxX - b.minX) / 10;
    const hMm = (b.maxY - b.minY) / 10;
    const minDimMm = Math.min(wMm, hMm);
    const fillRatio = wMm * hMm > 0 ? area / ((b.maxX - b.minX) * (b.maxY - b.minY)) : 0;

    // 細い: 短辺が 3mm 未満、または外接矩形に対する充填率が低い (細長い/線的)
    const thin = minDimMm < 3 || fillRatio < 0.3;
    if (thin) thinArea += areaMm2;
    else wideArea += areaMm2;

    // 背景候補: ほぼ白く、最大面積
    if (r.color.r > 235 && r.color.g > 235 && r.color.b > 235 && areaMm2 > bgArea) {
      bgArea = areaMm2;
      bgColor = r.color;
    }
  }

  const thinFrac = totalAreaMm2 > 0 ? thinArea / totalAreaMm2 : 0;
  const wideFrac = totalAreaMm2 > 0 ? wideArea / totalAreaMm2 : 0;

  // 縫い方
  let fillType: AiRecommendation["fillType"] = "auto";
  if (thinFrac > 0.6) {
    fillType = "satin";
    tips.push("細い線・小さなパーツが中心です。サテン縫いで輪郭をくっきり出せます。");
  } else if (wideFrac > 0.7 && maxAreaMm2 > 100) {
    fillType = "tatami";
    tips.push("広い塗りつぶしが中心です。タタミ縫いで糸を節約しつつ面を安定させます。");
  } else {
    tips.push("細部と面が混在しています。自動 (細→サテン / 広→タタミ) が無難です。");
  }

  // 下縫い: 広い塗りがあるほど厚くする
  let underlay: string[] = [];
  let satinUnderlay: AiRecommendation["satinUnderlay"] = "auto";
  if (maxAreaMm2 > 300) {
    underlay = ["edge", "tatami"];
    tips.push("大きな面があります。エッジ+タタミ下縫いで布の引きつれを防ぎます。");
  } else if (wideArea > 0 && maxAreaMm2 > 80) {
    underlay = ["edge"];
  }
  if (fillType === "satin") satinUnderlay = "center";

  // 密度: 既に針数が多ければ省針を勧める
  let densityScale = 1.0;
  if (stats) {
    if (stats.stitchCount > 10000) {
      densityScale = 1.25;
      tips.push(`針数が約 ${stats.stitchCount.toLocaleString()} と多めです。省針数で上限内に収めます。`);
    } else if (stats.densityPerCm2 > 700) {
      densityScale = 1.25;
    }
  }

  // 白背景除去
  const removeWhiteBackground = bgColor !== null && bgArea > totalAreaMm2 * 0.25;
  if (removeWhiteBackground) {
    tips.push("白い背景を検出しました。背景を除去すると無駄な縫いを減らせます。");
  }

  const shapeDesc = thinFrac > 0.6 ? "細い線が中心" : wideFrac > 0.7 ? "面の塗りが中心" : "細部と面が混在";
  const sizeDesc = stats && stats.widthMm > 0 ? `約 ${stats.widthMm.toFixed(0)}×${stats.heightMm.toFixed(0)}mm、` : "";
  const analysis = `${sizeDesc}${regions.length} パーツ / ${colorCount} 色を検出。${shapeDesc}のデザインです。`;

  return {
    analysis,
    colorCount,
    fillType,
    angleDeg: 45,
    densityScale,
    underlay,
    satinUnderlay,
    removeWhiteBackground,
    tips: tips.slice(0, 3),
  };
}
