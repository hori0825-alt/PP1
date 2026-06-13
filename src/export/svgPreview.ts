// StitchPlan を SVG 文字列に描く (プレビュー画像用、DOM 非依存)。
// 実線=ステッチ、点線=渡り糸 (trim は赤)。100mm 枠も描く。
// 作業指示書やサンプルの見た目確認に使う。

import { HOOP_HALF, HOOP_SIZE, UNIT_MM } from "../core/constants";
import type { StitchPlan } from "../core/types";

export interface SvgPreviewOptions {
  /** 出力 SVG の1辺ピクセル数 */
  size?: number;
  /** 渡り糸を描くか */
  showTravel?: boolean;
}

export function planToSvg(plan: StitchPlan, options: SvgPreviewOptions = {}): string {
  const size = options.size ?? 400;
  const showTravel = options.showTravel ?? true;
  const pad = size * 0.05;
  const scale = (size - pad * 2) / HOOP_SIZE;
  const tx = (x: number): string => (size / 2 + x * scale).toFixed(1);
  const ty = (y: number): string => (size / 2 + y * scale).toFixed(1);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
  );
  parts.push(`<rect width="${size}" height="${size}" fill="#ffffff"/>`);
  // 100mm 枠
  parts.push(
    `<rect x="${tx(-HOOP_HALF)}" y="${ty(-HOOP_HALF)}" width="${(HOOP_SIZE * scale).toFixed(1)}" height="${(HOOP_SIZE * scale).toFixed(1)}" fill="none" stroke="#cdd4db" stroke-width="1"/>`,
  );

  let prevEnd: { x: number; y: number } | null = null;
  for (const block of plan.blocks) {
    const color = `rgb(${block.thread.r},${block.thread.g},${block.thread.b})`;
    for (const run of block.runs) {
      if (run.stitches.length === 0) continue;
      if (showTravel && prevEnd) {
        const dashColor = run.connection === "trim" ? "#d04545" : "#9aa4ad";
        parts.push(
          `<line x1="${tx(prevEnd.x)}" y1="${ty(prevEnd.y)}" x2="${tx(run.stitches[0].x)}" y2="${ty(run.stitches[0].y)}" stroke="${dashColor}" stroke-width="0.5" stroke-dasharray="2 2"/>`,
        );
      }
      const d = run.stitches
        .map((p, i) => `${i === 0 ? "M" : "L"}${tx(p.x)} ${ty(p.y)}`)
        .join(" ");
      parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="0.6"/>`);
      prevEnd = run.stitches[run.stitches.length - 1];
    }
  }

  // 実寸ラベル
  parts.push(
    `<text x="${pad}" y="${size - pad / 2}" font-family="sans-serif" font-size="10" fill="#8a939e">100mm × ${(HOOP_SIZE * UNIT_MM).toFixed(0)}mm</text>`,
  );
  parts.push("</svg>");
  return parts.join("\n");
}
