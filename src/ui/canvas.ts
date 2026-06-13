// キャンバス描画。100mm 枠・グリッド・各表示モード・開始/終了点マーカー・
// シミュレーター再生位置を描く。座標変換 (内部単位 ↔ 画面) も管理する。

import { HOOP_HALF, HOOP_SIZE, UNIT_MM, mm } from "../core/constants";
import { fitUnitsPerPixel } from "../import/regions";
import type { AppState } from "./state";

export interface Viewport {
  /** 画面ピクセル/内部単位 */
  scale: number;
  /** パン (画面ピクセル) */
  panX: number;
  panY: number;
}

export function createViewport(): Viewport {
  return { scale: 0, panX: 0, panY: 0 };
}

function toScreen(v: Viewport, canvas: HTMLCanvasElement, x: number, y: number): [number, number] {
  return [canvas.width / 2 + x * v.scale + v.panX, canvas.height / 2 + y * v.scale + v.panY];
}

export function screenToDesign(
  v: Viewport,
  canvas: HTMLCanvasElement,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return {
    x: (sx - canvas.width / 2 - v.panX) / v.scale,
    y: (sy - canvas.height / 2 - v.panY) / v.scale,
  };
}

export function fitViewport(v: Viewport, canvas: HTMLCanvasElement): void {
  v.scale = canvas.width / (HOOP_SIZE * 1.12);
  v.panX = 0;
  v.panY = 0;
}

function drawHoopAndGrid(ctx: CanvasRenderingContext2D, v: Viewport, canvas: HTMLCanvasElement): void {
  ctx.fillStyle = "#fafbfc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 10mm グリッド
  ctx.strokeStyle = "#edf0f3";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let g = -HOOP_HALF; g <= HOOP_HALF; g += mm(10)) {
    const [x1, y1] = toScreen(v, canvas, g, -HOOP_HALF);
    const [x2, y2] = toScreen(v, canvas, g, HOOP_HALF);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    const [x3, y3] = toScreen(v, canvas, -HOOP_HALF, g);
    const [x4, y4] = toScreen(v, canvas, HOOP_HALF, g);
    ctx.moveTo(x3, y3);
    ctx.lineTo(x4, y4);
  }
  ctx.stroke();

  // 100mm 枠
  ctx.strokeStyle = "#aeb8c2";
  ctx.lineWidth = 1.5;
  const [bx, by] = toScreen(v, canvas, -HOOP_HALF, -HOOP_HALF);
  ctx.strokeRect(bx, by, HOOP_SIZE * v.scale, HOOP_SIZE * v.scale);
}

function drawImageView(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  canvas: HTMLCanvasElement,
  state: AppState,
): void {
  const img = state.raster;
  if (!img) return;
  const upp = fitUnitsPerPixel(img.width, img.height, mm(state.project.settings.targetSizeMm));
  const tmp = document.createElement("canvas");
  tmp.width = img.width;
  tmp.height = img.height;
  const tctx = tmp.getContext("2d");
  if (!tctx) return;
  const out = tctx.createImageData(img.width, img.height);
  if (state.view === "original" || !state.labelMap) {
    out.data.set(img.data);
  } else {
    const lm = state.labelMap;
    for (let i = 0; i < lm.labels.length; i++) {
      const lbl = lm.labels[i];
      if (lbl === -1) {
        out.data[i * 4 + 3] = 0;
      } else {
        const c = lm.palette[lbl];
        out.data[i * 4] = c.r;
        out.data[i * 4 + 1] = c.g;
        out.data[i * 4 + 2] = c.b;
        out.data[i * 4 + 3] = 255;
      }
    }
  }
  tctx.putImageData(out, 0, 0);
  const dw = img.width * upp * v.scale;
  const dh = img.height * upp * v.scale;
  const [cx, cy] = toScreen(v, canvas, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, cx - dw / 2, cy - dh / 2, dw, dh);
}

