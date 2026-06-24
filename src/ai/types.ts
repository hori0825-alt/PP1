// AI 解析の型定義。フロントエンド (client.ts) とバックエンド (api/embroidery-ai.ts) で共用。
// API キーやプロバイダー情報はフロントエンドに一切持たない。

// --- 基本設定の推奨 (オフライン/AI 共通) ---

export interface AiRecommendation {
  analysis: string;
  colorCount: number;
  fillType: "auto" | "satin" | "tatami";
  angleDeg: number;
  densityScale: number;
  underlay: string[];
  satinUnderlay: "auto" | "none" | "center" | "center-zigzag";
  removeWhiteBackground: boolean;
  tips: string[];
}

// --- 包括的 AI 解析結果 (バックエンド経由のみ) ---

export interface ProtectedRegion {
  name: string;
  reason: string;
  priority: "high" | "medium" | "low";
}

export interface TransparentRegion {
  reason: string;
}

export interface ColorReductionPlan {
  target_color_count: number;
  keep_colors: Array<{ r: number; g: number; b: number; reason?: string }>;
  merge_colors: Array<{ from: { r: number; g: number; b: number }; to: { r: number; g: number; b: number }; reason?: string }>;
  do_not_merge: Array<{ r: number; g: number; b: number; reason?: string }>;
}

export interface VectorizationPlan {
  smoothing_level: "low" | "medium" | "high";
  preserve_small_details: string[];
  remove_noise_regions: string[];
  keep_holes: boolean;
}

export interface StitchPlanItem {
  region_name: string;
  stitch_type: "satin" | "tatami" | "running";
  reason: string;
  recommended_width_mm?: number;
  density: "low" | "medium" | "high";
  direction: string;
}

export interface ThreadTrimPlan {
  minimize_trims: boolean;
  connect_nearby_same_color_regions: boolean;
  max_jump_before_trim_mm: number;
  recommended_order: string[];
}

export interface AiWarning {
  type: string;
  message: string;
}

export interface AiAnalysis {
  image_type: "photo" | "illustration" | "anime" | "logo" | "line_art";
  protected_regions: ProtectedRegion[];
  transparent_or_empty_regions: TransparentRegion[];
  color_reduction_plan: ColorReductionPlan;
  vectorization_plan: VectorizationPlan;
  stitch_plan: StitchPlanItem[];
  thread_trim_plan: ThreadTrimPlan;
  warnings: AiWarning[];
}

// --- フロントエンド → バックエンドへのリクエスト ---

export interface AiCorrectionSettings {
  protectHighlights: boolean;
  preserveTransparency: boolean;
  simplifyPhoto: boolean;
  minimizeTrims: boolean;
  autoStitchType: boolean;
}

export interface AiRequestMetadata {
  originalWidth: number;
  originalHeight: number;
  hasTransparentPixels: boolean;
  currentColorCount: number;
  dominantColors: Array<{ r: number; g: number; b: number; percentage: number }>;
  estimatedStitchCount: number | null;
  settings: {
    targetSizeMm: number;
    maxColors: number;
    maxStitches: number | null;
    fillType: string;
    angleDeg: number;
    densityScale: number;
    trimMode: string;
  };
  preferences: AiCorrectionSettings;
}

export interface AiRequestPayload {
  image: string;
  metadata: AiRequestMetadata;
}
