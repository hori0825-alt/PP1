// アプリの状態管理 (DOM 非依存のロジック層)。
// 画像/SVG ソースから領域抽出 → デジタイズ → 診断までの再計算を集約する。
// UI コンポーネントはこの状態を読み、変更時に recompute() を呼ぶ。

import { mm } from "../core/constants";
import { createEmptyProject, generateId } from "../core/project";
import type { Project } from "../core/project";
import type { Region } from "../core/region";
import type { StitchPlan } from "../core/types";
import { quantize } from "../import/quantize";
import type { LabelMap, RasterImage } from "../import/raster";
import { extractRegions, fitUnitsPerPixel } from "../import/regions";
import { importSvg } from "../import/svg";
import { getRecipe, recipeToDigitizeOptions } from "../fabric/recipes";
import type { TrimMode } from "../plan/connect";
import { diagnose } from "../plan/diagnostics";
import type { DiagnosticReport } from "../plan/diagnostics";
import { autoReduce } from "../plan/reduce";
import { buildSequence } from "../plan/sequence";
import type { SequenceModel } from "../plan/sequence";
import { buildSimulation } from "../plan/simulate";
import type { Simulation } from "../plan/simulate";
import { digitizeRegions } from "../stitch/digitize";
import type { FillType } from "../stitch/digitize";
import type { UnderlayType } from "../stitch/types";
import type { LayoutMode } from "../text/layout";
import { editShapeToRegion, regionToEditShape } from "../vector/shape";
import type { EditShape } from "../vector/shape";

export type Mode = "easy" | "pro";
export type ViewMode = "original" | "quantized" | "vector" | "stitch";
export type Tab =
  | "design"
  | "color"
  | "stitch"
  | "vector"
  | "text"
  | "sequence"
  | "fabric"
  | "diagnostics"
  | "output";

export interface TextSettings {
  text: string;
  fontFamily: string;
  fontSizeMm: number;
  letterSpacingMm: number;
  mode: LayoutMode;
  arcRadiusMm: number;
  fillType: FillType;
}

export type VectorTool = "select" | "add" | "delete";

/** ベクター/ノード編集の状態 (ベクタータブを開いている間だけ非 null) */
export interface VectorEditState {
  shapes: EditShape[];
  /** 編集対象の shape インデックス */
  activeShape: number;
  /** 編集対象パス: "outer" または穴のインデックス */
  activePath: "outer" | number;
  /** 選択中ノード */
  selectedNode: number | null;
  tool: VectorTool;
  snapEnabled: boolean;
}

export interface AppState {
  mode: Mode;
  tab: Tab;
  view: ViewMode;

  project: Project;
  raster: RasterImage | null;
  labelMap: LabelMap | null;
  regions: Region[];
  plan: StitchPlan | null;
  diagnostics: DiagnosticReport | null;
  sequence: SequenceModel | null;
  simulation: Simulation | null;
  stitchWarnings: string[];

  // 表示・編集
  selectedObjectId: number | null;
  hiddenObjectIds: Set<number>;
  reduceApplied: string[];

  // シミュレーター
  simFrame: number;
  simPlaying: boolean;

  /** ベクター編集 (ベクタータブを開いている間のみ) */
  vectorEdit: VectorEditState | null;

  // 文字刺繍
  textSettings: TextSettings;
  /** 面の塗り方 (文字でサテン/auto を使う。画像はタタミ) */
  fillType: FillType;

  /** 再描画コールバック (UI コンポーネントが状態変更後に呼ぶ) */
  onChange?: () => void;
}

export function createState(): AppState {
  return {
    mode: "easy",
    tab: "design",
    view: "stitch",
    project: createEmptyProject(),
    raster: null,
    labelMap: null,
    regions: [],
    plan: null,
    diagnostics: null,
    sequence: null,
    simulation: null,
    stitchWarnings: [],
    selectedObjectId: null,
    hiddenObjectIds: new Set(),
    reduceApplied: [],
    simFrame: 0,
    simPlaying: false,
    vectorEdit: null,
    textSettings: {
      text: "",
      fontFamily: "sans-serif",
      fontSizeMm: 15,
      letterSpacingMm: 0,
      mode: "horizontal",
      arcRadiusMm: 40,
      fillType: "auto",
    },
    fillType: "tatami",
  };
}

/**
 * 文字から生成済みの領域を取り込んでステッチ化する。
 * 領域変換 (textToRegions) は DOM 依存のため UI 層で行い、結果をここへ渡す。
 */
export function setTextRegions(state: AppState, regions: Region[], fillType: FillType): void {
  state.regions = regions;
  state.project.regions = regions;
  state.project.source = { kind: "none", data: null, fileName: "text" };
  state.raster = null;
  state.labelMap = null;
  state.fillType = fillType;
  recomputeStitches(state);
}

