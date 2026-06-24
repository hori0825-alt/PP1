// AI クライアント: バックエンド (/api/embroidery-ai) を呼び出す。
// フロントエンドに API キーは一切保持しない。
// エラー時は null を返し、呼び出し側がオフラインフォールバックする。

import type { AiAnalysis, AiCorrectionSettings, AiRequestPayload } from "./types";

declare const __AI_API_URL__: string | undefined;

const AI_API_URL = (() => {
  try {
    const base = typeof __AI_API_URL__ !== "undefined" ? __AI_API_URL__ : "";
    return base ? `${base}/api/embroidery-ai` : "/api/embroidery-ai";
  } catch {
    return "/api/embroidery-ai";
  }
})();

export interface AnalysisMetadata {
  originalWidth: number;
  originalHeight: number;
  hasTransparentPixels: boolean;
  currentColorCount: number;
  dominantColors: Array<{ r: number; g: number; b: number; percentage: number }>;
  estimatedStitchCount: number | null;
  targetSizeMm: number;
  maxColors: number;
  maxStitches: number | null;
  fillType: string;
  angleDeg: number;
  densityScale: number;
  trimMode: string;
}

export async function analyzeWithAi(
  imageDataUrl: string,
  metadata: AnalysisMetadata,
  preferences: AiCorrectionSettings,
): Promise<{ analysis: AiAnalysis } | { error: string }> {
  const base64 = await resizeForAnalysis(imageDataUrl, 1024);
  if (!base64) return { error: "画像の縮小に失敗しました" };

  const payload: AiRequestPayload = {
    image: base64,
    metadata: {
      originalWidth: metadata.originalWidth,
      originalHeight: metadata.originalHeight,
      hasTransparentPixels: metadata.hasTransparentPixels,
      currentColorCount: metadata.currentColorCount,
      dominantColors: metadata.dominantColors,
      estimatedStitchCount: metadata.estimatedStitchCount,
      settings: {
        targetSizeMm: metadata.targetSizeMm,
        maxColors: metadata.maxColors,
        maxStitches: metadata.maxStitches,
        fillType: metadata.fillType,
        angleDeg: metadata.angleDeg,
        densityScale: metadata.densityScale,
        trimMode: metadata.trimMode,
      },
      preferences,
    },
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    const res = await fetch(AI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      return { error: body.error ?? `AI解析に失敗しました (${res.status})` };
    }

    const data = (await res.json()) as Record<string, unknown>;

    if (data.error) {
      return { error: String(data.error) };
    }

    const analysis = validateAnalysis(data);
    if (!analysis) {
      return { error: "AIからの応答が不正な形式でした" };
    }

    return { analysis };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { error: "AI解析がタイムアウトしました (60秒)" };
    }
    if (err instanceof TypeError && (err.message.includes("fetch") || err.message.includes("network"))) {
      return { error: "AIサーバーに接続できません。バックエンドがデプロイされているか確認してください。" };
    }
    return { error: "AI補正に失敗しました" };
  }
}

function resizeForAnalysis(dataUrl: string, maxDim: number): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, w, h);
        const result = canvas.toDataURL("image/png");
        const base64 = result.split(",")[1];
        resolve(base64 ?? null);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

const VALID_IMAGE_TYPES = ["photo", "illustration", "anime", "logo", "line_art"];

