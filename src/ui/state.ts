// アプリの状態管理 (DOM 非依存のロジック層)。
// 画像/SVG ソースから領域抽出 → デジタイズ → 診断までの再計算を集約する。
// UI コンポーネントはこの状態を読み、変更時に recompute() を呼ぶ。

import { RUNNING_DEFAULT_LEN, SATIN_DEFAULT, mm } from "../core/constants";
import { signedArea } from "../core/geometry";
import { bumpObjectId, makeObject, nextObjectId, reconcileObjects } from "../core/object";
import type { EmbroideryObject } from "../core/object";
import { countStitches } from "../core/plan";
import { createEmptyProject, generateId } from "../core/project";
import type { Project } from "../core/project";
import type { DirectionLine, Region } from "../core/region";
import type { Point, StitchPlan, ThreadColor } from "../core/types";
import { quantize } from "../import/quantize";
import type { LabelMap, RasterImage } from "../import/raster";
import { extractRegions, fitUnitsPerPixel } from "../import/regions";
import type { ExcludedRegion } from "../import/regions";
import { importSvg } from "../import/svg";
import { getRecipe, recipeToDigitizeOptions } from "../fabric/recipes";
import { generatePhotoStitch } from "../photo/photostitch";
import { appliquePlan } from "../applique/applique";
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
import type { AiAnalysis, AiCorrectionSettings, AiRecommendation } from "../ai/types";

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
  | "special"
  | "diagnostics"
  | "output"
  | "library";

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
  /** 開始時の領域形状スナップショット (破棄時に復元する) */
  original: { outer: Point[]; holes: Point[][] }[];
}

/** 個々の針 (ステッチ点) 編集の状態 (フェーズ7)。baked オブジェクトの針列を直接編集する */
export interface StitchEditState {
  /** 編集対象オブジェクトの安定 id (baked 必須) */
  objectId: number;
  tool: "move" | "add" | "delete";
  /** 選択中の針 (run 内 index) */
  sel: { run: number; idx: number } | null;
}

/** 手動デジタイズ (ペン作図) の状態 (フェーズ8)。クリックで点を置いて面/線を作る */
export interface PenDrawState {
  kind: "fill" | "line";
  points: Point[];
}

export interface AppState {
  mode: Mode;
  tab: Tab;
  view: ViewMode;

  project: Project;
  raster: RasterImage | null;
  labelMap: LabelMap | null;
  regions: Region[];
  /** 面積不足で除外された領域 (キャンバスハイライト + 復元用) */
  excludedRegions: ExcludedRegion[];
  /**
   * 永続オブジェクト層 (Phase 1)。regions と同期し、安定 id と baked を持つ。
   * recomputeStitches が regions から再構成する (その場編集では id を維持)。
   */
  objects: EmbroideryObject[];
  plan: StitchPlan | null;
  diagnostics: DiagnosticReport | null;
  sequence: SequenceModel | null;
  simulation: Simulation | null;
  stitchWarnings: string[];

  // 表示・編集
  selectedObjectId: number | null;
  /** ベクタービューでクリックして選択した領域インデックス (state.regions のインデックス) */
  selectedRegionIndex: number | null;
  /** 方向線(ターニング)の作図モード。ON のときキャンバスのドラッグで方向線を引く */
  angleLineDraw: boolean;
  hiddenObjectIds: Set<number>;
  reduceApplied: string[];

  // シミュレーター
  simFrame: number;
  simPlaying: boolean;
  /** 再生速度の倍率 (1 = 標準) */
  simSpeed: number;

  /** 下縫いの強調表示 (ステッチビュー)。ON で下縫いを色分けし本縫いを淡く描く */
  highlightUnderlay: boolean;

  /** ベクター編集 (ベクタータブを開いている間のみ) */
  vectorEdit: VectorEditState | null;

  /** 針 (ステッチ点) 編集 (フェーズ7。アクティブな間のみ非 null) */
  stitchEdit: StitchEditState | null;

  /** 手動デジタイズ (ペン作図) (フェーズ8。作図中のみ非 null) */
  penDraw: PenDrawState | null;

