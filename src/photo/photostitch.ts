// PhotoStitch (写真刺繍)。DOM 非依存・テスト可能。
//
// 設計の核心 (前作「点描で糸切り爆発」の回避):
//   点を独立に打たず、密度変調した走査線で表現する。
//   - 画像をグレースケール化 + コントラスト調整
//   - 行 (rowSpacing 間隔) ごとに左右交互 (ボストロフェドン) に進む
//   - 暗い画素ほどステッチ間隔を詰め (密)、明るいほど広げ (疎)、
//     白に近い画素は縫わない (ハイライトは地のまま)
//   - 行内の連続区間が1本の StitchRun になり、区間内に糸切りは入らない
//   - 少数色は輝度バンドで分解 (暗→濃い糸、明→薄い糸)
//
// 針数は行間隔とステッチ長で決まる。12,000 針を超える場合は
// 行間隔を自動で広げて収める (PP1 への転送可能性を最優先)。

import { MAX_STITCH_COUNT, mm } from "../core/constants";
import { decideConnection } from "../plan/connect";
import type { ColorBlock, Point, StitchPlan, StitchRun, ThreadColor } from "../core/types";
import { backgroundMask } from "../import/raster";
import type { RasterImage } from "../import/raster";

export interface PhotoStitchOptions {
  /** 仕上がりサイズ (mm)。最大辺をこれに合わせる */
  targetSizeMm: number;
  /** 色数 (1〜4)。1=モノクロ、2以上=輝度バンドで色分解 */
  colorCount: number;
  /** コントラスト (1=標準, >1 で強調) */
  contrast: number;
  /** 明るさ補正 (-1〜1) */
  brightness: number;
  /** 白背景を除去するか */
  removeBackground: boolean;
  /** 行間隔 (mm)。省略時は針数上限から自動決定 */
  rowSpacingMm?: number;
  /** 最暗部のステッチ長 (mm) */
  minStitchMm?: number;
  /** 最明部のステッチ長 (mm) */
  maxStitchMm?: number;
  /** これより明るい画素は縫わない (0..1) */
  whiteThreshold?: number;
  /** 針数上限 (デフォルト 12,000) */
  maxStitches?: number;
}

export interface PhotoStitchResult {
  plan: StitchPlan;
  stitchCount: number;
  /** 自動調整後の行間隔 (mm) */
  rowSpacingMm: number;
  warnings: string[];
}

interface LumGrid {
  width: number;
  height: number;
  /** 0(黒)..1(白)。マスク外は 1 (白=縫わない) */
  lum: Float32Array;
  /** 1=被写体内 */
  inside: Uint8Array;
}

/** グレースケール化 + コントラスト/明るさ + 背景マスク */
export function toLuminanceGrid(img: RasterImage, options: PhotoStitchOptions): LumGrid {
  const { width: w, height: h, data } = img;
  const bg = backgroundMask(img, options.removeBackground);
  const lum = new Float32Array(w * h);
  const inside = new Uint8Array(w * h);
  const c = options.contrast;
  const b = options.brightness;
  for (let i = 0; i < w * h; i++) {
    if (bg[i]) {
      lum[i] = 1;
      continue;
    }
    inside[i] = 1;
    let l = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
    l = (l - 0.5) * c + 0.5 + b;
    lum[i] = Math.max(0, Math.min(1, l));
  }
  return { width: w, height: h, lum, inside };
}

/** 輝度バンド境界 (色分解用)。darkest..lightest の順に [lo,hi) を返す */
function luminanceBands(colorCount: number, whiteThreshold: number): { lo: number; hi: number; color: ThreadColor }[] {
  const n = Math.max(1, Math.min(4, colorCount));
  const bands: { lo: number; hi: number; color: ThreadColor }[] = [];
  for (let i = 0; i < n; i++) {
    const lo = (whiteThreshold * i) / n;
    const hi = (whiteThreshold * (i + 1)) / n;
    // 帯の中央輝度をグレーの糸色に (暗→濃い, 明→薄い)
    const mid = (lo + hi) / 2;
    const g = Math.round(mid * 200); // 0..200 (純白は使わない)
    bands.push({ lo, hi, color: { r: g, g, b: g, name: `Gray ${g}` } });
  }
  return bands;
}