function validateAnalysis(data: Record<string, unknown>): AiAnalysis | null {
  if (!data.image_type || !VALID_IMAGE_TYPES.includes(String(data.image_type))) {
    return null;
  }

  return {
    image_type: String(data.image_type) as AiAnalysis["image_type"],
    protected_regions: Array.isArray(data.protected_regions)
      ? (data.protected_regions as Array<Record<string, unknown>>).map((r) => ({
          name: String(r.name ?? ""),
          reason: String(r.reason ?? ""),
          priority: (["high", "medium", "low"].includes(String(r.priority)) ? String(r.priority) : "medium") as "high" | "medium" | "low",
        }))
      : [],
    transparent_or_empty_regions: Array.isArray(data.transparent_or_empty_regions)
      ? (data.transparent_or_empty_regions as Array<Record<string, unknown>>).map((r) => ({
          reason: String(r.reason ?? ""),
        }))
      : [],
    color_reduction_plan: validateColorPlan(data.color_reduction_plan as Record<string, unknown> | undefined),
    vectorization_plan: validateVecPlan(data.vectorization_plan as Record<string, unknown> | undefined),
    stitch_plan: Array.isArray(data.stitch_plan)
      ? (data.stitch_plan as Array<Record<string, unknown>>).map((s) => ({
          region_name: String(s.region_name ?? ""),
          stitch_type: (["satin", "tatami", "running"].includes(String(s.stitch_type)) ? String(s.stitch_type) : "tatami") as "satin" | "tatami" | "running",
          reason: String(s.reason ?? ""),
          recommended_width_mm: typeof s.recommended_width_mm === "number" ? s.recommended_width_mm : undefined,
          density: (["low", "medium", "high"].includes(String(s.density)) ? String(s.density) : "medium") as "low" | "medium" | "high",
          direction: String(s.direction ?? "along_path"),
        }))
      : [],
    thread_trim_plan: validateTrimPlan(data.thread_trim_plan as Record<string, unknown> | undefined),
    warnings: Array.isArray(data.warnings)
      ? (data.warnings as Array<Record<string, unknown>>).map((w) => ({
          type: String(w.type ?? ""),
          message: String(w.message ?? ""),
        }))
      : [],
  };
}

function validateColorPlan(plan: Record<string, unknown> | undefined): AiAnalysis["color_reduction_plan"] {
  if (!plan) return { target_color_count: 6, keep_colors: [], merge_colors: [], do_not_merge: [] };
  return {
    target_color_count: Math.min(12, Math.max(2, Math.round(Number(plan.target_color_count ?? 6)))),
    keep_colors: Array.isArray(plan.keep_colors) ? (plan.keep_colors as Array<Record<string, unknown>>).map(parseColorEntry) : [],
    merge_colors: Array.isArray(plan.merge_colors)
      ? (plan.merge_colors as Array<Record<string, unknown>>).map((m) => ({
          from: parseRgb(m.from as Record<string, unknown> | undefined),
          to: parseRgb(m.to as Record<string, unknown> | undefined),
          reason: String(m.reason ?? ""),
        }))
      : [],
    do_not_merge: Array.isArray(plan.do_not_merge) ? (plan.do_not_merge as Array<Record<string, unknown>>).map(parseColorEntry) : [],
  };
}

function parseColorEntry(c: Record<string, unknown>): { r: number; g: number; b: number; reason?: string } {
  return { ...parseRgb(c), reason: c.reason ? String(c.reason) : undefined };
}

function parseRgb(c: Record<string, unknown> | undefined): { r: number; g: number; b: number } {
  if (!c) return { r: 0, g: 0, b: 0 };
  return {
    r: Math.round(Number(c.r ?? 0)) & 0xff,
    g: Math.round(Number(c.g ?? 0)) & 0xff,
    b: Math.round(Number(c.b ?? 0)) & 0xff,
  };
}

function validateVecPlan(plan: Record<string, unknown> | undefined): AiAnalysis["vectorization_plan"] {
  if (!plan) return { smoothing_level: "medium", preserve_small_details: [], remove_noise_regions: [], keep_holes: true };
  return {
    smoothing_level: (["low", "medium", "high"].includes(String(plan.smoothing_level)) ? String(plan.smoothing_level) : "medium") as "low" | "medium" | "high",
    preserve_small_details: Array.isArray(plan.preserve_small_details) ? plan.preserve_small_details.map(String) : [],
    remove_noise_regions: Array.isArray(plan.remove_noise_regions) ? plan.remove_noise_regions.map(String) : [],
    keep_holes: plan.keep_holes !== false,
  };
}

function validateTrimPlan(plan: Record<string, unknown> | undefined): AiAnalysis["thread_trim_plan"] {
  if (!plan) return { minimize_trims: true, connect_nearby_same_color_regions: true, max_jump_before_trim_mm: 8, recommended_order: [] };
  return {
    minimize_trims: plan.minimize_trims !== false,
    connect_nearby_same_color_regions: plan.connect_nearby_same_color_regions !== false,
    max_jump_before_trim_mm: Math.max(1, Math.min(30, Number(plan.max_jump_before_trim_mm ?? 8))),
    recommended_order: Array.isArray(plan.recommended_order) ? plan.recommended_order.map(String) : [],
  };
}
