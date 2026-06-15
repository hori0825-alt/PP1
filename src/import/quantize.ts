// 色数削減 (ポスタリゼーション)。
// - Lab 色空間での k-means により指定色数 (2〜15) へ減色
// - 近傍多数決によるラベル平滑化でアンチエイリアス由来の孤立画素を統合
// - 小さすぎる連結成分を周囲の多数色に統合 (ゴミ領域・中間色の除去)
//
// 不要な中間色を拾いすぎると針数が爆発し PP1 に転送できなくなるため、
// このモジュールが品質の要になる。

import type { LabelMap, RasterImage } from "./raster";
import { backgroundMask } from "./raster";

export interface QuantizeOptions {
  /** 目標色数 (2〜15) */
  colorCount: number;
  /** 縁に接する白を背景として除去するか */
  removeWhiteBackground: boolean;
  /** ラベル平滑化の回数 */
  smoothingPasses?: number;
  /** これ未満の連結成分は周囲の色に統合する (ピクセル数) */
  minComponentPixels?: number;
  /**
   * 小特徴保護のコントラスト閾値 (Lab ΔE)。統合先/多数決色とこれ以上違う色の
   * 小領域は、統合・平滑化で消さない (白目・ハイライト・瞳の光など)。既定 25。
   */
  featureContrast?: number;
}

interface Lab {
  l: number;
  a: number;
  b: number;
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  // sRGB D65 → XYZ
  let x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
  let y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  let z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x);
  y = f(y);
  z = f(z);
  return { l: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

function labDist2(a: Lab, b: Lab): number {
  const dl = a.l - b.l;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dl * dl + da * da + db * db;
}

/** 小特徴として保護する既定コントラスト (Lab ΔE)。白×黒は ~75、肌の濃淡は ~10 程度 */
const MIN_FEATURE_CONTRAST = 25;
/** これ以下の画素数の連結成分はコントラストに関わらず統合する (単画素スペックル除去) */
const NOISE_FLOOR_PIXELS = 2;

/** k-means++ 風の初期中心選択 (決定的: 乱数を使わず最遠点を選ぶ) */
function initialCenters(samples: Lab[], k: number): Lab[] {
  const centers: Lab[] = [samples[0]];
  const dist = new Float64Array(samples.length).fill(Infinity);
  while (centers.length < k) {
    const last = centers[centers.length - 1];
    let farI = 0;
    let farD = -1;
    for (let i = 0; i < samples.length; i++) {
      const d = labDist2(samples[i], last);
      if (d < dist[i]) dist[i] = d;
      if (dist[i] > farD) {
        farD = dist[i];
        farI = i;
      }
    }
    if (farD <= 0) break; // 色の種類が k 未満
    centers.push(samples[farI]);
  }
  return centers;
}

/**
 * Lab 空間 k-means。サンプル数を抑えるため画素を間引いて学習し、
 * 全画素は最近中心に割り当てる。
 */
function kmeans(pixels: Lab[], k: number, maxIter = 16): { centers: Lab[]; assign: (p: Lab) => number } {
  const step = Math.max(1, Math.floor(pixels.length / 20000));
  const samples: Lab[] = [];
  for (let i = 0; i < pixels.length; i += step) samples.push(pixels[i]);

  let centers = initialCenters(samples, Math.min(k, samples.length));
  const nearest = (p: Lab): number => {
    let bi = 0;
    let bd = Infinity;
    for (let c = 0; c < centers.length; c++) {
      const d = labDist2(p, centers[c]);
      if (d < bd) {
        bd = d;
        bi = c;
      }
    }
    return bi;
  };

  for (let it = 0; it < maxIter; it++) {
    const sum = centers.map(() => ({ l: 0, a: 0, b: 0, n: 0 }));
    for (const s of samples) {
      const c = nearest(s);
      sum[c].l += s.l;
      sum[c].a += s.a;
      sum[c].b += s.b;
      sum[c].n++;
    }
    let moved = 0;
    const next: Lab[] = [];
    for (let c = 0; c < centers.length; c++) {
      if (sum[c].n === 0) {
        next.push(centers[c]);
        continue;
      }
      const nc = { l: sum[c].l / sum[c].n, a: sum[c].a / sum[c].n, b: sum[c].b / sum[c].n };
      moved += labDist2(nc, centers[c]);
      next.push(nc);
    }
    centers = next;
    if (moved < 0.01) break;
  }
  return { centers, assign: nearest };
}

/**
 * 近傍多数決によるラベル平滑化 (3×3)。AA 由来の孤立画素・ギザギザを統合する。
 * エッジ保存: 元の色と多数決色が高コントラスト (contrast2 超) なら変えない。
 * AA 画素は隣接色と中間=低コントラストなので平滑化され、白目のような高コントラスト
 * の小特徴はその場に残る。
 */
function smoothLabels(
  labels: Int16Array,
  w: number,
  h: number,
  passes: number,
  centers: Lab[],
  contrast2: number,
): void {
  const counts = new Map<number, number>();
  for (let pass = 0; pass < passes; pass++) {
    const src = labels.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        counts.clear();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const v = src[ny * w + nx];
            counts.set(v, (counts.get(v) ?? 0) + (dx === 0 && dy === 0 ? 2 : 1));
          }
        }
        let best = src[i];
        let bestN = -1;
        for (const [v, n] of counts) {
          if (n > bestN) {
            bestN = n;
            best = v;
          }
        }
        // エッジ保存: 元の色と多数決色が大きく違うなら平滑化しない (小特徴を守る)
        if (
          best !== src[i] &&
          src[i] >= 0 &&
          best >= 0 &&
          labDist2(centers[src[i]], centers[best]) > contrast2
        ) {
          labels[i] = src[i];
        } else {
          labels[i] = best;
        }
      }
    }
  }
}

