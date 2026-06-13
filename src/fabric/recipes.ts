// 布地別レシピ。布の伸び・厚み・毛足に応じた推奨設定を持つ。
// レシピ値は mm 単位 (人が読める)。digitize へは recipeToDigitizeOptions で変換。

import { mm } from "../core/constants";
import type { DigitizeOptions } from "../stitch/digitize";
import type { UnderlayType } from "../stitch/types";

export interface FabricRecipe {
  id: string;
  name: string;
  /** タタミ行間隔 (mm)。小さいほど高密度 */
  tatamiSpacingMm: number;
  /** サテン密度 (mm) */
  satinSpacingMm: number;
  /** ステッチ長 (mm) */
  stitchLengthMm: number;
  underlay: UnderlayType[];
  /** Pull 補正 (mm)。縫い縮み対策の幅拡張 */
  pullCompMm: number;
  /** Push 補正 (mm)。はみ出し対策の収縮 */
  pushCompMm: number;
  /** 最小オブジェクトの短辺 (mm)。これ未満は除外 (Small Object Protection) */
  minObjectMm: number;
  /** 糸切り閾値 (mm) */
  trimDistanceMm: number;
  /** 渡り糸許容距離 (mm)。情報表示用 */
  maxTravelMm: number;
  /** 小さい面の密度を自動で下げる */
  autoDensity: boolean;
  /** 推奨糸・針 (作業指示用) */
  recommendedThread: string;
  recommendedNeedle: string;
}

