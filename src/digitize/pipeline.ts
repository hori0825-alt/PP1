// 画像 → 刺しゅうデータの変換パイプライン全体。
// 1. 減色 (quantize)  2. 輪郭抽出 (contour)  3. 領域単位の縫いモード判定
// 4. ステッチ生成 (fill/outline)  5. パターン組み立て

import { COLOR_CHANGE, END, JUMP, Pattern, STITCH, TRIM } from "../embroidery/pattern";
import { nearestPecThread } from "../embroidery/pecThreads";
import { quantize, type QuantizeResult, type RasterImage } from "./quantize";
import { loopArea, simplifyLoop, smoothLoop, traceContours, type Pt } from "./contour";
import { fillLoops, type FillOptions } from "./fill";
import { runningStitch, tripleRunningStitch } from "./outline";
import {
  distanceTransform,
  resamplePath,
  routeSkeleton,
  skeletonGraph,
  smoothPolyline,
  stitchRoute,
  thinMask,
  type Px,
} from "./skeleton";

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
  /** 3重ランニングステッチ: 往復3回で輪郭を太く濃いラインにする */
  tripleOutline: boolean;
  /**
   * 細い領域の自動判定。領域 (外周+穴のまとまり) ごとに推定幅を計算し、
   * 幅 <= satinMaxWidthMm ならサテン縫い、
   * 幅 <= centerlineMaxWidthMm ならセンターライン縫いを選択する。
   */
  autoThinDetect: boolean;
  /** この推定幅 (mm) 以下の領域をサテン縫いに切り替える */
  satinMaxWidthMm: number;
  /** サテン縫いの行間隔 (mm) */
  satinSpacingMm: number;
  /** この推定幅 (mm) 以下の極細領域はセンターラインで縫う。0 で無効 */
  centerlineMaxWidthMm: number;
  /** 透明背景のしきい値 (0-255) */
  alphaThreshold: number;
  /** 画像端の均一色を背景として自動除去 */
  autoBackground: boolean;
  /** 背景色の許容差 */
  bgTolerance: number;
  /** これより小さい領域は無視 (mm^2)。細長い線状領域は対象外 */
  minRegionMm2: number;
  /**
   * 糸切りを減らす。同色内の移動が maxConnectMm 以下なら糸を切らず
   * つなぎ縫い (渡り縫い) で接続する
   */
  reduceTrims: boolean;
  /** 同色内でつなぎ縫いにする最大移動距離 (mm)。これを超えると糸切り+ジャンプ */
  maxConnectMm: number;
  /** アウトラインの平滑化強度 (0=なし 1=弱 2=標準 3=強) */
  outlineSmoothing: number;
  /** パレット番号ごとの有効フラグ (省略時は全色) */
  enabledColors?: boolean[];
  /**
   * 縫わない (抜き) 領域の指定。処理画像のピクセル座標で、
   * 各点が属する連結領域を縫い対象から除外する。
   */
  excludePoints?: [number, number][];
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
  minRegionMm2: 1,
  reduceTrims: true,
  maxConnectMm: 50,
  outlineSmoothing: 2,
};

export interface DigitizeStats {
  stitches: number;
  jumps: number;
  /** 糸切り回数 (色替えによる糸切りは含まない) */
  trims: number;
  /** 色替え回数 */
  colorChanges: number;
  colors: number;
  widthMm: number;
  heightMm: number;
  /** 推定縫製時間 (分) ※400針/分換算 */
  estMinutes: number;
}

/**
 * 処理画像ピクセル座標 ⇔ パターン座標 (0.1mm) の変換。
 * パターン座標 = (px - cx) * scale + offset
 */
export interface ViewTransform {
  scale: number;
  cx: number;
  cy: number;
  offsetX: number;
  offsetY: number;
}

export interface DigitizeResult {
  pattern: Pattern;
  quant: QuantizeResult;
  /** 縫う順のパレット番号 */
  colorOrder: number[];
  stats: DigitizeStats;
  view: ViewTransform;
  /** 抜き指定された領域のマスク (1=除外)。指定がなければ null */
  excludedMask: Uint8Array | null;
}