/**
 * 小さすぎる連結成分 (4近傍) を、隣接する最頻ラベルへ統合する。
 * コントラスト保存: 統合先と高コントラスト (contrast2 超) な小領域は統合しない
 * (白目・ハイライト等の小特徴を守る)。NOISE_FLOOR_PIXELS 以下は単画素スペックル
 * とみなしコントラストに関わらず統合する。
 */
function mergeSmallComponents(
  labels: Int16Array,
  w: number,
  h: number,
  minPixels: number,
  centers: Lab[],
  contrast2: number,
): void {
  const comp = new Int32Array(w * h).fill(-1);
  let compCount = 0;
  const stack: number[] = [];

  for (let start = 0; start < w * h; start++) {
    if (comp[start] !== -1) continue;
    const label = labels[start];
    const id = compCount++;
    const members: number[] = [];
    comp[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      members.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      const tryN = (j: number): void => {
        if (comp[j] === -1 && labels[j] === label) {
          comp[j] = id;
          stack.push(j);
        }
      };
      if (x > 0) tryN(i - 1);
      if (x < w - 1) tryN(i + 1);
      if (y > 0) tryN(i - w);
      if (y < h - 1) tryN(i + w);
    }
    if (members.length >= minPixels || label === -1) continue;

    // 隣接ラベルの最頻値に統合 (背景 -1 も候補に含める)
    const neigh = new Map<number, number>();
    for (const i of members) {
      const x = i % w;
      const y = (i / w) | 0;
      const check = (j: number): void => {
        const v = labels[j];
        if (v !== label) neigh.set(v, (neigh.get(v) ?? 0) + 1);
      };
      if (x > 0) check(i - 1);
      if (x < w - 1) check(i + 1);
      if (y > 0) check(i - w);
      if (y < h - 1) check(i + w);
    }
    let best = label;
    let bestN = -1;
    for (const [v, n] of neigh) {
      if (n > bestN) {
        bestN = n;
        best = v;
      }
    }
    // コントラスト保存: 統合先と大きく違う色の小領域 (白目・ハイライト等) は残す。
    // ただし NOISE_FLOOR_PIXELS 以下の極小は単画素スペックルとみなし統合する。
    const highContrast =
      best >= 0 &&
      members.length > NOISE_FLOOR_PIXELS &&
      labDist2(centers[label], centers[best]) > contrast2;
    if (best !== label && !highContrast) {
      for (const i of members) labels[i] = best;
    }
  }
}

/**
 * 画像を減色してラベルマップを作る。
 * パレット色は各クラスタの平均 RGB。背景は -1。
 */
export function quantize(img: RasterImage, options: QuantizeOptions): LabelMap {
  const { width: w, height: h, data } = img;
  const k = Math.max(2, Math.min(15, options.colorCount));
  const bg = backgroundMask(img, options.removeWhiteBackground);

  // 前景ピクセルの Lab 値
  const fgIndex: number[] = [];
  const fgLab: Lab[] = [];
  for (let i = 0; i < w * h; i++) {
    if (bg[i]) continue;
    fgIndex.push(i);
    fgLab.push(rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]));
  }

  const labels = new Int16Array(w * h).fill(-1);
  if (fgLab.length === 0) {
    return { width: w, height: h, labels, palette: [] };
  }

  const { centers, assign } = kmeans(fgLab, k);
  const sumR = new Float64Array(centers.length);
  const sumG = new Float64Array(centers.length);
  const sumB = new Float64Array(centers.length);
  const cnt = new Float64Array(centers.length);
  for (let n = 0; n < fgIndex.length; n++) {
    const c = assign(fgLab[n]);
    const i = fgIndex[n];
    labels[i] = c;
    sumR[c] += data[i * 4];
    sumG[c] += data[i * 4 + 1];
    sumB[c] += data[i * 4 + 2];
    cnt[c]++;
  }

  // 小特徴保護のコントラスト閾値 (Lab ΔE → 二乗距離)
  const contrast2 = (options.featureContrast ?? MIN_FEATURE_CONTRAST) ** 2;
  smoothLabels(labels, w, h, options.smoothingPasses ?? 2, centers, contrast2);
  mergeSmallComponents(labels, w, h, options.minComponentPixels ?? 16, centers, contrast2);

  // 統合後に残った色だけでパレットを作り、ラベルを詰め直す
  const used = new Map<number, number>();
  const palette: { r: number; g: number; b: number }[] = [];
  for (let i = 0; i < w * h; i++) {
    const v = labels[i];
    if (v === -1) continue;
    let idx = used.get(v);
    if (idx === undefined) {
      idx = palette.length;
      used.set(v, idx);
      palette.push({
        r: Math.round(sumR[v] / Math.max(1, cnt[v])),
        g: Math.round(sumG[v] / Math.max(1, cnt[v])),
        b: Math.round(sumB[v] / Math.max(1, cnt[v])),
      });
    }
    labels[i] = idx;
  }
  return { width: w, height: h, labels, palette };
}