  // 文字刺繍
  textSettings: TextSettings;
  /** 面の塗り方 (文字でサテン/auto を使う。画像はタタミ) */
  fillType: FillType;

  // 写真刺繍 (PhotoStitch)
  photoSettings: PhotoSettings;
  /** PhotoStitch モード (ON のとき画像を写真刺繍として変換) */
  photoMode: boolean;

  /** 3D パフィー (サテンを詰めて立体的に) */
  puffy: boolean;

  /** 線画モード (ON のとき領域を骨格化して中心線サテン/ビーンで縫う。塗らない) */
  outlineMode: boolean;

  // AI 補正
  aiCorrection: AiCorrectionSettings;
  aiStatus: "idle" | "loading" | "done" | "error";
  aiError: string;
  aiResult: AiRecommendation | null;
  aiAnalysis: AiAnalysis | null;
  aiResultSource: "local" | "ai" | null;

  /** 再描画コールバック (UI コンポーネントが状態変更後に呼ぶ) */
  onChange?: () => void;
}

export interface PhotoSettings {
  colorCount: number;
  contrast: number;
  brightness: number;
  removeBackground: boolean;
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
    excludedRegions: [],
    objects: [],
    plan: null,
    diagnostics: null,
    sequence: null,
    simulation: null,
    stitchWarnings: [],
    selectedObjectId: null,
    selectedRegionIndex: null,
    angleLineDraw: false,
    hiddenObjectIds: new Set(),
    reduceApplied: [],
    simFrame: 0,
    simPlaying: false,
    simSpeed: 1,
    highlightUnderlay: false,
    vectorEdit: null,
    stitchEdit: null,
    penDraw: null,
    textSettings: {
      text: "",
      fontFamily: "sans-serif",
      fontSizeMm: 15,
      letterSpacingMm: 0,
      mode: "horizontal",
      arcRadiusMm: 40,
      fillType: "auto",
    },
    fillType: "auto",
    photoSettings: { colorCount: 1, contrast: 1.2, brightness: 0, removeBackground: true },
    photoMode: false,
    puffy: false,
    outlineMode: false,
    aiCorrection: {
      protectHighlights: true,
      preserveTransparency: true,
      simplifyPhoto: false,
      minimizeTrims: true,
      autoStitchType: true,
    },
    aiStatus: "idle",
    aiError: "",
    aiResult: null,
    aiAnalysis: null,
    aiResultSource: null,
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

/** PhotoStitch を生成して plan に反映する (photoMode ON 時) */
export function recomputePhoto(state: AppState): void {
  if (!state.raster) return;
  const ps = state.photoSettings;
  const result = generatePhotoStitch(state.raster, designName(state), {
    targetSizeMm: state.project.settings.targetSizeMm,
    colorCount: ps.colorCount,
    contrast: ps.contrast,
    brightness: ps.brightness,
    removeBackground: ps.removeBackground,
  });
  state.regions = []; // 写真刺繍は領域を使わない
  state.plan = result.plan;
  state.project.plan = result.plan;
  state.stitchWarnings = result.warnings;
  refreshDerived(state);
  state.reduceApplied = [];
}

/** PhotoStitch モードの切替。ON で写真変換、OFF で通常デジタイズに戻す */
export function setPhotoMode(state: AppState, on: boolean): void {
  state.photoMode = on;
  if (on) recomputePhoto(state);
  else recomputeRegions(state);
}

/** 線画モードの切替。ON で領域を骨格化して線として縫う (塗らない) */
export function setOutlineMode(state: AppState, on: boolean): void {
  state.outlineMode = on;
  recomputeStitches(state);
}

/** 布地レシピを選択し、下縫いを推奨値で初期化してステッチを再生成する */
export function applyFabric(state: AppState, fabricId: string): void {
  state.project.settings.fabricId = fabricId;
  // 下縫いはレシピの推奨で上書き (ユーザーはステッチタブで再調整可能)
  state.project.settings.underlay = [...getRecipe(fabricId).underlay];
  recomputeStitches(state);
}

/**
 * ベクター編集を開始: 現在の領域を編集可能形状に変換する。
 * @param focus 最初に編集対象にする領域インデックス (選択パーツの輪郭を直接編集する用)
 */
export function enterVectorEdit(state: AppState, focus = 0): void {
  if (state.regions.length === 0) {
    state.vectorEdit = null;
    return;
  }
  state.vectorEdit = {
    shapes: state.regions.map((r) => regionToEditShape(r)),
    activeShape: Math.max(0, Math.min(state.regions.length - 1, focus)),
    activePath: "outer",
    selectedNode: null,
    tool: "select",
    snapEnabled: true,
    // 破棄時に戻せるよう、開始時の形状を控える
    original: state.regions.map((r) => ({
      outer: r.outer.map((p) => ({ x: p.x, y: p.y })),
      holes: r.holes.map((h) => h.map((p) => ({ x: p.x, y: p.y }))),
    })),
  };
}

/**
 * 編集中の形状を「元の領域オブジェクトに上書き」する (参照は維持し、輪郭配列だけ
 * 新しくする)。これによりオブジェクトの id・色・縫い方・方向は保たれ、
 * 形状が変わったパーツだけがキャッシュ無効化されて縫い直される (差分再生成)。
 */
function writeShapeToRegion(state: AppState, shapeIndex: number): void {
  const ve = state.vectorEdit;
  if (!ve) return;
  const region = state.regions[shapeIndex];
  if (!region) return;
  const r = editShapeToRegion(ve.shapes[shapeIndex]);
  region.outer = r.outer; // 新しい配列参照 → このパーツのキャッシュだけ無効化
  region.holes = r.holes;
}

/**
 * ベクター編集の現在状態をライブ反映する (ドラッグ中も縫い目が追従)。
 * @param opts.skipDerived ドラッグ中は診断等を省いて軽量に
 * @param shapeIndex 指定があればその形状のみ書き戻す (既定は活性形状)
 */
export function liveApplyVectorEdit(
  state: AppState,
  opts: { skipDerived?: boolean } = {},
  shapeIndex?: number,
): void {
  const ve = state.vectorEdit;
  if (!ve) return;
  const idx = shapeIndex ?? ve.activeShape;
  writeShapeToRegion(state, idx);
  state.project.regions = state.regions;
  recomputeStitches(state, opts);
}

/** ベクター編集を確定: 全形状を領域へ書き戻してステッチを再生成 */
export function applyVectorEdit(state: AppState): void {
  if (!state.vectorEdit) return;
  for (let i = 0; i < state.vectorEdit.shapes.length; i++) writeShapeToRegion(state, i);
  state.project.regions = state.regions;
  recomputeStitches(state);
  state.vectorEdit = null;
}

/** 選択パーツの縫い方を設定 (null で全体設定に従う) して再生成する */
export function setRegionFill(state: AppState, idx: number, fill: FillType | null): void {
  const region = state.regions[idx];
  if (!region) return;
  if (fill === null) delete region.fillType;
  else region.fillType = fill;
  state.project.regions = state.regions;
  recomputeStitches(state);
}

/** 選択パーツの糸色を設定して再生成する (色は縫い順グループのキーにもなる) */
export function setRegionColor(state: AppState, idx: number, color: ThreadColor): void {
  const region = state.regions[idx];
  if (!region) return;
  region.color = { ...color };
  state.project.regions = state.regions;
  recomputeStitches(state);
}

/**
 * 選択パーツのステッチ角度を設定 (null で全体角度に戻す) して再生成する。
 * 面(タタミ)の縫い目方向を決める。
 */
export function setRegionAngle(
  state: AppState,
  idx: number,
  deg: number | null,
  opts: { skipDerived?: boolean } = {},
): void {
  const region = state.regions[idx];
  if (!region) return;
  if (deg === null) delete region.angleDeg;
  else region.angleDeg = ((Math.round(deg) % 180) + 180) % 180;
  state.project.regions = state.regions;
  recomputeStitches(state, opts);
}

/** パーツの実効ステッチ角度 (個別設定がなければ全体角度) */
export function effectiveAngle(state: AppState, idx: number): number {
  return state.regions[idx]?.angleDeg ?? state.project.settings.angleDeg;
}

/** 選択パーツに方向線(ターニング)を1本追加して再生成する */
export function addRegionAngleLine(state: AppState, idx: number, line: DirectionLine): void {
  const region = state.regions[idx];
  if (!region) return;
  region.angleLines = [...(region.angleLines ?? []), line];
  state.project.regions = state.regions;
  recomputeStitches(state);
}

/** 選択パーツの方向線をすべて消して再生成する */
export function clearRegionAngleLines(state: AppState, idx: number): void {
  const region = state.regions[idx];
  if (!region) return;
  delete region.angleLines;
  state.project.regions = state.regions;
  recomputeStitches(state);
}

/** 安定 id でオブジェクトを探す */
export function findObject(state: AppState, id: number): EmbroideryObject | undefined {
  return state.objects.find((o) => o.id === id);
}

/**
 * 色ブロックの縫い順を入れ替える (縫い順編集)。現在の plan のブロック並びから
 * 色キー列を作り、from→to に動かして settings.colorOrder に保存する。
 * 再生成しても色順が保持される。
 */
export function moveColorBlock(state: AppState, fromBlockIndex: number, toBlockIndex: number): void {
  if (!state.plan) return;
  const keys = state.plan.blocks.map((b) => `${b.thread.r},${b.thread.g},${b.thread.b}`);
  if (
    fromBlockIndex < 0 ||
    fromBlockIndex >= keys.length ||
    toBlockIndex < 0 ||
    toBlockIndex >= keys.length ||
    fromBlockIndex === toBlockIndex
  ) {
    return;
  }
  const [moved] = keys.splice(fromBlockIndex, 1);
  keys.splice(toBlockIndex, 0, moved);
  state.project.settings.colorOrder = keys;
  recomputeStitches(state);
}

/**
 * 同色グループ内でオブジェクトの縫い順を1つ前/後にずらす。
 * dir < 0 = 先に縫う、dir > 0 = 後に縫う。色の境界は越えない (色順は moveColorBlock)。
 * 現在の縫い順 (sequence) から各色グループのオブジェクト列を作り、対象色内で入れ替える。
 */
export function moveObjectInColor(state: AppState, objectId: number, dir: number): void {
  if (!state.sequence) return;
  // 縫い順どおりに色ブロックごとのオブジェクト id 列を作る (1 オブジェクトが
  // 下縫い+本縫いで複数 Run = 複数エントリになるため、重複は除いて初出順を保つ)
  const blocks = new Map<number, number[]>();
  for (const e of state.sequence.entries) {
    if (e.objectId == null) continue;
    const arr = blocks.get(e.blockIndex) ?? [];
    if (!arr.includes(e.objectId)) arr.push(e.objectId);
    blocks.set(e.blockIndex, arr);
  }
  // 対象オブジェクトの色ブロックを特定
  let targetBlock = -1;
  for (const [bi, ids] of blocks) if (ids.includes(objectId)) targetBlock = bi;
  if (targetBlock < 0) return;
  const ids = blocks.get(targetBlock) as number[];
  const i = ids.indexOf(objectId);
  const j = i + dir;
  if (j < 0 || j >= ids.length) return; // 同色内の端 (これ以上は動かせない)
  [ids[i], ids[j]] = [ids[j], ids[i]];
  // 全色ブロックを縫い順 (blockIndex 昇順) に連結して全体のオブジェクト順を作る
  const order: number[] = [];
  for (const bi of [...blocks.keys()].sort((a, b) => a - b)) order.push(...(blocks.get(bi) as number[]));
  state.project.settings.objectOrder = order;
  recomputeStitches(state);
}

/**
 * プロジェクト読み込み後にオブジェクト層 (id・baked) を復元する。
 * project.objects が regions と添字対応していればそれを使い、固定針・手動の線・
 * 選択の同一性を保つ。なければ regions から作り直す (前方互換)。
 */
export function restoreObjectsFromProject(state: AppState): void {
  const meta = state.project.objects;
  const regions = state.regions;
  if (meta && meta.length === regions.length) {
    state.objects = regions.map((region, i) => {
      const m = meta[i];
      const obj: EmbroideryObject = { id: m?.id ?? nextObjectId(), region };
      if (m?.baked && m.baked.length > 0) obj.baked = m.baked;
      if (m?.name) obj.name = m.name;
      return obj;
    });
    let maxId = -1;
    for (const o of state.objects) if (o.id > maxId) maxId = o.id;
    if (maxId >= 0) bumpObjectId(maxId);
  } else {
    state.objects = reconcileObjects(state.objects, regions);
  }
}

/**
 * オブジェクトを「マニュアル化 (ベイク)」する。
 * 現在の plan 上のそのオブジェクトの針列を baked として固定し、
 * 以後は自動再生成せずこの針列を使う (個々の針編集 = Phase 7 の入口)。
 * @returns ベイクできたら true
 */
export function bakeObject(state: AppState, id: number): boolean {
  const obj = findObject(state, id);
  if (!obj || !state.plan) return false;
  const runs = state.plan.blocks
    .flatMap((b) => b.runs)
    .filter((r) => r.objectId === id && r.stitches.length > 0)
    .map((r) => ({
      stitches: r.stitches.map((p) => ({ x: p.x, y: p.y })),
      connection: r.connection,
      stitchType: "manual" as const,
    }));
  if (runs.length === 0) return false;
  obj.baked = runs;
  recomputeStitches(state);
  return true;
}

/** マニュアル化を解除し、自動再生成に戻す */
export function unbakeObject(state: AppState, id: number): void {
  const obj = findObject(state, id);
  if (obj?.baked) {
    delete obj.baked;
    recomputeStitches(state);
  }
}

// --- 個々の針 (ステッチ点) 編集 (フェーズ7) ---

/** 針編集を開始する。未ベイクなら先にベイクしてから編集モードに入る */
export function enterStitchEdit(state: AppState, regionIndex: number): boolean {
  const obj = state.objects[regionIndex];
  if (!obj) return false;
  if (!obj.baked || obj.baked.length === 0) {
    if (!bakeObject(state, obj.id)) return false;
  }
  state.stitchEdit = { objectId: obj.id, tool: "move", sel: null };
  return true;
}

/** 針編集を終了する */
export function exitStitchEdit(state: AppState): void {
  state.stitchEdit = null;
}

/** 編集中の baked オブジェクトを返す */
export function stitchEditObject(state: AppState): EmbroideryObject | undefined {
  return state.stitchEdit ? findObject(state, state.stitchEdit.objectId) : undefined;
}

/** baked の指定 run の針列を関数で書き換える (新しい配列で差し替え) */
function editBakedRun(
  obj: EmbroideryObject,
  run: number,
  fn: (stitches: Point[]) => Point[],
): void {
  if (!obj.baked) return;
  const r = obj.baked[run];
  if (!r) return;
  const runs = obj.baked.slice();
  runs[run] = {
    stitches: fn(r.stitches.map((p) => ({ x: p.x, y: p.y }))),
    connection: r.connection,
    stitchType: r.stitchType,
  };
  obj.baked = runs;
}

/** 針を移動する (ドラッグ中は skipDerived で軽量に) */
export function moveBakedStitch(
  state: AppState,
  run: number,
  idx: number,
  p: Point,
  opts: { skipDerived?: boolean } = {},
): void {
  const obj = stitchEditObject(state);
  if (!obj) return;
  editBakedRun(obj, run, (s) => {
    if (idx >= 0 && idx < s.length) s[idx] = { x: Math.round(p.x), y: Math.round(p.y) };
    return s;
  });
  recomputeStitches(state, opts);
}

/** 針を afterIdx の後ろに挿入する */
export function insertBakedStitch(state: AppState, run: number, afterIdx: number, p: Point): void {
  const obj = stitchEditObject(state);
  if (!obj) return;
  editBakedRun(obj, run, (s) => {
    s.splice(afterIdx + 1, 0, { x: Math.round(p.x), y: Math.round(p.y) });
    return s;
  });
  recomputeStitches(state);
}

/** 針を削除する (run あたり最低2点は残す) */
export function deleteBakedStitch(state: AppState, run: number, idx: number): void {
  const obj = stitchEditObject(state);
  if (!obj) return;
  editBakedRun(obj, run, (s) => (s.length > 2 ? s.filter((_, i) => i !== idx) : s));
  recomputeStitches(state);
}

// --- 手動デジタイズ (ペン作図, フェーズ8) ---

/** 折れ線を step 間隔で再サンプル (走り縫いの針列を作る) */
function resamplePolyline(pts: Point[], step: number): Point[] {
  if (pts.length === 0) return [];
  const out: Point[] = [{ x: Math.round(pts[0].x), y: Math.round(pts[0].y) }];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 1; k <= n; k++) {
      out.push({ x: Math.round(a.x + ((b.x - a.x) * k) / n), y: Math.round(a.y + ((b.y - a.y) * k) / n) });
    }
  }
  return out;
}