export interface LimitedDigitizeResult extends DigitizeResult {
  /** 針数上限による自動調整後のパラメータ (調整なしなら null) */
  autoAdjusted: {
    rowSpacingMm: number;
    satinSpacingMm: number;
    stitchLenMm: number;
  } | null;
  /** 密度を上限まで下げても針数上限を満たせなかった場合 true */
  overLimit: boolean;
}

// 自動調整の上限値 (これ以上密度を下げると刺しゅうとして成立しない)
const MAX_ROW_SPACING_MM = 1.2;
const MAX_SATIN_SPACING_MM = 0.6;
const MAX_STITCH_LEN_MM = 6.0;

/**
 * 針数上限つきの変換。maxStitches を超える場合は縫い密度
 * (タタミ行間隔 → サテン行間隔 → 最大ステッチ長) を段階的に
 * 緩めて再生成し、上限以下に収める。maxStitches=0 で無制限。
 */
export function digitizeWithLimit(
  img: RasterImage,
  options: Partial<DigitizeOptions> = {},
  maxStitches = 0,
): LimitedDigitizeResult {
  let o: DigitizeOptions = { ...DEFAULT_OPTIONS, ...options };
  let res = digitize(img, o);
  if (maxStitches <= 0 || res.stats.stitches <= maxStitches) {
    return { ...res, autoAdjusted: null, overLimit: false };
  }

  let adjusted = false;
  for (let iter = 0; iter < 6 && res.stats.stitches > maxStitches; iter++) {
    // 超過率ぶん行間隔を広げる (輪郭など密度に依らない針数があるため少し多めに)
    const ratio = (res.stats.stitches / maxStitches) * 1.05;
    const nextRow = Math.min(MAX_ROW_SPACING_MM, o.rowSpacingMm * ratio);
    const nextSatin = Math.min(MAX_SATIN_SPACING_MM, o.satinSpacingMm * ratio);
    let nextStitchLen = o.stitchLenMm;
    const rowCapped = nextRow === o.rowSpacingMm && nextSatin === o.satinSpacingMm;
    if (rowCapped) {
      // 行間隔が上限に達していたらステッチ長を伸ばして針数を減らす
      nextStitchLen = Math.min(MAX_STITCH_LEN_MM, o.stitchLenMm * 1.3);
      if (nextStitchLen === o.stitchLenMm) break; // 全パラメータ上限 → 打ち切り
    }
    o = { ...o, rowSpacingMm: nextRow, satinSpacingMm: nextSatin, stitchLenMm: nextStitchLen };
    adjusted = true;
    res = digitize(img, o);
  }

  return {
    ...res,
    autoAdjusted: adjusted
      ? {
          rowSpacingMm: Math.round(o.rowSpacingMm * 100) / 100,
          satinSpacingMm: Math.round(o.satinSpacingMm * 100) / 100,
          stitchLenMm: Math.round(o.stitchLenMm * 100) / 100,
        }
      : null,
    overLimit: res.stats.stitches > maxStitches,
  };
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
  const emptyView: ViewTransform = { scale: 1, cx: 0, cy: 0, offsetX: 0, offsetY: 0 };

  // 前景バウンディングボックス (抜き指定の前に計算し、抜きでサイズが変わらないようにする)
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
      stats: {
        stitches: 0,
        jumps: 0,
        trims: 0,
        colorChanges: 0,
        colors: 0,
        widthMm: 0,
        heightMm: 0,
        estMinutes: 0,
      },
      view: emptyView,
      excludedMask: null,
    };
  }

  // クリックで指定された抜き領域を背景化
  let excludedMask: Uint8Array | null = null;
  if (o.excludePoints && o.excludePoints.length > 0) {
    excludedMask = excludeRegions(quant, o.excludePoints);
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
  // 縫い順ランク: 自分より後に縫われる色の上は移動しても後で覆われる
  const sewRank = new Map<number, number>();
  colorOrder.forEach((ci, rank) => sewRank.set(ci, rank));

  const usedThreads = new Set<number>();
  let firstBlock = true;

  for (const c of colorOrder) {
    const pal = quant.palette[c];
    const thread = nearestPecThread(pal.r, pal.g, pal.b, usedThreads);
    usedThreads.add(thread.pecIndex);
    pattern.threads.push(thread);

    const mmPerPx = scale / 10;
    const { compMap, comps } = labelColorComponents(quant.labels, quant.width, quant.height, c);

    const fillRuns: Pt[][] = [];
    const outlineRuns: Pt[][] = [];
    const userAngle = (o.angleDeg * Math.PI) / 180;

    // 細い線のコンポーネントはスケルトン (中心線) ルートで縫う。
    // 連結した線ネットワークは「行き=アンダーパス、帰り=サテン/ランニング」の
    // 一筆書きになり、コンポーネント内の糸切り・ジャンプはゼロになる
    const thinComps = new Set<number>();
    if (o.fill && o.autoThinDetect) {
      for (const comp of comps) {
        const hydraulicMm = ((2 * comp.area) / Math.max(1, comp.boundary)) * mmPerPx;
        if (hydraulicMm > o.satinMaxWidthMm * 1.8) continue;
        const run = skeletonRun(comp, compMap, quant.width, quant.height, o, mmPerPx, toUnits);
        if (run) {
          thinComps.add(comp.id);
          fillRuns.push(run);
        }
      }
    }

    // 輪郭ループ (ピクセル空間で簡略化・平滑化してから領域にまとめる)
    const rawLoops = traceContours(quant.labels, quant.width, quant.height, c);
    const loopsPx: Pt[][] = [];
    for (const raw of rawLoops) {
      if (Math.abs(loopArea(raw)) < 2) continue;
      const simplified = simplifyLoop(raw, 0.75);
      const smoothed = smoothLoop(simplified, o.outlineSmoothing);
      if (smoothed.length >= 3) loopsPx.push(smoothed);
    }
    const regions = groupRegions(loopsPx);

    for (const region of regions) {
      // スケルトンで処理済みの細い線コンポーネントはスキップ
      const ip = regionInteriorPoint(region);
      if (ip) {
        const xi = Math.min(quant.width - 1, Math.max(0, Math.round(ip[0])));
        const yi = Math.min(quant.height - 1, Math.max(0, Math.round(ip[1])));
        const cid = compMap[yi * quant.width + xi];
        if (cid >= 0 && thinComps.has(cid)) continue;
      }
      const regionLoops = [region.outer, ...region.holes].map((l) => l.map(toUnits));
      if (o.fill) {
        fillRuns.push(...fillLoops(regionLoops, buildFillOptions("tatami", o, userAngle)));
      }
      if (o.outline) {
        const stitchLen = o.outlineStitchMm * 10;
        for (const loop of regionLoops) {
          // 5mm 未満の微小ループの輪郭線は省略 (針数と糸切りの削減)
          if (loopPerimeter(loop) < 50) continue;
          const run = o.tripleOutline
            ? tripleRunningStitch(loop, stitchLen)
            : runningStitch(loop, stitchLen);
          if (run.length >= 2) outlineRuns.push(run);
        }
      }
    }

    // ノイズ由来の極小 run (3針以下かつ全長2mm未満) は縫わない
    const runLength = (run: Pt[]): number => {
      let L = 0;
      for (let i = 1; i < run.length; i++) {
        L += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
      }
      return L;
    };
    const significant = (run: Pt[]): boolean => run.length > 3 || runLength(run) > 20;
    const fillRunsF = fillRuns.filter(significant);
    const outlineRunsF = outlineRuns.filter(significant);

    if (fillRunsF.length === 0 && outlineRunsF.length === 0) {
      pattern.threads.pop();
      usedThreads.delete(thread.pecIndex);
      continue;
    }

    if (!firstBlock) {
      const last = pattern.stitches[pattern.stitches.length - 1];
      pattern.add(TRIM, last.x, last.y); // 色替え前は糸切り
      pattern.add(COLOR_CHANGE, last.x, last.y);
    }
    firstBlock = false;

    // 同色内は nearest-neighbor で縫い順を決め、
    // 「同色領域の内側を通る」移動だけをつなぎ縫いで連結する。
    // 他の色や背景を横切るつなぎ縫いは目に見える縫い込みになるため、
    // その場合は糸切り+ジャンプにする
    const connectUnits = o.maxConnectMm * 10;
    const walkPitch = Math.max(10, o.stitchLenMm * 10);
    const TINY_CONNECT = 15; // 1.5mm 以下の移動は色をまたいでも繋ぐ (線の途切れ対策)

    // つなぎ縫いの経路が「隠れる」か:
    //  - 自分と同じ色の上 → 同色なので見えない
    //  - 自分より後に縫う色の上 → その色の縫いで覆われる (塗りつぶしON時)
    const myRank = sewRank.get(c) ?? 0;
    const labelHidden = (lab: number): boolean => {
      if (lab === c) return true;
      if (!o.fill) return false;
      const r = sewRank.get(lab);
      return r !== undefined && r > myRank;
    };
    const hiddenAt = (px: number, py: number): boolean => {
      // デザイン端の点は最寄りの画素にクランプして判定する
      const xi = Math.min(quant.width - 1, Math.max(0, Math.round(px)));
      const yi = Math.min(quant.height - 1, Math.max(0, Math.round(py)));
      const w = quant.width;
      const L = quant.labels;
      if (labelHidden(L[yi * w + xi])) return true;
      // 境界上の丸め誤差を許容して4近傍も見る
      return (
        (xi > 0 && labelHidden(L[yi * w + xi - 1])) ||
        (xi < w - 1 && labelHidden(L[yi * w + xi + 1])) ||
        (yi > 0 && labelHidden(L[(yi - 1) * w + xi])) ||
        (yi < quant.height - 1 && labelHidden(L[(yi + 1) * w + xi]))
      );
    };
    const hiddenPath = (ax: number, ay: number, bx: number, by: number): boolean => {
      const d = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(d / 8));
      for (let i = 0; i <= n; i++) {
        const ux = ax + ((bx - ax) * i) / n;
        const uy = ay + ((by - ay) * i) / n;
        if (!hiddenAt(ux / scale + cx, uy / scale + cy)) return false;
      }
      return true;
    };

    const curPos = (): Pt | null => {
      for (let i = pattern.stitches.length - 1; i >= 0; i--) {
        const s = pattern.stitches[i];
        if (s.cmd === STITCH || s.cmd === JUMP) return [s.x, s.y];
      }
      return null;
    };

    const emitRun = (run: Pt[]) => {
      const [sx, sy] = run[0];
      const last = pattern.stitches[pattern.stitches.length - 1];
      if (!last || last.cmd === COLOR_CHANGE) {
        // パターン先頭・色替え直後は位置決めジャンプ (色替え時に機械が糸を切る)
        pattern.add(JUMP, sx, sy);
      } else {
        const d = Math.hypot(sx - last.x, sy - last.y);
        const hidden =
          d <= TINY_CONNECT ||
          (d <= connectUnits && hiddenPath(last.x, last.y, sx, sy));
        if (o.reduceTrims && hidden) {
          // つなぎ縫い: 同色領域の内側を通るので見えない
          const n = Math.ceil(d / walkPitch);
          for (let i = 1; i < n; i++) {
            pattern.add(
              STITCH,
              last.x + ((sx - last.x) * i) / n,
              last.y + ((sy - last.y) * i) / n,
            );
          }
        } else if (d > 1) {
          pattern.add(TRIM, last.x, last.y);
          pattern.add(JUMP, sx, sy);
        }
      }
      for (const [x, y] of run) pattern.add(STITCH, x, y);
    };

    for (const run of orderRunsNearest(fillRunsF, curPos())) emitRun(run);
    for (const run of orderRunsNearest(outlineRunsF, curPos())) emitRun(run);
  }

  if (pattern.stitches.length > 0) {
    const last = pattern.stitches[pattern.stitches.length - 1];
    pattern.add(END, last.x, last.y);
  } else {
    pattern.add(END, 0, 0);
  }

  const centerOffset = pattern.center();

  for (const s of pattern.stitches) {
    s.x = Math.round(s.x);
    s.y = Math.round(s.y);
  }

  const b = pattern.bounds();
  const stitches = pattern.countStitches();
  const stats: DigitizeStats = {
    stitches,
    jumps: pattern.countJumps(),
    trims: pattern.countTrims(),
    colorChanges: pattern.countColorChanges(),
    colors: pattern.threads.length,
    widthMm: (b.maxX - b.minX) / 10,
    heightMm: (b.maxY - b.minY) / 10,
    estMinutes: Math.round((stitches / 400) * 10) / 10,
  };

  const view: ViewTransform = {
    scale,
    cx,
    cy,
    offsetX: centerOffset.dx,
    offsetY: centerOffset.dy,
  };

  return { pattern, quant, colorOrder, stats, view, excludedMask };
}

