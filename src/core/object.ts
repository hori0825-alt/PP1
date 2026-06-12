// 刺繍オブジェクトモデル。
// 新アーキテクチャの中心: 画像は直接ステッチにせず、まず「刺繍オブジェクト」
// (形状 + 縫い設定) に分解し、ユーザーが編集してから縫い計画 (planner) で
// ステッチ列にコンパイルする。

import type { Pt } from "../digitize/contour";

export type StitchKind = "tatami" | "satin" | "centerline";
export type TrimMode = "auto" | "always" | "never";

export interface ObjectSettings {
  /** ステッチ種別 (auto判定の結果。ユーザーが上書き可) */
  kind: StitchKind;
  /** タタミの縫い角度 (度)。null = 自動 (細長い領域は長軸に直交) */
  angleDeg: number | null;
  /** タタミ行間隔 (mm)。null = グローバル設定 */
  rowSpacingMm: number | null;
  /** サテン行間隔 (mm)。null = グローバル設定 */
  satinSpacingMm: number | null;
  /** 輪郭線 (ランニング) を付ける。null = グローバル設定 */
  outline: boolean | null;
  /** このオブジェクトへ移動する際の糸切り */
  trimMode: TrimMode;
  visible: boolean;
  locked: boolean;
}

export interface EmbObject {
  id: string;
  name: string;
  /** パレット番号 (色) */
  paletteIndex: number;
  /** 形状: 外周 + 穴 (処理画像ピクセル座標、平滑化済み) */
  ringsPx: Pt[][];
  /** 細い線用: bboxローカルの画素マスク (サテン/センターライン再生成用) */
  mask: { x0: number; y0: number; w: number; h: number; data: Uint8Array } | null;
  /** 自動判定時の推定幅 (mm) */
  estWidthMm: number;
  /** 面積 (px) */
  areaPx: number;
  settings: ObjectSettings;
}

export interface GlobalSettings {
  sizeMm: number;
  maxColors: number;
  colorMergeLevel: number;
  rowSpacingMm: number;
  satinSpacingMm: number;
  stitchLenMm: number;
  outlineStitchMm: number;
  angleDeg: number;
  outline: boolean;
  autoThinDetect: boolean;
  satinMaxWidthMm: number;
  centerlineMaxWidthMm: number;
  outlineSmoothing: number;
  minRegionMm2: number;
  autoBackground: boolean;
  /** 糸切りモードの既定 (オブジェクト単位で上書き可) */
  trimMode: TrimMode;
  /** つなぎ縫いの最大距離 (mm) = Trim Distance */
  trimDistanceMm: number;
  /** 針数上限 (PP1 は 12,000 を強く推奨) */
  maxStitches: number;
}

export const DEFAULT_GLOBAL: GlobalSettings = {
  sizeMm: 90,
  maxColors: 6,
  colorMergeLevel: 2,
  rowSpacingMm: 0.4,
  satinSpacingMm: 0.3,
  stitchLenMm: 3.0,
  outlineStitchMm: 2.0,
  angleDeg: 45,
  outline: true,
  autoThinDetect: true,
  satinMaxWidthMm: 6,
  centerlineMaxWidthMm: 1.5,
  outlineSmoothing: 2,
  minRegionMm2: 1,
  autoBackground: true,
  trimMode: "auto",
  trimDistanceMm: 50,
  maxStitches: 12000,
};

let idCounter = 0;
export function newObjectId(): string {
  idCounter++;
  return `obj-${Date.now().toString(36)}-${idCounter}`;
}

export function defaultObjectSettings(kind: StitchKind): ObjectSettings {
  return {
    kind,
    angleDeg: null,
    rowSpacingMm: null,
    satinSpacingMm: null,
    outline: null,
    trimMode: "auto",
    visible: true,
    locked: false,
  };
}