/** ペン作図を開始する (面 or 線)。他の編集モードは解除する */
export function startPenDraw(state: AppState, kind: "fill" | "line"): void {
  state.vectorEdit = null;
  state.stitchEdit = null;
  state.angleLineDraw = false;
  state.penDraw = { kind, points: [] };
}

/** 作図中の点を1つ追加する */
export function addPenPoint(state: AppState, p: Point): void {
  if (state.penDraw) state.penDraw.points.push({ x: Math.round(p.x), y: Math.round(p.y) });
}

/** 作図を取り消す */
export function cancelPenDraw(state: AppState): void {
  state.penDraw = null;
}

/**
 * 作図を確定して新しいオブジェクトを作る。
 * - fill: 閉じた面 → 既存のフィルパイプライン (縫い方/角度/ターニング/編集が効く)
 * - line: 開いた線 → 走り縫いを baked として持つオブジェクト
 * @returns 作成できたら true
 */
export function finishPenDraw(state: AppState): boolean {
  const pd = state.penDraw;
  if (!pd) return false;
  const color = { r: 0, g: 0, b: 0, name: "Black" };
  if (pd.kind === "fill") {
    if (pd.points.length < 3) {
      state.penDraw = null;
      return false;
    }
    // 外周は signedArea が正 (時計回り) になるよう正規化
    const outer = signedArea(pd.points) < 0 ? pd.points.slice().reverse() : pd.points.slice();
    const region: Region = { outer, holes: [], color };
    state.regions = [...state.regions, region];
    state.project.regions = state.regions;
    state.penDraw = null;
    recomputeStitches(state);
    state.selectedRegionIndex = state.regions.length - 1;
    return true;
  }
  // line
  if (pd.points.length < 2) {
    state.penDraw = null;
    return false;
  }
  const region: Region = { outer: pd.points.slice(), holes: [], color };
  const obj = makeObject(region);
  obj.baked = [{ stitches: resamplePolyline(pd.points, RUNNING_DEFAULT_LEN), connection: "trim", stitchType: "running" }];
  // 領域とオブジェクトを同時に追加 (reconcile が参照一致で baked 付きオブジェクトを保つ)
  state.regions = [...state.regions, region];
  state.objects = [...state.objects, obj];
  state.project.regions = state.regions;
  state.penDraw = null;
  recomputeStitches(state);
  state.selectedRegionIndex = state.regions.length - 1;
  return true;
}

