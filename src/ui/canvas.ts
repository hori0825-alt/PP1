// キャンバス描画。100mm 枠・グリッド・各表示モード・開始/終了点マーカー・
// シミュレーター再生位置を描く。座標変換 (内部単位 ↔ 画面) も管理する。

import { HOOP_HALF, HOOP_SIZE, UNIT_MM, mm } from "../core/constants";
import { polygonCentroid } from "../core/geometry";
import { fitUnitsPerPixel } from "../import/regions";
import { findObject } from "./state";
import type { AppState } from "./state";

/** 方向ハンドルの“つまみ”の画面半径 (ヒット判定に使う) */
export const DIR_HANDLE_RADIUS = 8;

/**
 * 選択パーツの中心と、方向ハンドルのつまみ位置 (設計座標) を返す。
 * 角度線をドラッグして向きを引くための当たり判定に使う。
 */
export function directionHandleGeometry(
  state: AppState,
): { center: { x: number; y: number }; knob: { x: number; y: number }; angleDeg: number } | null {
  const idx = state.selectedRegionIndex;
  if (idx === null || !state.regions[idx]) return null;
  const region = state.regions[idx];
  const center = polygonCentroid(region.outer);
  const angleDeg = region.angleDeg ?? state.project.settings.angleDeg;
  const rad = (angleDeg * Math.PI) / 180;
  // パーツの大きさに応じてハンドル長を決める
  const len = Math.max(mm(8), regionHalfSpan(region) * 0.9);
  const knob = { x: center.x + Math.cos(rad) * len, y: center.y + Math.sin(rad) * len };
  return { center, knob, angleDeg };
}

function regionHalfSpan(region: { outer: { x: number; y: number }[] }): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of region.outer) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return Math.max(maxX - minX, maxY - minY) / 2;
}

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

/** 設計座標 → 画面座標 (ベクター編集オーバーレイ用) */
export function designToScreen(
  v: Viewport,
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
): [number, number] {
  return toScreen(v, canvas, x, y);
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
  state.regions.forEach((region, idx) => {
    const selected = idx === state.selectedRegionIndex;
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
    ctx.fillStyle = `rgba(${region.color.r},${region.color.g},${region.color.b},${selected ? 0.95 : 0.82})`;
    ctx.fill(path, "evenodd");
    ctx.strokeStyle = selected ? "#1a7fe8" : region.selfIntersecting ? "#e02020" : "#00000033";
    ctx.lineWidth = selected ? 2.5 : region.selfIntersecting ? 2 : 0.7;
    ctx.stroke(path);
  });
  drawExcludedRegions(ctx, v, canvas, state);
}

