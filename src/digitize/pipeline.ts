// 画像 → 刺しゅうデータの変換パイプライン全体。
// 1. 減色 (quantize)  2. 輪郭抽出 (contour)  3. ステッチ生成 (fill/outline)
// 4. パターン組み立て (色ごとにジャンプ・色替えを挿入)

import { COLOR_CHANGE, END, JUMP, Pattern, STITCH } from "../embroidery/pattern";
import { nearestPecThread } from "../embroidery/pecThreads";
import { quantize, type QuantizeResult, type RasterImage } from "./quantize";
import { loopArea, simplifyLoop, traceContours, type Pt } from "./contour";
import { fillLoops } from "./fill";
import { runningStitch } from "./outline";

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
  /** 輪郭線 (ランニングステッチ) を生成する */
  outline: boolean;
  /** 輪郭のステッチ長 (mm) */
  outlineStitchMm: number;
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

export function digitize(img: RasterImage, options: Partial<DigitizeOptions> = {}): DigitizeResult {
  const o: DigitizeOptions = { ...DEFAULT_OPTIONS, ...options };
  const sizeUnits = Math.min(o.sizeMm, 100) * 10; // 0.1mm 単位, 100mm 枠上限

  // ピクセル→単位の概算スケール (minRegion 判定用)
  const approxScale = sizeUnits / Math.max(img.width, img.height); // units/px
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

  // 前景バウンディングボックス
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
  const scale = sizeUnits / Math.max(bw, bh); // units/px
  const cx = (minX + maxX + 1) / 2;
  const cy = (minY + maxY + 1) / 2;
  const toUnits = ([x, y]: Pt): Pt => [(x - cx) * scale, (y - cy) * scale];

  // 色順: 面積の大きい順 (palette は面積降順に並んでいる)
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

    // 輪郭抽出 → 簡略化 → 単位変換
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

    const runs: Pt[][] = [];
    if (o.fill) {
      runs.push(
        ...fillLoops(loops, {
          spacing: o.rowSpacingMm * 10,
          stitchLen: o.stitchLenMm * 10,
          angle: (o.angleDeg * Math.PI) / 180,
        }),
      );
    }
    if (o.outline) {
      for (const loop of loops) {
        const run = runningStitch(loop, o.outlineStitchMm * 10);
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

  // 座標を整数に丸める (機械単位)
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