/** 布地レシピを選択し、下縫いを推奨値で初期化してステッチを再生成する */
export function applyFabric(state: AppState, fabricId: string): void {
  state.project.settings.fabricId = fabricId;
  // 下縫いはレシピの推奨で上書き (ユーザーはステッチタブで再調整可能)
  state.project.settings.underlay = [...getRecipe(fabricId).underlay];
  recomputeStitches(state);
}

/** ベクター編集を開始: 現在の領域を編集可能形状に変換する */
export function enterVectorEdit(state: AppState): void {
  if (state.regions.length === 0) {
    state.vectorEdit = null;
    return;
  }
  state.vectorEdit = {
    shapes: state.regions.map((r) => regionToEditShape(r)),
    activeShape: 0,
    activePath: "outer",
    selectedNode: null,
    tool: "select",
    snapEnabled: true,
  };
}

/** ベクター編集を確定: 編集形状を領域へ戻してステッチを再生成 */
export function applyVectorEdit(state: AppState): void {
  if (!state.vectorEdit) return;
  state.regions = state.vectorEdit.shapes.map((s) => editShapeToRegion(s));
  state.project.regions = state.regions;
  recomputeStitches(state);
  state.vectorEdit = null;
}

/** ベクター編集を破棄 */
export function cancelVectorEdit(state: AppState): void {
  state.vectorEdit = null;
}

/** 設定から領域抽出をやり直す (ソース → regions) */
export function recomputeRegions(state: AppState): void {
  const s = state.project.settings;
  if (state.project.source.kind === "svg" && state.project.source.data) {
    state.regions = importSvg(state.project.source.data, mm(s.targetSizeMm)).regions;
    state.labelMap = null;
  } else if (state.raster) {
    state.labelMap = quantize(state.raster, {
      colorCount: s.colorCount,
      removeWhiteBackground: s.removeWhiteBackground,
    });
    state.regions = extractRegions(state.labelMap, {
      unitsPerPixel: fitUnitsPerPixel(state.raster.width, state.raster.height, mm(s.targetSizeMm)),
    });
  }
  state.project.regions = state.regions;
  recomputeStitches(state);
}

/** 領域からステッチを生成し直す (regions → plan → 診断) */
export function recomputeStitches(state: AppState): void {
  const s = state.project.settings;
  if (state.regions.length === 0) {
    state.plan = null;
    state.diagnostics = null;
    state.sequence = null;
    state.simulation = null;
    state.stitchWarnings = [];
    return;
  }
  // 布地レシピ由来の密度・補正・最小サイズを基礎にし、
  // 角度・糸切りモード・下縫いはユーザー設定 (ステッチタブ) で上書きする
  const recipe = getRecipe(s.fabricId);
  const result = digitizeRegions(state.regions, designName(state), {
    ...recipeToDigitizeOptions(recipe),
    angleDeg: s.angleDeg,
    trimMode: s.trimMode,
    underlay: s.underlay as UnderlayType[],
    fillType: state.fillType,
  });
  state.plan = result.plan;
  state.project.plan = result.plan;
  state.stitchWarnings = result.warnings;
  refreshDerived(state);
  state.reduceApplied = [];
}

/** plan から診断・シーケンス・シミュレーションを作り直す */
export function refreshDerived(state: AppState): void {
  if (!state.plan) return;
  state.diagnostics = diagnose(state.plan);
  state.sequence = buildSequence(state.plan);
  state.simulation = buildSimulation(state.plan);
  state.simFrame = state.simulation.frames.length;
}

/** 自動針数削減を実行 */
export function applyAutoReduce(state: AppState): void {
  if (state.regions.length === 0) return;
  const s = state.project.settings;
  const result = autoReduce(state.regions, designName(state), {
    angleDeg: s.angleDeg,
    trimMode: s.trimMode,
    underlay: s.underlay as UnderlayType[],
  });
  state.regions = result.regions;
  state.project.regions = result.regions;
  state.plan = result.plan;
  state.project.plan = result.plan;
  refreshDerived(state);
  state.reduceApplied = [`針数 ${result.before} → ${result.after}`, ...result.applied];
}

export function designName(state: AppState): string {
  const base = state.project.source.fileName.replace(/\.[^.]+$/, "") || state.project.name;
  return (base || "design").slice(0, 8).toUpperCase();
}

/** ソースを差し替えるときに ID は維持しつつ表示名を更新 */
export function setSourceImage(state: AppState, raster: RasterImage, dataUrl: string, fileName: string): void {
  state.raster = raster;
  state.fillType = "tatami"; // 画像はタタミ
  state.project.source = { kind: "image", data: dataUrl, fileName };
  state.project.name = fileName.replace(/\.[^.]+$/, "") || "design";
  if (!state.project.id) state.project.id = generateId();
  recomputeRegions(state);
}

export function setSourceSvg(state: AppState, svgText: string, fileName: string): void {
  state.raster = null;
  state.labelMap = null;
  state.fillType = "tatami";
  state.project.source = { kind: "svg", data: svgText, fileName };
  state.project.name = fileName.replace(/\.[^.]+$/, "") || "design";
  recomputeRegions(state);
}