/** 装飾配置などで領域を差し替え、ステッチを再生成する */
export function replaceRegions(state: AppState, regions: Region[]): void {
  state.regions = regions;
  state.project.regions = regions;
  state.photoMode = false;
  recomputeStitches(state);
}

/** 現在の領域をアップリケ工程の plan に変換する (digitize を介さず直接) */
export function applyApplique(state: AppState, satinWidthMm: number): void {
  if (state.regions.length === 0) return;
  state.plan = appliquePlan(state.regions, designName(state), { satinWidthMm });
  state.project.plan = state.plan;
  state.photoMode = false;
  refreshDerived(state);
  state.reduceApplied = [];
}

/** ベクター編集を破棄: ライブ反映していた形状を開始時に戻す */
export function cancelVectorEdit(state: AppState): void {
  const ve = state.vectorEdit;
  if (ve) {
    let changed = false;
    ve.original.forEach((snap, i) => {
      const region = state.regions[i];
      if (!region) return;
      region.outer = snap.outer.map((p) => ({ x: p.x, y: p.y }));
      region.holes = snap.holes.map((h) => h.map((p) => ({ x: p.x, y: p.y })));
      changed = true;
    });
    state.vectorEdit = null;
    if (changed) {
      state.project.regions = state.regions;
      recomputeStitches(state);
    }
  }
}