// ------------------------------------------------------ 色コンポーネント

interface ColorComponent {
  id: number;
  area: number;
  /** 境界画素数 (周長の近似) */
  boundary: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 指定色の8連結コンポーネントを抽出する */
function labelColorComponents(
  labels: Int32Array,
  w: number,
  h: number,
  c: number,
): { compMap: Int32Array; comps: ColorComponent[] } {
  const compMap = new Int32Array(w * h).fill(-1);
  const comps: ColorComponent[] = [];
  for (let start = 0; start < w * h; start++) {
    if (labels[start] !== c || compMap[start] >= 0) continue;
    const id = comps.length;
    const comp: ColorComponent = {
      id,
      area: 0,
      boundary: 0,
      x0: Infinity,
      y0: Infinity,
      x1: -Infinity,
      y1: -Infinity,
    };
    compMap[start] = id;
    const stack = [start];
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p / w) | 0;
      comp.area++;
      if (x < comp.x0) comp.x0 = x;
      if (x > comp.x1) comp.x1 = x;
      if (y < comp.y0) comp.y0 = y;
      if (y > comp.y1) comp.y1 = y;
      let isBoundary = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          const inside = nx >= 0 && ny >= 0 && nx < w && ny < h;
          const sameColor = inside && labels[ny * w + nx] === c;
          if (sameColor) {
            const ni = ny * w + nx;
            if (compMap[ni] < 0) {
              compMap[ni] = id;
              stack.push(ni);
            }
          } else if (dx === 0 || dy === 0) {
            isBoundary = true; // 4近傍に他色/背景がある = 境界画素
          }
        }
      }
      if (isBoundary) comp.boundary++;
    }
    comps.push(comp);
  }
  return { compMap, comps };
}

