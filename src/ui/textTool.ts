// 文字刺繍 (ブラウザ層)。
// グリフを Canvas にラスタライズ → 既存の減色/領域抽出で輪郭化し、
// レイアウト計算 (src/text/layout.ts) の配置に従って Region 群へ変換する。
// グリフ取得以外のロジック (レイアウト・警告) は DOM 非依存でテスト済み。

import { UNIT_MM, mm } from "../core/constants";
import { signedArea } from "../core/geometry";
import type { Region } from "../core/region";
import { transformRegion } from "../core/transform";
import type { ThreadColor } from "../core/types";
import { quantize } from "../import/quantize";
import type { RasterImage } from "../import/raster";
import { extractRegions } from "../import/regions";
import { layoutText } from "../text/layout";
import type { GlyphMetric, LayoutMode } from "../text/layout";

/** グリフを描く基準ピクセルサイズ (高めにして輪郭品質を確保) */
const RENDER_PX = 160;

export interface TextDesignOptions {
  text: string;
  fontFamily: string;
  /** 文字高 (mm) */
  fontSizeMm: number;
  /** 字間 (mm) */
  letterSpacingMm: number;
  mode: LayoutMode;
  color: ThreadColor;
  /** 円弧配置の半径 (mm)。mode==='arc' のとき使用 */
  arcRadiusMm?: number;
}

/** 1グリフを Canvas に描いて RasterImage 化する */
function renderGlyph(char: string, fontFamily: string, advancePx: number): RasterImage | null {
  if (char.trim() === "") return null;
  const w = Math.max(8, Math.ceil(advancePx) + 8);
  const h = Math.ceil(RENDER_PX * 1.6);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#000000";
  ctx.font = `${RENDER_PX}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(char, w / 2, h / 2);
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

/** 各グリフの advance を measureText で取得 (RENDER_PX 基準) */
function measureAdvances(text: string, fontFamily: string): number[] {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return [...text].map(() => RENDER_PX);
  ctx.font = `${RENDER_PX}px ${fontFamily}`;
  return [...text].map((ch) => (ch === "\n" ? 0 : ctx.measureText(ch).width || RENDER_PX * 0.5));
}

/**
 * テキストを Region 群に変換する。
 * ピクセル→内部単位のスケール k = fontSize(内部) / RENDER_PX。
 */
export function textToRegions(options: TextDesignOptions): Region[] {
  const chars = [...options.text];
  if (chars.length === 0) return [];
  const fontInternal = mm(options.fontSizeMm);
  const k = fontInternal / RENDER_PX;

  const advancesPx = measureAdvances(options.text, options.fontFamily);
  const metrics: GlyphMetric[] = chars.map((ch, i) => ({
    char: ch,
    advance: advancesPx[i] * k,
  }));

  const placements = layoutText(metrics, {
    mode: options.mode,
    fontSize: fontInternal,
    letterSpacing: mm(options.letterSpacingMm),
    arcRadius: options.arcRadiusMm ? mm(options.arcRadiusMm) : undefined,
  });

  const regions: Region[] = [];
  for (const place of placements) {
    const advancePx = place.advance / k;
    const img = renderGlyph(place.char, options.fontFamily, advancePx);
    if (!img) continue;
    // 1色で減色 → 輪郭抽出 (グリフ canvas 中心が原点・k スケール)
    const labelMap = quantize(img, { colorCount: 2, removeWhiteBackground: true });
    const glyphRegions = extractRegions(labelMap, { unitsPerPixel: k, minRegionArea: 100 });
    for (const gr of glyphRegions) {
      // 色を指定色に、配置 (回転 + 平行移動) を適用
      const placed = transformRegion(
        { ...gr, color: options.color },
        { rotation: place.rotation, tx: place.x, ty: place.y },
      );
      // 反転で符号が崩れた場合に備え外周を正に正規化
      if (signedArea(placed.outer) < 0) placed.outer.reverse();
      regions.push(placed);
    }
  }
  return regions;
}

/** 設計の総幅・高さ (mm) を概算 (枠超過チェックの目安) */
export function textBoundsMm(regions: Region[]): { w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of regions) {
    for (const p of r.outer) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) return { w: 0, h: 0 };
  return { w: (maxX - minX) * UNIT_MM, h: (maxY - minY) * UNIT_MM };
}