/** 面積不足で除外された小領域をオレンジ破線で描く (復元可能であることを示す) */
function drawExcludedRegions(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  canvas: HTMLCanvasElement,
  state: AppState,
): void {
  if (state.excludedRegions.length === 0) return;
  for (const ex of state.excludedRegions) {
    const path = new Path2D();
    ex.outer.forEach((p, i) => {
      const [x, y] = toScreen(v, canvas, p.x, p.y);
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    path.closePath();
    ctx.fillStyle = `rgba(${ex.color.r},${ex.color.g},${ex.color.b},0.25)`;
    ctx.fill(path);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "#e8832a";
    ctx.lineWidth = 1.5;
    ctx.stroke(path);
    ctx.setLineDash([]);
  }
}

/** 選択パーツのステッチ方向線とドラッグ用つまみ (ベクタービュー) */
function drawDirectionIndicator(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  canvas: HTMLCanvasElement,
  state: AppState,
): void {
  const geo = directionHandleGeometry(state);
  if (!geo) return;
  const [cx, cy] = toScreen(v, canvas, geo.center.x, geo.center.y);
  const [kx, ky] = toScreen(v, canvas, geo.knob.x, geo.knob.y);
  // 中心を通る両方向の方向線 (縫い目の向き)
  ctx.strokeStyle = "#1a7fe8";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(cx - (kx - cx), cy - (ky - cy));
  ctx.lineTo(kx, ky);
  ctx.stroke();
  ctx.setLineDash([]);
  // 中心の点
  ctx.fillStyle = "#1a7fe8";
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
  // ドラッグ用つまみ
  ctx.beginPath();
  ctx.arc(kx, ky, DIR_HANDLE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#1a7fe8";
  ctx.stroke();
  // 角度ラベル
  ctx.fillStyle = "#1a7fe8";
  ctx.font = "11px system-ui";
  ctx.fillText(`${Math.round(geo.angleDeg)}°`, kx + 10, ky - 6);
}

/** 選択パーツの方向線 (ターニング) を緑の矢印で描く */
function drawAngleLines(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  canvas: HTMLCanvasElement,
  state: AppState,
): void {
  const idx = state.selectedRegionIndex;
  if (idx === null) return;
  const lines = state.regions[idx]?.angleLines;
  if (!lines || lines.length === 0) return;
  ctx.strokeStyle = "#13a35b";
  ctx.fillStyle = "#13a35b";
  ctx.lineWidth = 2.5;
  for (const l of lines) {
    const [ax, ay] = toScreen(v, canvas, l.a.x, l.a.y);
    const [bx, by] = toScreen(v, canvas, l.b.x, l.b.y);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    // 終点に矢じり
    const ang = Math.atan2(by - ay, bx - ax);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - 9 * Math.cos(ang - 0.4), by - 9 * Math.sin(ang - 0.4));
    ctx.lineTo(bx - 9 * Math.cos(ang + 0.4), by - 9 * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
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
  const highlight = state.highlightUnderlay;
  let frameCount = 0;
  let prevEnd: { x: number; y: number } | null = null;

  for (const block of state.plan.blocks) {
    const color = `rgb(${block.thread.r},${block.thread.g},${block.thread.b})`;
    // 下縫い強調時は本縫いを淡く描いて下縫い (テール色) を目立たせる
    const topColor = highlight
      ? `rgba(${block.thread.r},${block.thread.g},${block.thread.b},0.22)`
      : color;
    for (const run of block.runs) {
      if (run.stitches.length === 0) continue;
      const hidden = run.objectId !== undefined && state.hiddenObjectIds.has(run.objectId);
      if (hidden) {
        prevEnd = run.stitches[run.stitches.length - 1];
        continue;
      }
      const isUnderlay = run.stitchType === "underlay";
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
      if (highlight && isUnderlay) {
        ctx.strokeStyle = "#0bb3b3"; // 下縫い: テール色で強調
        ctx.lineWidth = 1.0;
      } else {
        ctx.strokeStyle = highlight ? topColor : color;
        ctx.lineWidth = selected ? 1.6 : 0.7;
      }
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

/** 針編集オーバーレイ: 編集対象オブジェクトの各針を編集ハンドルとして描く */
function drawStitchEditOverlay(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  canvas: HTMLCanvasElement,
  state: AppState,
): void {
  const se = state.stitchEdit;
  if (!se) return;
  const obj = findObject(state, se.objectId);
  if (!obj?.baked) return;
  obj.baked.forEach((run, ri) => {
    run.stitches.forEach((p, i) => {
      const [x, y] = toScreen(v, canvas, p.x, p.y);
      const sel = se.sel?.run === ri && se.sel?.idx === i;
      ctx.beginPath();
      ctx.arc(x, y, sel ? 5 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = sel ? "#e8632a" : "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#e8632a";
      ctx.lineWidth = sel ? 2 : 1;
      ctx.stroke();
    });
  });
}

/** 針編集: クリック位置に最も近い針 (run, idx) を画面距離 tol(px) 以内で探す */
export function pickBakedStitch(
  v: Viewport,
  canvas: HTMLCanvasElement,
  state: AppState,
  sx: number,
  sy: number,
  tol = 8,
): { run: number; idx: number } | null {
  const se = state.stitchEdit;
  if (!se) return null;
  const obj = findObject(state, se.objectId);
  if (!obj?.baked) return null;
  let best: { run: number; idx: number } | null = null;
  let bestD = tol;
  obj.baked.forEach((run, ri) => {
    run.stitches.forEach((p, i) => {
      const [x, y] = toScreen(v, canvas, p.x, p.y);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bestD) {
        bestD = d;
        best = { run: ri, idx: i };
      }
    });
  });
  return best;
}

/** 針編集: クリック位置に最も近い線分の (run, afterIdx) を返す (追加位置決め用) */
export function nearestBakedSegment(
  state: AppState,
  p: { x: number; y: number },
): { run: number; afterIdx: number } | null {
  const se = state.stitchEdit;
  if (!se) return null;
  const obj = findObject(state, se.objectId);
  if (!obj?.baked) return null;
  let best: { run: number; afterIdx: number } | null = null;
  let bestD = Infinity;
  obj.baked.forEach((run, ri) => {
    for (let i = 0; i + 1 < run.stitches.length; i++) {
      const a = run.stitches[i];
      const b = run.stitches[i + 1];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const d = Math.hypot(mx - p.x, my - p.y);
      if (d < bestD) {
        bestD = d;
        best = { run: ri, afterIdx: i };
      }
    }
  });
  return best;
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
    drawAngleLines(ctx, v, canvas, state);
    drawDirectionIndicator(ctx, v, canvas, state);
  } else {
    drawStitchView(ctx, v, canvas, state);
    drawStartEndMarkers(ctx, v, canvas, state);
    drawStitchEditOverlay(ctx, v, canvas, state);
  }

  if (state.penDraw) drawPenOverlay(ctx, v, canvas, state);

  // 実寸ラベル (左下)
  ctx.fillStyle = "#8a939e";
  ctx.font = "11px system-ui";
  ctx.fillText(`100mm 枠 / 1マス ${(mm(10) * UNIT_MM).toFixed(0)}mm`, 8, canvas.height - 8);
}

/** 手動デジタイズ (ペン作図) の途中経過を描く */
function drawPenOverlay(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  canvas: HTMLCanvasElement,
  state: AppState,
): void {
  const pd = state.penDraw;
  if (!pd || pd.points.length === 0) return;
  const pts = pd.points.map((p) => toScreen(v, canvas, p.x, p.y));
  ctx.strokeStyle = "#7b2ff7";
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.stroke();
  // 面は始点へ閉じる線を点線で予告
  if (pd.kind === "fill" && pts.length >= 2) {
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    ctx.lineTo(pts[0][0], pts[0][1]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // 各点
  pts.forEach(([x, y], i) => {
    ctx.beginPath();
    ctx.arc(x, y, i === 0 ? 5 : 3.2, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? "#7b2ff7" : "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#7b2ff7";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
}
