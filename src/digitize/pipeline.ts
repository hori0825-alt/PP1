// 画像 → 刺しゅうデータの変換パイプライン全体。
// 1. 減色 (quantize)  2. 輪郭抽出 (contour)  3. ステッチ生成 (fill/outline)
// 4. パターン組み立て (色ごとにジャンプ・色替えを挿入)

import { COLOR_CHANGE, END, JUMP, Pattern, STITCH } from "../embroidery/pattern";
import { nearestPecThread } from "../embroidery/pecThreads";
import { quantize, type QuantizeResult, type RasterImage } from "./quantize";
import { loopArea, simplifyLoop, traceContours, type Pt } from "./contour";
import { fillLoops, type FillOptions } from "./fill";
import { runningStitch, tripleRunningStitch } from "./outline";

export interface DigitizeOptions {
  /** 仕上がりサイズ: デザインの長辺 (mm)。PP1 の枠は 100x100mm */
  sizeMm: number;
  /** 最大色数 */
  maxColors: number;
  /** タタミ縫いの行間隔 (mm)。小さいほど密 */
  rowSpacingMm: number;
  /** 最大ステッチ長 (mm) */
  stitchLenMm: number;
  /** 縫い角度 (度) */
  angleDeg: number;
  /** 塗りつぶしを生成する */
  fill: boolean;
  /** 輪郭線を生成する */
  outline: boolean;
  /** 輪郭のステッチ長 (mm) */
  outlineStitchMm: number;
  /**
   * 3重ランニングステッチ: 往復3回で輪郭を縫い、より太く濃いラインにする
   * false の場合は 1重ランニング
   */
  tripleOutline: boolean;
  /**
   * 細い領域の自動サテン縫い。
   * true のとき: 推定幅 < satinMaxWidthMm の領域はサテン縫い、
   *              推定幅 < centerlineMaxWidthMm の領域はセンターライン縫いを選択する。
   */
  autoThinDetect: boolean;
  /**
   * この推定幅 (mm) 以下の領域をサテン縫いに切り替える。
   * 一般的な細線・文字の輪郭 は 3〜6mm、縁取りや帯状のデザインは 8mm 程度。
   */
  satinMaxWidthMm: number;
  /** サテン縫いの行間隔 (mm)。タタミより密にするのが一般的 */
  satinSpacingMm: number;
  /**
   * この推定幅 (mm) 以下の極細領域はセンターラインの 1重ランニングで縫う。
   * 0 を指定するとセンターライン自動判定を無効にする。
   */
  centerlineMaxWidthMm: number;
  /** 透明背景のしきい値 (0-255) */
  alphaThreshold: number;
  /** 画像端の均一色を背景として自動除去 */
  autoBackground: boolean;
  /** 背景色の許容差 */
  bgTolerance: number;
  /** これより小さい領域は無視 (mm^2) */
  minRegionMm2: number;
  /** パレット番号ごとの有効フラグ (省略時は全色) */
  enabledColors?: boolean[];
}

export const DEFAULT_OPTIONS: DigitizeOptions = {
  sizeMm: 90,
  maxColors: 6,
  rowSpacingMm: 0.4,
  stitchLenMm: 3.0,
  angleDeg: 45,
  fill: true,
  outline: true,
  outlineStitchMm: 2.0,
  tripleOutline: false,
  autoThinDetect: true,
  satinMaxWidthMm: 6.0,
  satinSpacingMm: 0.25,
  centerlineMaxWidthMm: 1.5,
  alphaThreshold: 128,
  autoBackground: true,
  bgTolerance: 40,
  minRegionMm2: 2,
};

export interface DigitizeStats {
  stitches: number;
  jumps: number;
  colors: number;
  widthMm: number;
  heightMm: number;
  /** 推定縫製時間 (分) ※400針/分換算 */
  estMinutes: number;
}

export interface DigitizeResult {
  pattern: Pattern;
  quant: QuantizeResult;
  /** 縫う順のパレット番号 */
  colorOrder: number[];
  stats: DigitizeStats;
}

/**
 * 領域の推定幅 (mm) を返す。
 * 油圧直径 (4A/P) の半値を "幅の代理指標" として使用する。
 * - 細い帯 (幅 w, 長さ L >> w): 油圧直径 ≈ 2w → 戻り値 ≈ w
 * - 円 (直径 d): 油圧直径 = d → 戻り値 ≈ d/2
 */
function estimateRegionWidthMm(loops: Pt[][]): number {
  let totalArea = 0;
  let totalPerimeter = 0;
  for (const loop of loops) {
    let a = 0;
    for (let i = 0; i < loop.length; i++) {
      const [x0, y0] = loop[i];
      const [x1, y1] = loop[(i + 1) % loop.length];
      a += x0 * y1 - x1 * y0;
      totalPerimeter += Math.hypot(x1 - x0, y1 - y0);
    }
    totalArea += Math.abs(a) / 2;
  }
  if (totalPerimeter < 1e-9) return Infinity;
  // 油圧直径 (単位: 0.1mm) → mm に変換し 2 で割る
  return (4 * totalArea) / totalPerimeter / 2 / 10;
}