/**
 * 細い線コンポーネントをスケルトンルートで縫う。
 * 戻り値はパターン座標 (0.1mm) の連続した1本の run。
 * 幅がサテン適用幅を超える・スケルトンが取れない場合は null (タタミで処理)。
 */
function skeletonRun(
  comp: ColorComponent,
  compMap: Int32Array,
  w: number,
  h: number,
  o: DigitizeOptions,
  mmPerPx: number,
  toUnits: (p: Pt) => Pt,
): Pt[] | null {
  const x0 = Math.max(0, comp.x0 - 1);
  const y0 = Math.max(0, comp.y0 - 1);
  const bw = Math.min(w - 1, comp.x1 + 1) - x0 + 1;
  const bh = Math.min(h - 1, comp.y1 + 1) - y0 + 1;
  if (bw < 2 || bh < 2) return null;
  const mask = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (compMap[(y + y0) * w + (x + x0)] === comp.id) mask[y * bw + x] = 1;
    }
  }

  const skel = thinMask(mask, bw, bh);
  const dt = distanceTransform(mask, bw, bh);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < skel.length; i++) {
    if (skel[i]) {
      sum += dt[i] / 3;
      n++;
    }
  }
  if (n === 0) return null;
  const widthMm = 2 * (sum / n) * mmPerPx;
  if (widthMm > o.satinMaxWidthMm) return null; // 太い → タタミで処理
  const mode: "satin" | "centerline" =
    o.centerlineMaxWidthMm > 0 && widthMm <= o.centerlineMaxWidthMm ? "centerline" : "satin";

  const { edges, nodes } = skeletonGraph(skel, bw, bh);
  if (edges.length === 0) return null;

  const runStepPx = Math.max(1, o.outlineStitchMm / mmPerPx);
  const satinStepPx = Math.max(0.8, o.satinSpacingMm / mmPerPx);
  const maxHalfWidthPx = ((o.satinMaxWidthMm / mmPerPx) / 2) * 1.3;

  let pxRun: Px[];
  if (mode === "centerline" && edges.length === 1 && edges[0].a !== edges[0].b) {
    // 分岐のない1本線は片道のランニング (端で終わる → 隣の線へ繋ぎやすい)
    pxRun = smoothPolyline(resamplePath(smoothPolyline(edges[0].path, 2), runStepPx), 1);
  } else {
    const moves = routeSkeleton(edges, nodes);
    pxRun = stitchRoute(moves, { mode, satinStepPx, runStepPx, dt, w: bw, maxHalfWidthPx });
  }
  if (pxRun.length < 2) return null;
  return pxRun.map(([lx, ly]) => toUnits([lx + x0, ly + y0]));
}

