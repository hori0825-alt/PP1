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
import type { TrimMode } from "../plan/connect";
import { diagnose } from "../plan/diagnostics";
import type { DiagnosticReport } from "../plan/diagnostics";
import { autoReduce } from "../plan/reduce";
import { buildSequence } from "../plan/sequence";
import type { SequenceModel } from "../plan/sequence";
import { buildSimulation } from "../plan/simulate";
import type { Simulation } from "../plan/simulate";
import { digitizeRegions } from "../stitch/digitize";
import type { UnderlayType } from "../stitch/types";

export type Mode = "easy" | "pro";
export type ViewMode = "original" | "quantized" | "vector" | "stitch";
export type Tab = "design" | "color" | "stitch" | "sequence" | "fabric" | "diagnostics" | "output";

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
  };
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
  const result = digitizeRegions(state.regions, designName(state), {
    angleDeg: s.angleDeg,
    trimMode: s.trimMode,
    underlay: s.underlay as UnderlayType[],
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
  state.project.source = { kind: "image", data: dataUrl, fileName };
  state.project.name = fileName.replace(/\.[^.]+$/, "") || "design";
  if (!state.project.id) state.project.id = generateId();
  recomputeRegions(state);
}

export function setSourceSvg(state: AppState, svgText: string, fileName: string): void {
  state.raster = null;
  state.labelMap = null;
  state.project.source = { kind: "svg", data: svgText, fileName };
  state.project.name = fileName.replace(/\.[^.]+$/, "") || "design";
  recomputeRegions(state);
}