// 伸びる布ほど Pull 補正・下縫いを強め、密度はやや粗めにする。
export const FABRIC_RECIPES: readonly FabricRecipe[] = [
  {
    id: "standard",
    name: "標準 (中厚)",
    tatamiSpacingMm: 0.4, satinSpacingMm: 0.4, stitchLengthMm: 3.0,
    underlay: ["edge"], pullCompMm: 0.2, pushCompMm: 0.0, minObjectMm: 1.0,
    trimDistanceMm: 10, maxTravelMm: 12, autoDensity: true,
    recommendedThread: "ポリエステル40番", recommendedNeedle: "75/11",
  },
  {
    id: "thin",
    name: "薄手生地",
    tatamiSpacingMm: 0.45, satinSpacingMm: 0.45, stitchLengthMm: 2.8,
    underlay: ["edge"], pullCompMm: 0.15, pushCompMm: 0.0, minObjectMm: 1.2,
    trimDistanceMm: 8, maxTravelMm: 10, autoDensity: true,
    recommendedThread: "ポリエステル50番", recommendedNeedle: "70/10",
  },
  {
    id: "tshirt",
    name: "Tシャツ (ニット)",
    tatamiSpacingMm: 0.4, satinSpacingMm: 0.4, stitchLengthMm: 3.0,
    underlay: ["edge", "tatami"], pullCompMm: 0.4, pushCompMm: 0.1, minObjectMm: 1.5,
    trimDistanceMm: 10, maxTravelMm: 12, autoDensity: true,
    recommendedThread: "ポリエステル40番", recommendedNeedle: "75/11 ボールポイント",
  },
  {
    id: "denim",
    name: "デニム",
    tatamiSpacingMm: 0.38, satinSpacingMm: 0.38, stitchLengthMm: 3.2,
    underlay: ["edge"], pullCompMm: 0.15, pushCompMm: 0.0, minObjectMm: 1.0,
    trimDistanceMm: 12, maxTravelMm: 14, autoDensity: false,
    recommendedThread: "ポリエステル40番", recommendedNeedle: "90/14",
  },
  {
    id: "canvas",
    name: "帆布",
    tatamiSpacingMm: 0.38, satinSpacingMm: 0.38, stitchLengthMm: 3.2,
    underlay: ["edge"], pullCompMm: 0.1, pushCompMm: 0.0, minObjectMm: 1.0,
    trimDistanceMm: 12, maxTravelMm: 14, autoDensity: false,
    recommendedThread: "ポリエステル40番", recommendedNeedle: "90/14",
  },
  {
    id: "felt",
    name: "フェルト",
    tatamiSpacingMm: 0.4, satinSpacingMm: 0.4, stitchLengthMm: 3.0,
    underlay: [], pullCompMm: 0.1, pushCompMm: 0.0, minObjectMm: 1.0,
    trimDistanceMm: 10, maxTravelMm: 12, autoDensity: false,
    recommendedThread: "ポリエステル40番", recommendedNeedle: "75/11",
  },
  {
    id: "towel",
    name: "タオル (パイル)",
    tatamiSpacingMm: 0.35, satinSpacingMm: 0.35, stitchLengthMm: 3.0,
    underlay: ["edge", "tatami"], pullCompMm: 0.3, pushCompMm: 0.1, minObjectMm: 2.0,
    trimDistanceMm: 10, maxTravelMm: 12, autoDensity: true,
    recommendedThread: "ポリエステル40番", recommendedNeedle: "75/11",
  },
  {
    id: "leather",
    name: "レザー",
    tatamiSpacingMm: 0.45, satinSpacingMm: 0.45, stitchLengthMm: 3.2,
    underlay: [], pullCompMm: 0.1, pushCompMm: 0.0, minObjectMm: 1.2,
    trimDistanceMm: 12, maxTravelMm: 14, autoDensity: true,
    recommendedThread: "ポリエステル40番", recommendedNeedle: "レザー針 90/14",
  },
  {
    id: "nylon",
    name: "ナイロン",
    tatamiSpacingMm: 0.45, satinSpacingMm: 0.45, stitchLengthMm: 2.8,
    underlay: ["edge"], pullCompMm: 0.2, pushCompMm: 0.0, minObjectMm: 1.2,
    trimDistanceMm: 8, maxTravelMm: 10, autoDensity: true,
    recommendedThread: "ポリエステル50番", recommendedNeedle: "70/10",
  },
  {
    id: "stretch",
    name: "伸縮素材",
    tatamiSpacingMm: 0.42, satinSpacingMm: 0.42, stitchLengthMm: 3.0,
    underlay: ["edge", "tatami"], pullCompMm: 0.5, pushCompMm: 0.15, minObjectMm: 1.5,
    trimDistanceMm: 10, maxTravelMm: 12, autoDensity: true,
    recommendedThread: "ポリエステル40番", recommendedNeedle: "75/11 ボールポイント",
  },
  {
    id: "quilt",
    name: "キルト生地",
    tatamiSpacingMm: 0.4, satinSpacingMm: 0.4, stitchLengthMm: 3.0,
    underlay: ["edge"], pullCompMm: 0.15, pushCompMm: 0.0, minObjectMm: 1.0,
    trimDistanceMm: 12, maxTravelMm: 14, autoDensity: false,
    recommendedThread: "ポリエステル40番", recommendedNeedle: "75/11",
  },
  {
    id: "patch-felt",
    name: "ワッペン用フェルト",
    tatamiSpacingMm: 0.35, satinSpacingMm: 0.35, stitchLengthMm: 2.8,
    underlay: ["edge"], pullCompMm: 0.1, pushCompMm: 0.0, minObjectMm: 1.0,
    trimDistanceMm: 10, maxTravelMm: 12, autoDensity: false,
    recommendedThread: "ポリエステル40番", recommendedNeedle: "75/11",
  },
];

export function getRecipe(id: string): FabricRecipe {
  return FABRIC_RECIPES.find((r) => r.id === id) ?? FABRIC_RECIPES[0];
}

/** レシピを digitize のオプションへ変換する (角度・糸切りモードは別途指定) */
export function recipeToDigitizeOptions(recipe: FabricRecipe): Partial<DigitizeOptions> {
  return {
    rowSpacing: mm(recipe.tatamiSpacingMm),
    stitchLength: mm(recipe.stitchLengthMm),
    underlay: recipe.underlay,
    trimDistance: mm(recipe.trimDistanceMm),
    pullCompensation: mm(recipe.pullCompMm),
    pushCompensation: mm(recipe.pushCompMm),
    minObjectExtent: mm(recipe.minObjectMm),
    autoDensity: recipe.autoDensity,
  };
}