/** 設定から領域抽出をやり直す (ソース → regions) */
export function recomputeRegions(state: AppState): void {
  const s = state.project.settings;
  if (state.project.source.kind === "svg" && state.project.source.data) {
    state.regions = importSvg(state.project.source.data, mm(s.targetSizeMm)).regions;
    state.excludedRegions = [];
    state.labelMap = null;
  } else if (state.raster) {
    state.labelMap = quantize(state.raster, {
      colorCount: s.colorCount,
      removeWhiteBackground: s.removeWhiteBackground,
    });
    // 目標サイズ連動: 小さいデザインでは面積閾値を下げて小特徴を残す
    const sizeRatio = s.targetSizeMm / 100;
    const scaledMinArea = Math.round(300 * sizeRatio * sizeRatio);
    const result = extractRegions(state.labelMap, {
      unitsPerPixel: fitUnitsPerPixel(state.raster.width, state.raster.height, mm(s.targetSizeMm)),
      minRegionArea: scaledMinArea,
    });
    state.regions = result.regions;
    state.excludedRegions = result.excludedRegions;
  }
  state.project.regions = state.regions;
  recomputeStitches(state);
}

/** 除外された小領域を復元して regions に追加する */
export function restoreExcludedRegion(state: AppState, index: number): void {
  const ex = state.excludedRegions[index];
  if (!ex) return;
  const region: Region = { outer: ex.outer, holes: [], color: ex.color };
  state.regions = [...state.regions, region];
  state.excludedRegions = state.excludedRegions.filter((_, i) => i !== index);
  state.project.regions = state.regions;
  recomputeStitches(state);
}