/** 1バンド分の走査線ステッチを生成する */
function scanBand(
  grid: LumGrid,
  band: { lo: number; hi: number },
  upp: number,
  rowSpacingPx: number,
  minStepPx: number,
  maxStepPx: number,
  whiteThreshold: number,
): StitchRun[] {
  const { width: w, height: h, lum, inside } = grid;
  const toInternal = (px: number, py: number): Point => ({
    x: Math.round((px - w / 2) * upp),
    y: Math.round((py - h / 2) * upp),
  });
  const inBand = (i: number): boolean =>
    inside[i] === 1 && lum[i] >= band.lo && lum[i] < band.hi && lum[i] < whiteThreshold;

  const runs: StitchRun[] = [];
  let rowIndex = 0;
  for (let yPx = rowSpacingPx / 2; yPx < h; yPx += rowSpacingPx, rowIndex++) {
    const y = Math.floor(yPx);
    const leftToRight = rowIndex % 2 === 0;
    // 行内のバンド該当区間を求める
    const segments: [number, number][] = [];
    let segStart = -1;
    for (let x = 0; x < w; x++) {
      const ok = inBand(y * w + x);
      if (ok && segStart < 0) segStart = x;
      else if (!ok && segStart >= 0) {
        segments.push([segStart, x - 1]);
        segStart = -1;
      }
    }
    if (segStart >= 0) segments.push([segStart, w - 1]);

    for (const [a, bx] of segments) {
      const stitches: Point[] = [];
      const place = (px: number): void => {
        stitches.push(toInternal(px, y));
      };
      if (leftToRight) {
        let x = a;
        place(x);
        while (x < bx) {
          const l = lum[y * w + Math.floor(x)];
          const step = minStepPx + (maxStepPx - minStepPx) * Math.max(0, Math.min(1, l));
          x = Math.min(bx, x + step);
          place(x);
        }
      } else {
        let x = bx;
        place(x);
        while (x > a) {
          const l = lum[y * w + Math.floor(x)];
          const step = minStepPx + (maxStepPx - minStepPx) * Math.max(0, Math.min(1, l));
          x = Math.max(a, x - step);
          place(x);
        }
      }
      if (stitches.length >= 2) runs.push({ stitches, connection: "trim", stitchType: "running" });
    }
  }
  return runs;
}

/** Run 列に接続属性を設定する (同色内なので糸切りは遠距離のみ) */
function connectRuns(runs: StitchRun[]): StitchRun[] {
  let prev: Point | null = null;
  return runs.map((run) => {
    const conn = decideConnection(prev, run.stitches[0], false, { trimMode: "auto" });
    prev = run.stitches[run.stitches.length - 1];
    return { ...run, connection: conn };
  });
}

function generateOnce(
  grid: LumGrid,
  options: Required<Pick<PhotoStitchOptions, "colorCount" | "whiteThreshold">> & {
    upp: number;
    rowSpacingPx: number;
    minStepPx: number;
    maxStepPx: number;
  },
): ColorBlock[] {
  const bands = luminanceBands(options.colorCount, options.whiteThreshold);
  const blocks: ColorBlock[] = [];
  for (const band of bands) {
    const runs = connectRuns(
      scanBand(grid, band, options.upp, options.rowSpacingPx, options.minStepPx, options.maxStepPx, options.whiteThreshold),
    );
    if (runs.length > 0) blocks.push({ thread: band.color, runs });
  }
  return blocks;
}

function countStitches(blocks: ColorBlock[]): number {
  let n = 0;
  for (const b of blocks) for (const r of b.runs) n += r.stitches.length;
  return n;
}

/**
 * 写真を PhotoStitch の StitchPlan に変換する。
 * 針数が上限を超える場合は行間隔を段階的に広げて収める。
 */
export function generatePhotoStitch(
  img: RasterImage,
  name: string,
  options: PhotoStitchOptions,
): PhotoStitchResult {
  const warnings: string[] = [];
  const grid = toLuminanceGrid(img, options);
  const targetUnits = mm(options.targetSizeMm);
  const upp = targetUnits / Math.max(img.width, img.height);
  const maxStitches = options.maxStitches ?? MAX_STITCH_COUNT;
  const whiteThreshold = options.whiteThreshold ?? 0.92;
  const minStepPx = mm(options.minStitchMm ?? 1.6) / upp;
  const maxStepPx = mm(options.maxStitchMm ?? 4.0) / upp;

  let rowSpacingMm = options.rowSpacingMm ?? 1.6;
  let blocks: ColorBlock[] = [];
  let count = 0;

  // 針数上限に収まるまで行間隔を広げる (最大 12 回)
  for (let iter = 0; iter < 12; iter++) {
    const rowSpacingPx = mm(rowSpacingMm) / upp;
    blocks = generateOnce(grid, {
      colorCount: options.colorCount,
      whiteThreshold,
      upp,
      rowSpacingPx,
      minStepPx,
      maxStepPx,
    });
    count = countStitches(blocks);
    if (count <= maxStitches) break;
    rowSpacingMm *= 1.2;
    if (iter === 11) {
      warnings.push(`針数が上限 ${maxStitches} を超えています。サイズ縮小か色数削減を検討してください`);
    }
  }

  if (count === 0) {
    warnings.push("縫う領域がありません (コントラストや背景除去を調整してください)");
  }
  if (rowSpacingMm > (options.rowSpacingMm ?? 1.6) * 1.01) {
    warnings.push(`針数制限のため行間隔を ${rowSpacingMm.toFixed(1)}mm に自動調整しました`);
  }

  return {
    plan: { name, blocks },
    stitchCount: count,
    rowSpacingMm,
    warnings,
  };
}