export function digitize(img: RasterImage, options: Partial<DigitizeOptions> = {}): DigitizeResult {
  const o: DigitizeOptions = { ...DEFAULT_OPTIONS, ...options };
  const sizeUnits = Math.min(o.sizeMm, 100) * 10;

  const approxScale = sizeUnits / Math.max(img.width, img.height);
  const pxPerMm = 10 / approxScale;
  const minRegionPx = Math.max(1, Math.round(o.minRegionMm2 * pxPerMm * pxPerMm));

  const quant = quantize(img, {
    maxColors: o.maxColors,
    alphaThreshold: o.alphaThreshold,
    autoBackground: o.autoBackground,
    bgTolerance: o.bgTolerance,
    minRegionPx,
  });

  const pattern = new Pattern();

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < quant.height; y++) {
    for (let x = 0; x < quant.width; x++) {
      if (quant.labels[y * quant.width + x] < 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) {
    pattern.add(END, 0, 0);
    return {
      pattern,
      quant,
      colorOrder: [],
      stats: { stitches: 0, jumps: 0, colors: 0, widthMm: 0, heightMm: 0, estMinutes: 0 },
    };
  }

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const scale = sizeUnits / Math.max(bw, bh);
  const cx = (minX + maxX + 1) / 2;
  const cy = (minY + maxY + 1) / 2;
  const toUnits = ([x, y]: Pt): Pt => [(x - cx) * scale, (y - cy) * scale];

  const colorOrder: number[] = [];
  for (let c = 0; c < quant.palette.length; c++) {
    if (o.enabledColors && o.enabledColors[c] === false) continue;
    colorOrder.push(c);
  }

  const usedThreads = new Set<number>();
  let firstBlock = true;

  for (const c of colorOrder) {
    const pal = quant.palette[c];
    const thread = nearestPecThread(pal.r, pal.g, pal.b, usedThreads);
    usedThreads.add(thread.pecIndex);
    pattern.threads.push(thread);

    const minLoopAreaPx = Math.max(2, minRegionPx * 0.5);
    const rawLoops = traceContours(quant.labels, quant.width, quant.height, c);
    const loops: Pt[][] = [];
    for (const raw of rawLoops) {
      if (Math.abs(loopArea(raw)) < minLoopAreaPx) continue;
      const simplified = simplifyLoop(raw, 0.75);
      if (simplified.length >= 3) loops.push(simplified.map(toUnits));
    }
    if (loops.length === 0) {
      pattern.threads.pop();
      usedThreads.delete(thread.pecIndex);
      continue;
    }

    // 細さに応じた縫い方選択
    const widthMm = o.autoThinDetect ? estimateRegionWidthMm(loops) : Infinity;
    const fillMode = chooseFillMode(widthMm, o);

    const runs: Pt[][] = [];

    if (o.fill) {
      const fillOpts = buildFillOptions(fillMode, o);
      runs.push(...fillLoops(loops, fillOpts));
    }

    if (o.outline) {
      const stitchLen = o.outlineStitchMm * 10;
      for (const loop of loops) {
        const run = o.tripleOutline
          ? tripleRunningStitch(loop, stitchLen)
          : runningStitch(loop, stitchLen);
        if (run.length >= 2) runs.push(run);
      }
    }

    if (runs.length === 0) {
      pattern.threads.pop();
      usedThreads.delete(thread.pecIndex);
      continue;
    }

    if (!firstBlock) {
      const last = pattern.stitches[pattern.stitches.length - 1];
      pattern.add(COLOR_CHANGE, last.x, last.y);
    }
    firstBlock = false;

    for (const run of runs) {
      pattern.add(JUMP, run[0][0], run[0][1]);
      for (const [x, y] of run) pattern.add(STITCH, x, y);
    }
  }

  if (pattern.stitches.length > 0) {
    const last = pattern.stitches[pattern.stitches.length - 1];
    pattern.add(END, last.x, last.y);
  } else {
    pattern.add(END, 0, 0);
  }

  pattern.center();

  for (const s of pattern.stitches) {
    s.x = Math.round(s.x);
    s.y = Math.round(s.y);
  }

  const b = pattern.bounds();
  const stitches = pattern.countStitches();
  const stats: DigitizeStats = {
    stitches,
    jumps: pattern.countJumps(),
    colors: pattern.threads.length,
    widthMm: (b.maxX - b.minX) / 10,
    heightMm: (b.maxY - b.minY) / 10,
    estMinutes: Math.round((stitches / 400) * 10) / 10,
  };

  return { pattern, quant, colorOrder, stats };
}

type FillMode = "tatami" | "satin" | "centerline";

function chooseFillMode(widthMm: number, o: DigitizeOptions): FillMode {
  if (!o.autoThinDetect) return "tatami";
  if (o.centerlineMaxWidthMm > 0 && widthMm <= o.centerlineMaxWidthMm) return "centerline";
  if (widthMm <= o.satinMaxWidthMm) return "satin";
  return "tatami";
}

function buildFillOptions(mode: FillMode, o: DigitizeOptions): FillOptions {
  const angle = (o.angleDeg * Math.PI) / 180;
  if (mode === "satin") {
    return {
      spacing: o.satinSpacingMm * 10,
      stitchLen: o.stitchLenMm * 10,
      angle,
      mode: "satin",
      maxSatinLen: 120,
    };
  }
  if (mode === "centerline") {
    return {
      spacing: o.outlineStitchMm * 10,
      stitchLen: o.outlineStitchMm * 10,
      angle,
      mode: "centerline",
    };
  }
  return {
    spacing: o.rowSpacingMm * 10,
    stitchLen: o.stitchLenMm * 10,
    angle,
    mode: "tatami",
  };
}