/** 領域 (外周-穴) の内部にある点を1つ返す */
function regionInteriorPoint(region: Region): Pt | null {
  const loop = region.outer;
  const inRegion = (p: Pt): boolean => {
    if (!pointInPolygon(p, region.outer)) return false;
    for (const hole of region.holes) if (pointInPolygon(p, hole)) return false;
    return true;
  };
  for (let i = 0; i < loop.length; i++) {
    const [ax, ay] = loop[i];
    const [bx, by] = loop[(i + 1) % loop.length];
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (by - ay) / len;
    const ny = -(bx - ax) / len;
    for (const s of [0.7, -0.7, 1.5, -1.5]) {
      const p: Pt = [mx + nx * s, my + ny * s];
      if (inRegion(p)) return p;
    }
  }
  return null;
}

// ------------------------------------------------------------ 縫い順最適化

/**
 * run 群を nearest-neighbor で並べ替える。
 * - 開いた run: 始点・終点の近い方を選び、必要なら反転する
 * - 閉じた run (輪郭ループなど): 現在位置に最も近い頂点から
 *   縫い始められるよう回転する (糸切り・渡りの距離を最小化)
 */
export function orderRunsNearest(runs: Pt[][], start: Pt | null): Pt[][] {
  const remaining = runs.slice();
  const ordered: Pt[][] = [];
  let cur = start;

  const isClosed = (run: Pt[]): boolean => {
    const [sx, sy] = run[0];
    const [ex, ey] = run[run.length - 1];
    return Math.hypot(ex - sx, ey - sy) < 2;
  };

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestRev = false;
    let bestRot = 0;
    let bestD = Infinity;
    if (cur) {
      for (let i = 0; i < remaining.length; i++) {
        const run = remaining[i];
        if (isClosed(run)) {
          // 閉ループは全頂点が開始点候補
          for (let k = 0; k < run.length - 1; k++) {
            const d = Math.hypot(run[k][0] - cur[0], run[k][1] - cur[1]);
            if (d < bestD) {
              bestD = d;
              bestIdx = i;
              bestRev = false;
              bestRot = k;
            }
          }
        } else {
          const [sx, sy] = run[0];
          const [ex, ey] = run[run.length - 1];
          const ds = Math.hypot(sx - cur[0], sy - cur[1]);
          const de = Math.hypot(ex - cur[0], ey - cur[1]);
          if (ds < bestD) {
            bestD = ds;
            bestIdx = i;
            bestRev = false;
            bestRot = 0;
          }
          if (de < bestD) {
            bestD = de;
            bestIdx = i;
            bestRev = true;
            bestRot = 0;
          }
        }
      }
    }
    let run = remaining.splice(bestIdx, 1)[0];
    if (bestRot > 0) {
      // 閉ループを bestRot 番目の頂点から始まるよう回転して閉じ直す
      const core = run.slice(0, run.length - 1);
      const rotated = core.slice(bestRot).concat(core.slice(0, bestRot));
      rotated.push([rotated[0][0], rotated[0][1]]);
      run = rotated;
    }
    if (bestRev) run.reverse();
    ordered.push(run);
    cur = run[run.length - 1];
  }
  return ordered;
}