/** 除外された小領域をすべて復元する */
export function restoreAllExcluded(state: AppState): void {
  for (const ex of state.excludedRegions) {
    state.regions.push({ outer: ex.outer, holes: [], color: ex.color });
  }
  state.excludedRegions = [];
  state.project.regions = state.regions;
  recomputeStitches(state);
}

/**
 * 領域からステッチを生成し直す (regions → plan → 診断)。
 * @param opts.skipDerived 診断・シーケンス・シミュレーションの再構築を省く
 *   (方向ドラッグ中など、軽量に縫い直してキャンバスだけ更新したいとき)。
 *   差分再生成 (オブジェクトキャッシュ) と併せて、ドラッグを軽快にする。
 */
export function recomputeStitches(state: AppState, opts: { skipDerived?: boolean } = {}): void {
  const s = state.project.settings;
  if (state.regions.length === 0) {
    state.objects = [];
    state.plan = null;
    state.diagnostics = null;
    state.sequence = null;
    state.simulation = null;
    state.stitchWarnings = [];
    return;
  }
  // 永続オブジェクトを regions に同期 (その場編集では id を維持、構造変更では作り直す)
  state.objects = reconcileObjects(state.objects, state.regions);
  // 保存用に領域とオブジェクト層 (id・baked) を常にプロジェクトへ反映
  state.project.regions = state.regions;
  state.project.objects = state.objects.map((o) => ({ id: o.id, baked: o.baked, name: o.name }));
  // 布地レシピ由来の密度・補正・最小サイズを基礎にし、
  // 角度・糸切りモード・下縫いはユーザー設定 (ステッチタブ) で上書きする
  const recipe = getRecipe(s.fabricId);
  const recipeOpts = recipeToDigitizeOptions(recipe);
  const densityScale = s.densityScale ?? 1.0;
  // 目標サイズ連動: 小さいデザインでは minObjectExtent を下げて小特徴を残す
  const sizeRatio = s.targetSizeMm / 100;
  const scaledMinExtent = recipeOpts.minObjectExtent
    ? Math.round(recipeOpts.minObjectExtent * sizeRatio)
    : undefined;
  // 密度プリセット: 行間隔・サテン間隔に倍率を掛ける (省針数 ⇄ 高密度)。
  // scale = densityScale (ユーザー) × auto (目標針数に収める先回り倍率)
  const generate = (scale: number): ReturnType<typeof digitizeRegions> =>
    digitizeRegions(
      state.regions,
      designName(state),
      {
        ...recipeOpts,
        rowSpacing: recipeOpts.rowSpacing ? Math.round(recipeOpts.rowSpacing * scale) : recipeOpts.rowSpacing,
        angleDeg: s.angleDeg,
        trimMode: s.trimMode,
        underlay: s.underlay as UnderlayType[],
        satinUnderlay: s.satinUnderlay,
        fillType: state.outlineMode ? "outline" : state.puffy ? "satin" : state.fillType,
        minObjectExtent: scaledMinExtent,
        // 3D パフィー: サテンを詰めて盛り上げる (スポンジ併用想定)。それ以外は密度倍率を適用
        satinSpacing: state.puffy
          ? mm(0.3)
          : scale !== 1.0
            ? Math.round(SATIN_DEFAULT.spacing * scale)
            : undefined,
        colorOrder: state.project.settings.colorOrder,
        objectOrder: state.project.settings.objectOrder,
      },
      state.objects,
    );

  let result = generate(densityScale);
  const autoNotes: string[] = [];

  // --- 目標針数への自動密度調整 (先回り autoReduce) ---
  // ドラッグ中 (skipDerived) は重い再生成を避け、現在密度のまま。
  const target = s.targetStitchCount ?? 0;
  if (!opts.skipDerived && target > 0 && countStitches(result.plan) > target) {
    const before = countStitches(result.plan);
    // densityScale の上に追加倍率を掛けて段階的に粗くする
    const steps = [1.15, 1.3, 1.5, 1.75, 2.0];
    let applied = 1.0;
    for (const m of steps) {
      if (countStitches(result.plan) <= target) break;
      result = generate(densityScale * m);
      applied = m;
    }
    const after = countStitches(result.plan);
    if (after > target) {
      autoNotes.push(
        `目標 ${target} 針に未達 (${after} 針)。密度を上げきりました。サイズ縮小か手動の自動針数削減を検討してください`,
      );
    } else if (applied > 1.0) {
      autoNotes.push(`目標 ${target} 針に収めるため密度を自動調整しました (×${applied.toFixed(2)}、${before}→${after} 針)`);
    }
  }

  state.plan = result.plan;
  state.project.plan = result.plan;
  state.stitchWarnings = result.warnings;
  if (!opts.skipDerived) refreshDerived(state);
  state.reduceApplied = autoNotes;
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
  state.fillType = "auto"; // 細い領域は自動でサテン、広い面はタタミ
  state.project.source = { kind: "image", data: dataUrl, fileName };
  state.project.name = fileName.replace(/\.[^.]+$/, "") || "design";
  if (!state.project.id) state.project.id = generateId();
  if (state.photoMode) recomputePhoto(state);
  else recomputeRegions(state);
}

export function setSourceSvg(state: AppState, svgText: string, fileName: string): void {
  state.raster = null;
  state.labelMap = null;
  state.fillType = "auto";
  state.photoMode = false; // SVG は写真刺繍の対象外
  state.project.source = { kind: "svg", data: svgText, fileName };
  state.project.name = fileName.replace(/\.[^.]+$/, "") || "design";
  recomputeRegions(state);
}
