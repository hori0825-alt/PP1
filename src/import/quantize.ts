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

export interface Lab {
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

export function labDist2(a: Lab, b: Lab): number {
  const dl = a.l - b.l;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dl * dl + da * da + db * db;
}

/** 小特徴として保護する既定コントラスト (Lab ΔE)。白×黒は ~75、肌の濃淡は ~10 程度 */
const MIN_FEATURE_CONTRAST = 25;
/** これ以下の画素数の連結成分はコントラストに関わらず統合する (単画素スペックル除去) */
const NOISE_FLOOR_PIXELS = 2;

/** 最近中心のインデックスを返す関数を作る */
function makeNearest(centers: Lab[]): (p: Lab) => number {
  return (p: Lab): number => {
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
}

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
function kmeans(pixels: Lab[], k: number, maxIter = 16): Lab[] {
  const step = Math.max(1, Math.floor(pixels.length / 20000));
  const samples: Lab[] = [];
  for (let i = 0; i < pixels.length; i += step) samples.push(pixels[i]);

  let centers = initialCenters(samples, Math.min(k, samples.length));

  for (let it = 0; it < maxIter; it++) {
    const nearest = makeNearest(centers);
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
  return centers;
}

/**
 * k-means が取りこぼした「小さく高コントラストな特徴」を追加パレット色として復活させる。
 *
 * 問題: 学習画素の間引き (kmeans の step) と少ない目標色数のため、白目・ハイライト等の
 * 小領域は専用クラスタを得られず、最近の暗い中心へ吸収される。下流のコントラスト保護は
 * 「既存ラベル」を守るだけなので、そもそもラベルが生成されなければ無力。
 *
 * 対策: 全前景画素を現中心へ仮割り当てし、割り当て先と高コントラスト (contrast2 超) な
 * 画素を「表現漏れ」とみなす。それらを 4 近傍 + 色一貫性で連結し、十分な大きさ
 * (FEATURE_MIN_PIXELS 以上) かつ既存色から離れた塊の平均色を新中心として追加する。
 * 大きい塊を優先し、最大 FEATURE_MAX_EXTRA 色まで追加する (色数爆発の抑制)。
 */
const FEATURE_MIN_PIXELS = 4;
const FEATURE_MAX_EXTRA = 4;

function promoteFeatures(
  fgIndex: number[],
  fgLab: Lab[],
  w: number,
  h: number,
  centers: Lab[],
  contrast2: number,
): Lab[] {
  const nearest = makeNearest(centers);
  const fgOrder = new Int32Array(w * h).fill(-1);
  const poor = new Uint8Array(fgIndex.length);
  for (let n = 0; n < fgIndex.length; n++) {
    fgOrder[fgIndex[n]] = n;
    if (labDist2(fgLab[n], centers[nearest(fgLab[n])]) > contrast2) poor[n] = 1;
  }

  const visited = new Uint8Array(fgIndex.length);
  const stack: number[] = [];
  const blobs: { mean: Lab; count: number }[] = [];

  for (let start = 0; start < fgIndex.length; start++) {
    if (poor[start] === 0 || visited[start]) continue;
    const seed = fgLab[start];
    visited[start] = 1;
    stack.length = 0;
    stack.push(start);
    let sl = 0;
    let sa = 0;
    let sb = 0;
    let count = 0;
    while (stack.length > 0) {
      const n = stack.pop() as number;
      const lab = fgLab[n];
      sl += lab.l;
      sa += lab.a;
      sb += lab.b;
      count++;
      const pix = fgIndex[n];
      const x = pix % w;
      const y = (pix / w) | 0;
      const tryN = (px: number): void => {
        const m = fgOrder[px];
        if (m < 0 || visited[m] || poor[m] === 0) return;
        if (labDist2(fgLab[m], seed) > contrast2) return; // 色一貫性 (グラデで割れるのを防ぐ)
        visited[m] = 1;
        stack.push(m);
      };
      if (x > 0) tryN(pix - 1);
      if (x < w - 1) tryN(pix + 1);
      if (y > 0) tryN(pix - w);
      if (y < h - 1) tryN(pix + w);
    }
    if (count < FEATURE_MIN_PIXELS) continue;
    const mean = { l: sl / count, a: sa / count, b: sb / count };
    let far = true;
    for (const c of centers) {
      if (labDist2(mean, c) <= contrast2) {
        far = false;
        break;
      }
    }
    if (far) blobs.push({ mean, count });
  }

  if (blobs.length === 0) return centers;
  blobs.sort((a, b) => b.count - a.count);
  const result = centers.slice();
  for (const blob of blobs) {
    if (result.length - centers.length >= FEATURE_MAX_EXTRA) break;
    let ok = true;
    for (let j = centers.length; j < result.length; j++) {
      if (labDist2(blob.mean, result[j]) <= contrast2) {
        ok = false;
        break;
      }
    }
    if (ok) result.push(blob.mean);
  }
  return result;
}

/**
 * 中心数を指定色数 k 以下に抑える (色数の厳守)。
 * 最も近い中心ペアを中点へ統合することを繰り返す。高コントラストの小特徴 (白目等) は
 * 互いに遠いため最後まで残り、近接した冗長な主要色から先に統合される。これにより
 * promoteFeatures が特徴色を足しても総数が k を超えず、かつ特徴は保たれる。
 */
function capCenters(centers: Lab[], k: number): Lab[] {
  const out = centers.slice();
  while (out.length > k) {
    let bi = 0;
    let bj = 1;
    let bd = Infinity;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const d = labDist2(out[i], out[j]);
        if (d < bd) {
          bd = d;
          bi = i;
          bj = j;
        }
      }
    }
    out[bi] = {
      l: (out[bi].l + out[bj].l) / 2,
      a: (out[bi].a + out[bj].a) / 2,
      b: (out[bi].b + out[bj].b) / 2,
    };
    out.splice(bj, 1);
  }
  return out;
}

/** 点 p から線分 a-b への距離の2乗 (Lab 3次元) */
function distToSeg2(p: Lab, a: Lab, b: Lab): number {
  const abl = b.l - a.l;
  const aba = b.a - a.a;
  const abb = b.b - a.b;
  const len2 = abl * abl + aba * aba + abb * abb;
  let t = len2 < 1e-9 ? 0 : ((p.l - a.l) * abl + (p.a - a.a) * aba + (p.b - a.b) * abb) / len2;
  t = Math.max(0, Math.min(1, t));
  const ql = a.l + abl * t;
  const qa = a.a + aba * t;
  const qb = a.b + abb * t;
  const dl = p.l - ql;
  const da = p.a - qa;
  const db = p.b - qb;
  return dl * dl + da * da + db * db;
}

// 自然な色数への集約パラメータ (Lab ΔE)。
const CONSOLIDATE_NEAR2 = 36; // ΔE 6 未満の中心は同色とみなして統合
const CONSOLIDATE_BLEND2 = 100; // 他2色の中間 (ΔE 10 以内) にあれば AA/グラデの遷移色
const CONSOLIDATE_BLEND_REL = 0.35; // 中間色が両端色の小さい方の 35% 未満なら遷移色とみなす

/**
 * k-means が「指定色数を必ず作る」ために起きる過分割を畳み、自然な色数 (≤k) にする。
 * 実際は2色の画像でも、AA/JPEG ノイズや均質色の分割で複数の似た中心ができるため:
 *   1. 知覚的に近すぎる中心 (ΔE<6) を統合する。
 *   2. 前景比 0.6% 未満で、かつ他2色の「中間色」(線分上、AA の証拠) の微小クラスタを
 *      最寄りの色へ吸収する。中間色でない distinct な小特徴 (白目・差し色) は保護して残す。
 * 最低 minColors 色は残す。
 */
function consolidateCenters(pixels: Lab[], centers: Lab[], minColors = 2): Lab[] {
  interface Acc {
    l: number;
    a: number;
    b: number;
    n: number;
  }
  const nearest = makeNearest(centers);
  let groups: Acc[] = centers.map(() => ({ l: 0, a: 0, b: 0, n: 0 }));
  for (const p of pixels) {
    const c = nearest(p);
    groups[c].l += p.l;
    groups[c].a += p.a;
    groups[c].b += p.b;
    groups[c].n++;
  }
  groups = groups.filter((g) => g.n > 0);
  const total = Math.max(1, pixels.length);
  const centerOf = (g: Acc): Lab => ({ l: g.l / g.n, a: g.a / g.n, b: g.b / g.n });
  const mergeInto = (i: number, j: number): void => {
    groups[i].l += groups[j].l;
    groups[i].a += groups[j].a;
    groups[i].b += groups[j].b;
    groups[i].n += groups[j].n;
    groups.splice(j, 1);
  };

  const keep = new Set<Acc>();
  for (;;) {
    if (groups.length <= minColors) break;

    // 1) 近すぎる中心を統合 (過分割を畳む)
    let bi = -1;
    let bj = -1;
    let bd = Infinity;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const d = labDist2(centerOf(groups[i]), centerOf(groups[j]));
        if (d < bd) {
          bd = d;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi >= 0 && bd < CONSOLIDATE_NEAR2) {
      mergeInto(bi, bj);
      continue;
    }

    // 2) 単画素ノイズ、または「他2色の中間にある遷移色 (AA)」を最寄り色へ吸収。
    //    中間色でない distinct な小特徴 (白目・差し色) は保護して残す。
    let did = false;
    const order = [...groups].sort((x, y) => x.n - y.n);
    for (const s of order) {
      if (keep.has(s)) continue;
      const sc = centerOf(s);
      // s より優勢な2色がつくる線分のうち最も近いものを探し、中間色か判定する。
      // 端点を「s より大きいクラスタ」に限定することで、別の遷移色を端点に選んで
      // 相対サイズ判定が外れるのを防ぐ。
      let bestSeg = Infinity;
      let ea = -1;
      let eb = -1;
      for (let i = 0; i < groups.length; i++) {
        if (groups[i] === s || groups[i].n <= s.n) continue;
        for (let j = i + 1; j < groups.length; j++) {
          if (groups[j] === s || groups[j].n <= s.n) continue;
          const d = distToSeg2(sc, centerOf(groups[i]), centerOf(groups[j]));
          if (d < bestSeg) {
            bestSeg = d;
            ea = i;
            eb = j;
          }
        }
      }
      // 中間色: 線分上 (ΔE<10) かつ両端色の小さい方より十分小さい (遷移色の証拠)。
      // 端点色から外れた distinct な小特徴 (白目・差し色) は遷移色でないので保護される。
      const isTransition =
        bestSeg < CONSOLIDATE_BLEND2 &&
        ea >= 0 &&
        s.n < CONSOLIDATE_BLEND_REL * Math.min(groups[ea].n, groups[eb].n);
      let target = -1;
      if (isTransition) {
        // 遷移色は端点 (優勢な2色) の近い方へ吸収する (別の遷移色に巻き込まれないように)
        target = labDist2(sc, centerOf(groups[ea])) <= labDist2(sc, centerOf(groups[eb])) ? ea : eb;
      }
      if (target >= 0) {
        const si = groups.indexOf(s);
        if (si >= 0 && target !== si) {
          mergeInto(target, si);
          did = true;
          break;
        }
      } else {
        keep.add(s); // distinct な小特徴は残す
      }
    }
    if (!did) break;
  }
  return groups.map(centerOf);
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

  // 小特徴保護のコントラスト閾値 (Lab ΔE → 二乗距離)
  const contrast2 = (options.featureContrast ?? MIN_FEATURE_CONTRAST) ** 2;

  // k-means で中心を学習 → 取りこぼした高コントラスト小特徴を専用色として復活 →
  // 指定色数 k を超えた分は近接ペアを統合して k 以下に厳守 (特徴は遠いので残る)
  const trained = kmeans(fgLab, k);
  const promoted = promoteFeatures(fgIndex, fgLab, w, h, trained, contrast2);
  const capped = capCenters(promoted, k);
  // 過分割を畳んで自然な色数にする (2色の絵が5色になるのを防ぐ)
  const centers = consolidateCenters(fgLab, capped);
  const assign = makeNearest(centers);

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
  const map = { width: w, height: h, labels, palette };
  closeNarrowGaps(map);
  return map;
}

/**
 * ラベルマップの狭い背景通路を塞いで、色領域内部の白い隙間を「穴」として保持する。
 *
 * 問題: リボンの結び目の隙間など、色領域に囲まれた白い小空間が、幅1-2pxの
 * 狭い通路で外部背景と繋がっていると、領域抽出で穴ではなく外部の一部になり、
 * 色領域の境界がその隙間を塗り潰した形になる。
 *
 * 修正: 背景ピクセルのうち、色ピクセルに多く囲まれているもの (8近傍中6つ以上が色)
 * を最頻の隣接色に置換する。これで1-2px幅の通路が塞がり、内部の白が孤立して穴になる。
 * 大きな背景領域はほとんど影響されない (縁のピクセルだけ処理対象で、内部は近傍が背景)。
 */
function closeNarrowGaps(map: LabelMap): void {
  const { width: w, height: h, labels } = map;
  const BG = -1;
  for (let pass = 0; pass < 2; pass++) {
    const fill: { idx: number; val: number }[] = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (labels[i] !== BG) continue;
        // 8近傍の色ピクセル数をカウント
        let colorCount = 0;
        const freq = new Map<number, number>();
        const check = (j: number): void => {
          const v = labels[j];
          if (v !== BG) {
            colorCount++;
            freq.set(v, (freq.get(v) ?? 0) + 1);
          }
        };
        check(i - w - 1); check(i - w); check(i - w + 1);
        check(i - 1);                    check(i + 1);
        check(i + w - 1); check(i + w); check(i + w + 1);
        if (colorCount < 6) continue;
        // 最頻の隣接色を採用
        let best = BG;
        let bestN = 0;
        for (const [v, n] of freq) {
          if (n > bestN) { bestN = n; best = v; }
        }
        if (best !== BG) fill.push({ idx: i, val: best });
      }
    }
    if (fill.length === 0) break;
    for (const { idx, val } of fill) labels[idx] = val;
  }
}