// ---------------------------------------------------------------- 抜き指定

/** 各指定点が属する連結領域を背景化し、除外マスクを返す */
function excludeRegions(quant: QuantizeResult, points: [number, number][]): Uint8Array {
  const { labels, width: w, height: h } = quant;
  const mask = new Uint8Array(w * h);
  for (const [px, py] of points) {
    const x = Math.round(px);
    const y = Math.round(py);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const start = y * w + x;
    const lab = labels[start];
    if (lab < 0) continue;
    labels[start] = -1;
    mask[start] = 1;
    const queue = [start];
    while (queue.length > 0) {
      const i = queue.pop()!;
      const ix = i % w;
      const iy = (i / w) | 0;
      const neighbors = [
        ix > 0 ? i - 1 : -1,
        ix < w - 1 ? i + 1 : -1,
        iy > 0 ? i - w : -1,
        iy < h - 1 ? i + w : -1,
      ];
      for (const ni of neighbors) {
        if (ni >= 0 && labels[ni] === lab) {
          labels[ni] = -1;
          mask[ni] = 1;
          queue.push(ni);
        }
      }
    }
  }
  return mask;
}

// ------------------------------------------------------------ 領域グループ

interface Region {
  outer: Pt[];
  holes: Pt[][];
}

/**
 * ループ群を「外周 + その穴」の領域にまとめる。
 * 輪郭抽出の向き (内部が左) により、外周は符号付き面積が正、穴は負になる。
 */