function drawVectorView(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  canvas: HTMLCanvasElement,
  state: AppState,
): void {
  for (const region of state.regions) {
    const path = new Path2D();
    const trace = (pts: { x: number; y: number }[]): void => {
      pts.forEach((p, i) => {
        const [x, y] = toScreen(v, canvas, p.x, p.y);
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      path.closePath();
    };
    trace(region.outer);
    for (const hole of region.holes) trace(hole);
    ctx.fillStyle = `rgba(${region.color.r},${region.color.g},${region.color.b},0.82)`;
    ctx.fill(path, "evenodd");
    ctx.strokeStyle = region.selfIntersecting ? "#e02020" : "#00000033";
    ctx.lineWidth = region.selfIntersecting ? 2 : 0.7;
    ctx.stroke(path);
  }
}

function drawStitchView(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  canvas: HTMLCanvasElement,
  state: AppState,
): void {
  if (!state.plan) return;
  // シミュレーション中は simFrame までだけ描く
  const sim = state.simulation;
  const limit = sim ? state.simFrame : Infinity;
  let frameCount = 0;
  let prevEnd: { x: number; y: number } | null = null;

  for (const block of state.plan.blocks) {
    const color = `rgb(${block.thread.r},${block.thread.g},${block.thread.b})`;
    for (const run of block.runs) {
      if (run.stitches.length === 0) continue;
      const hidden = run.objectId !== undefined && state.hiddenObjectIds.has(run.objectId);
      if (hidden) {
        prevEnd = run.stitches[run.stitches.length - 1];
        continue;
      }
      // 渡り糸 (前 Run 終点 → この Run 始点)
      if (prevEnd) {
        ctx.strokeStyle = run.connection === "trim" ? "#d04545aa" : "#9aa4adaa";
        ctx.setLineDash(run.connection === "trim" ? [2, 4] : [3, 3]);
        ctx.beginPath();
        const [px, py] = toScreen(v, canvas, prevEnd.x, prevEnd.y);
        const [sx, sy] = toScreen(v, canvas, run.stitches[0].x, run.stitches[0].y);
        ctx.moveTo(px, py);
        ctx.lineTo(sx, sy);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // 本体
      const selected = run.objectId !== undefined && run.objectId === state.selectedObjectId;
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 1.6 : 0.7;
      ctx.beginPath();
      let started = false;
      for (const p of run.stitches) {
        if (frameCount >= limit) break;
        frameCount++;
        const [x, y] = toScreen(v, canvas, p.x, p.y);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      prevEnd = run.stitches[run.stitches.length - 1];
      if (frameCount >= limit) {
        drawNeedle(ctx, v, canvas, prevEnd);
        return;
      }
    }
  }
}

function drawNeedle(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  canvas: HTMLCanvasElement,
  p: { x: number; y: number },
): void {
  const [x, y] = toScreen(v, canvas, p.x, p.y);
  ctx.fillStyle = "#1a1a1a";
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** 選択オブジェクトの開始(▶)・終了(■)点マーカー */
function drawStartEndMarkers(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  canvas: HTMLCanvasElement,
  state: AppState,
): void {
  if (state.selectedObjectId === null || !state.plan) return;
  const runs = state.plan.blocks
    .flatMap((b) => b.runs)
    .filter((r) => r.objectId === state.selectedObjectId && r.stitches.length > 0);
  if (runs.length === 0) return;
  const start = runs[0].stitches[0];
  const end = runs[runs.length - 1].stitches[runs[runs.length - 1].stitches.length - 1];

  const [sx, sy] = toScreen(v, canvas, start.x, start.y);
  ctx.fillStyle = "#1f9d4d";
  ctx.beginPath();
  ctx.moveTo(sx - 5, sy - 5);
  ctx.lineTo(sx + 6, sy);
  ctx.lineTo(sx - 5, sy + 5);
  ctx.closePath();
  ctx.fill();

  const [ex, ey] = toScreen(v, canvas, end.x, end.y);
  ctx.fillStyle = "#d04545";
  ctx.fillRect(ex - 4, ey - 4, 8, 8);
}

export function renderCanvas(canvas: HTMLCanvasElement, v: Viewport, state: AppState): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (v.scale === 0) fitViewport(v, canvas);
  drawHoopAndGrid(ctx, v, canvas);

  if (state.view === "original" || state.view === "quantized") {
    if (state.raster) drawImageView(ctx, v, canvas, state);
    else drawVectorView(ctx, v, canvas, state);
  } else if (state.view === "vector") {
    drawVectorView(ctx, v, canvas, state);
  } else {
    drawStitchView(ctx, v, canvas, state);
    drawStartEndMarkers(ctx, v, canvas, state);
  }

  // 実寸ラベル (左下)
  ctx.fillStyle = "#8a939e";
  ctx.font = "11px system-ui";
  ctx.fillText(`100mm 枠 / 1マス ${(mm(10) * UNIT_MM).toFixed(0)}mm`, 8, canvas.height - 8);
}