function groupRegions(loops: Pt[][]): Region[] {
  const outers: { loop: Pt[]; area: number }[] = [];
  const holeLoops: { loop: Pt[]; area: number }[] = [];
  for (const loop of loops) {
    const a = loopArea(loop);
    if (a >= 0) outers.push({ loop, area: a });
    else holeLoops.push({ loop, area: a });
  }
  const regions: Region[] = outers.map((e) => ({ outer: e.loop, holes: [] }));
  for (const h of holeLoops) {
    let bestIdx = -1;
    let bestArea = Infinity;
    for (let i = 0; i < outers.length; i++) {
      if (outers[i].area < -h.area) continue;
      if (outers[i].area >= bestArea) continue;
      if (pointInPolygon(h.loop[0], outers[i].loop)) {
        bestArea = outers[i].area;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) regions[bestIdx].holes.push(h.loop);
  }
  return regions;
}

function pointInPolygon([x, y]: Pt, loop: Pt[]): boolean {
  let inside = false;
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % loop.length];
    if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
      const xi = x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
      if (xi > x) inside = !inside;
    }
  }
  return inside;
}

function loopPerimeter(loop: Pt[]): number {
  let p = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % loop.length];
    p += Math.hypot(x1 - x0, y1 - y0);
  }
  return p;
}

/**
 * 領域の推定幅 (mm)。油圧直径 (4A/P) の半値を使う。
 * - 細い帯 (幅 w): ≈ w
 * - 円 (直径 d): ≈ d/2
 */
function regionWidthMm(r: Region): number {
  let area = loopArea(r.outer);
  let perim = loopPerimeter(r.outer);
  for (const h of r.holes) {
    area += loopArea(h); // 穴は負
    perim += loopPerimeter(h);
  }
  if (perim < 1e-9 || area <= 0) return 0;
  return (4 * area) / perim / 2 / 10;
}

/** 辺の長さで重み付けした PCA による領域の長軸方向 (ラジアン) */
function majorAxisAngle(loop: Pt[]): number {
  let w = 0;
  let mx = 0;
  let my = 0;
  const mids: [number, number, number][] = [];
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % loop.length];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const ex = (x0 + x1) / 2;
    const ey = (y0 + y1) / 2;
    mids.push([ex, ey, len]);
    mx += ex * len;
    my += ey * len;
    w += len;
  }
  if (w < 1e-9) return 0;
  mx /= w;
  my /= w;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [ex, ey, len] of mids) {
    sxx += (ex - mx) * (ex - mx) * len;
    syy += (ey - my) * (ey - my) * len;
    sxy += (ex - mx) * (ey - my) * len;
  }
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

// ------------------------------------------------------------ モード選択

type FillMode = "tatami" | "satin" | "centerline";

function chooseFillMode(widthMm: number, o: DigitizeOptions): FillMode {
  if (!o.autoThinDetect) return "tatami";
  if (o.centerlineMaxWidthMm > 0 && widthMm <= o.centerlineMaxWidthMm) return "centerline";
  if (widthMm <= o.satinMaxWidthMm) return "satin";
  return "tatami";
}

function buildFillOptions(mode: FillMode, o: DigitizeOptions, angle: number): FillOptions {
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
