// 画像の減色処理:
//   背景除去 → Oklab 空間での k-means 減色 → ノイズ除去
// アンチエイリアス (輪郭のぼかし) の中間色が独立した糸色にならないよう、
// クラスタ推定にはエッジ画素を使わない。距離は知覚色空間 Oklab で測り、
// 見た目が近い色は1本の糸に統合する。

export interface RasterImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface QuantizeOptions {
  /** 最大色数 (糸の本数の上限) */
  maxColors: number;
  /** これ未満のアルファ値は背景扱い (0-255) */
  alphaThreshold: number;
  /** 画像端から繋がる均一色を背景として除去する */
  autoBackground: boolean;
  /** 背景判定の色距離許容値 (RGB ユークリッド距離) */
  bgTolerance: number;
  /** これ未満のピクセル数の領域は周囲にマージ */
  minRegionPx: number;
  /**
   * 色の統合しきい値 (Oklab×100 の知覚距離)。
   * この距離より近いクラスタ同士は1本の糸に統合される。
   * 7=弱 11=標準 15=強。省略時 11
   */
  mergeTol?: number;
}

export interface PaletteColor {
  r: number;
  g: number;
  b: number;
  count: number;
}

export interface QuantizeResult {
  /** ピクセルごとのパレット番号。-1 = 背景 */
  labels: Int32Array;
  width: number;
  height: number;
  palette: PaletteColor[];
}

const BG = -1;

export function quantize(img: RasterImage, opts: QuantizeOptions): QuantizeResult {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const labels = new Int32Array(n).fill(0);

  // 1. アルファによる背景
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] < opts.alphaThreshold) labels[i] = BG;
  }

  // 2. 画像端から繋がる均一背景の除去
  if (opts.autoBackground) removeBorderBackground(data, w, h, labels, opts.bgTolerance);

  // 3. 前景とエッジ (アンチエイリアス) 画素の判定
  const fgIdx: number[] = [];
  for (let i = 0; i < n; i++) if (labels[i] !== BG) fgIdx.push(i);
  if (fgIdx.length === 0) {
    return { labels, width: w, height: h, palette: [] };
  }
  const edge = edgeMask(data, w, h, labels);

  // 4. Oklab 空間で k-means。クラスタ推定はフラット画素のみで行い、
  //    アンチエイリアスの中間色が「糸色」として認識されるのを防ぐ
  let flatIdx = fgIdx.filter((i) => !edge[i]);
  if (flatIdx.length < Math.max(1000, fgIdx.length * 0.1)) flatIdx = fgIdx;
  const centers = kmeansOklab(data, flatIdx, opts.maxColors, opts.mergeTol ?? 11);

  // 全前景画素を最近傍クラスタへ割当 (同一RGBはキャッシュして高速化)
  const cache = new Map<number, number>();
  for (const i of fgIdx) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    let cIdx = cache.get(key);
    if (cIdx === undefined) {
      const lab = srgbToOklab(r, g, b);
      cIdx = nearestLab(lab, centers);
      cache.set(key, cIdx);
    }
    labels[i] = cIdx;
  }

  // 4b. 微小クラスタ (前景の0.8%未満) は最寄りの色へ吸収
  absorbTinyClusters(labels, fgIdx, centers);

  // 4c. 境界に残る「どちらつかず」画素を近傍多数派へ寄せる
  //     (色距離ガードつき: 細い線のように自分の色が確かな画素は動かない)
  refineLabels(data, labels, w, h, centers);

  // 5. モードフィルタでごま塩ノイズを除去
  modeFilter(labels, w, h);

  // 6. 小さい連結領域を隣接領域へマージ
  mergeSmallRegions(labels, w, h, opts.minRegionPx);

  // 7. パレット再集計 (空クラスタ除去・面積順)
  return rebuildPalette(data, labels, w, h, centers.length);
}

function removeBorderBackground(
  data: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  labels: Int32Array,
  tolerance: number,
): void {
  // 端の前景ピクセルの平均色を背景候補とする
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let cnt = 0;
  const border: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * w + x;
    if (labels[i] === BG) return;
    border.push(i);
    sr += data[i * 4];
    sg += data[i * 4 + 1];
    sb += data[i * 4 + 2];
    cnt++;
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    push(0, y);
    push(w - 1, y);
  }
  if (cnt === 0) return;
  sr /= cnt;
  sg /= cnt;
  sb /= cnt;
  const tol2 = tolerance * tolerance;
  const isBgColor = (i: number) => {
    const dr = data[i * 4] - sr;
    const dg = data[i * 4 + 1] - sg;
    const db = data[i * 4 + 2] - sb;
    return dr * dr + dg * dg + db * db <= tol2;
  };
  // 端ピクセルの過半が背景色でなければ自動除去しない (被写体が端まである画像)
  let match = 0;
  for (const i of border) if (isBgColor(i)) match++;
  if (match < border.length * 0.5) return;

  // 端から BFS で繋がる背景色のみ除去 (内部の同色は残す)
  const queue: number[] = [];
  for (const i of border) {
    if (isBgColor(i)) {
      labels[i] = BG;
      queue.push(i);
    }
  }
  while (queue.length > 0) {
    const i = queue.pop()!;
    const x = i % w;
    const y = (i / w) | 0;
    const neighbors = [
      x > 0 ? i - 1 : -1,
      x < w - 1 ? i + 1 : -1,
      y > 0 ? i - w : -1,
      y < h - 1 ? i + w : -1,
    ];
    for (const ni of neighbors) {
      if (ni >= 0 && labels[ni] !== BG && isBgColor(ni)) {
        labels[ni] = BG;
        queue.push(ni);
      }
    }
  }
}

// ------------------------------------------------------------ Oklab 色空間

export type Lab = [number, number, number];

/** sRGB → Oklab (各成分を100倍したスケール。L: 0〜100) */
export function srgbToOklab(r: number, g: number, b: number): Lab {
  const lin = (v: number): number => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lr = lin(r);
  const lg = lin(g);
  const lb = lin(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s) * 100,
    (1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s) * 100,
    (0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s) * 100,
  ];
}

function labDist2(a: Lab, b: Lab): number {
  const d0 = a[0] - b[0];
  const d1 = a[1] - b[1];
  const d2 = a[2] - b[2];
  return d0 * d0 + d1 * d1 + d2 * d2;
}

function nearestLab(p: Lab, centers: Lab[]): number {
  let best = 0;
  let bestD = Infinity;
  for (let c = 0; c < centers.length; c++) {
    const d = labDist2(p, centers[c]);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * 遷移画素 (アンチエイリアスの中間色) マスク。
 * 「両側に大きく異なる色があり、自分はその中間」の画素だけを
 * マークする。細い線の芯は両側どちらかと同じ色 (極値) なので
 * マークされず、クラスタ推定から消えない。
 */
function edgeMask(
  data: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  labels: Int32Array,
): Uint8Array {
  const edge = new Uint8Array(w * h);
  const t2 = 55 * 55;
  const m2 = 19 * 19; // 中間とみなす最小距離 (両側から t/3 程度離れている)
  const diff2 = (i: number, j: number): number => {
    const dr = data[i * 4] - data[j * 4];
    const dg = data[i * 4 + 1] - data[j * 4 + 1];
    const db = data[i * 4 + 2] - data[j * 4 + 2];
    return dr * dr + dg * dg + db * db;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (labels[i] === BG) continue;
      // 横方向・縦方向の両隣ペアで「中間色」かを判定
      const pairs: [number, number][] = [];
      if (x > 0 && x < w - 1) pairs.push([i - 1, i + 1]);
      if (y > 0 && y < h - 1) pairs.push([i - w, i + w]);
      for (const [a, b] of pairs) {
        const aBg = labels[a] === BG;
        const bBg = labels[b] === BG;
        if (aBg && bBg) continue;
        if (aBg || bBg) {
          // 背景との境界: 内側の隣と色が違えばハロー (にじみ) 画素
          const inner = aBg ? b : a;
          if (diff2(i, inner) > m2) {
            edge[i] = 1;
          }
          continue;
        }
        if (diff2(a, b) > t2 && diff2(i, a) > m2 && diff2(i, b) > m2) {
          edge[i] = 1; // 異なる2色の中間に乗っている
        }
      }
    }
  }
  return edge;
}

/** Oklab 空間での k-means (決定的: 最遠点初期化 + Lloyd 反復) */
function kmeansOklab(
  data: Uint8ClampedArray | Uint8Array,
  idx: number[],
  k: number,
  mergeTol: number,
): Lab[] {
  // サンプリング (最大5万点)
  const stride = Math.max(1, Math.floor(idx.length / 50000));
  const samples: Lab[] = [];
  for (let s = 0; s < idx.length; s += stride) {
    const i = idx[s] * 4;
    samples.push(srgbToOklab(data[i], data[i + 1], data[i + 2]));
  }

  // 最遠点初期化
  const centers: Lab[] = [samples[0].slice() as Lab];
  const minD = new Float64Array(samples.length).fill(Infinity);
  while (centers.length < Math.min(k, samples.length)) {
    const c = centers[centers.length - 1];
    let far = 0;
    let farD = -1;
    for (let s = 0; s < samples.length; s++) {
      const d = labDist2(samples[s], c);
      if (d < minD[s]) minD[s] = d;
      if (minD[s] > farD) {
        farD = minD[s];
        far = s;
      }
    }
    if (farD <= 0) break; // 色数がサンプルの種類より多い
    centers.push(samples[far].slice() as Lab);
  }

  // Lloyd 反復 (最終回のクラスタ占有数も保持)
  let counts = new Array<number>(centers.length).fill(0);
  for (let iter = 0; iter < 12; iter++) {
    const sum = centers.map(() => [0, 0, 0, 0]);
    for (const s of samples) {
      const c = nearestLab(s, centers);
      sum[c][0] += s[0];
      sum[c][1] += s[1];
      sum[c][2] += s[2];
      sum[c][3]++;
    }
    let moved = false;
    for (let c = 0; c < centers.length; c++) {
      counts[c] = sum[c][3];
      if (sum[c][3] === 0) continue;
      const next: Lab = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
      if (labDist2(next, centers[c]) > 0.01) moved = true;
      centers[c] = next;
    }
    if (!moved) break;
  }

  // 階層的な重み付き統合: 知覚距離がしきい値より近いクラスタ同士を
  // 占有数で重み付けして1本の糸にまとめる。これにより「色数」は上限で
  // しかなくなり、画像本来の色数 (例: 髪の微妙な3トーン → 1色) に収束する
  let entries = centers
    .map((c, i) => ({ c, n: counts[i] }))
    .filter((e) => e.n > 0);
  const total = entries.reduce((s, e) => s + e.n, 0);
  while (entries.length > 1) {
    let bi = -1;
    let bj = -1;
    let bestD = Infinity;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const d = labDist2(entries[i].c, entries[j].c);
        if (d < bestD) {
          bestD = d;
          bi = i;
          bj = j;
        }
      }
    }
    // 小さいクラスタ (5%未満) はより積極的に統合する
    const share = Math.min(entries[bi].n, entries[bj].n) / total;
    const eff = share < 0.05 ? mergeTol * 1.4 : mergeTol;
    if (bestD >= eff * eff) break;
    const a = entries[bi];
    const b = entries[bj];
    const n = a.n + b.n;
    const mergedC: Lab = [
      (a.c[0] * a.n + b.c[0] * b.n) / n,
      (a.c[1] * a.n + b.c[1] * b.n) / n,
      (a.c[2] * a.n + b.c[2] * b.n) / n,
    ];
    entries.splice(bj, 1);
    entries[bi] = { c: mergedC, n };
  }
  return entries.map((e) => e.c);
}

/**
 * ラベルの平滑化: 3x3 近傍の多数派と自分が異なり、かつ自分の色が
 * 多数派の色とどちらつかず (距離が拮抗) の画素だけを多数派へ寄せる。
 * アンチエイリアス由来の境界の帯やごま塩を吸収しつつ、
 * 細い線 (自分の色との距離が明確に近い) は保護される。
 */
function refineLabels(
  data: Uint8ClampedArray | Uint8Array,
  labels: Int32Array,
  w: number,
  h: number,
  centers: Lab[],
): void {
  const src = labels.slice();
  const labCache = new Map<number, Lab>();
  const labOf = (i: number): Lab => {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    let v = labCache.get(key);
    if (v === undefined) {
      v = srgbToOklab(r, g, b);
      labCache.set(key, v);
    }
    return v;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const own = src[i];
      if (own === BG) continue;
      // 3x3 の多数派ラベルを数える
      const cnt = new Map<number, number>();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const l = src[ny * w + nx];
          if (l === BG) continue;
          cnt.set(l, (cnt.get(l) ?? 0) + 1);
        }
      }
      let maj = own;
      let majC = 0;
      for (const [l, c] of cnt) {
        if (c > majC) {
          majC = c;
          maj = l;
        }
      }
      if (maj === own || majC < 5) continue;
      // 色距離ガード: 自分の色に明確に近い画素は動かさない
      const p = labOf(i);
      const dOwn = Math.sqrt(labDist2(p, centers[own]));
      const dMaj = Math.sqrt(labDist2(p, centers[maj]));
      if (dMaj <= dOwn * 1.4 + 2) labels[i] = maj;
    }
  }
}

/**
 * 微小クラスタの吸収。
 * - 前景の0.8%未満で、かつ知覚的に近い色 (アンチエイリアス残渣や
 *   微妙なトーン違い) がある場合のみ最寄りの色へ統合する
 * - 黒い線画のように面積は小さくても見た目が明確に異なる色は残す
 * - 32px 未満の極小クラスタは無条件で吸収 (ノイズ)
 */
function absorbTinyClusters(labels: Int32Array, fgIdx: number[], centers: Lab[]): void {
  const counts = new Array<number>(centers.length).fill(0);
  for (const i of fgIdx) counts[labels[i]]++;
  const minCount = Math.max(64, Math.round(fgIdx.length * 0.008));
  const similarTol2 = 14 * 14; // これより近い色があれば「同じ糸でよい」

  // 大きい順に処理し、残す/吸収するを決める
  const order = centers
    .map((_, c) => c)
    .filter((c) => counts[c] > 0)
    .sort((a, b) => counts[b] - counts[a]);
  const keep: number[] = [];
  const remap = new Int32Array(centers.length);
  for (let c = 0; c < centers.length; c++) remap[c] = c;

  for (const c of order) {
    if (keep.length === 0 || counts[c] >= minCount) {
      keep.push(c);
      continue;
    }
    let best = keep[0];
    let bestD = Infinity;
    for (const kc of keep) {
      const d = labDist2(centers[c], centers[kc]);
      if (d < bestD) {
        bestD = d;
        best = kc;
      }
    }
    if (bestD < similarTol2 || counts[c] < 32) {
      remap[c] = best; // 似た色がある or 極小ノイズ → 吸収
    } else {
      keep.push(c); // 小さくても独立した色 (線画など) は残す
    }
  }
  for (const i of fgIdx) labels[i] = remap[labels[i]];
}

function modeFilter(labels: Int32Array, w: number, h: number): void {
  // 超多数決 (3x3 中 7 以上) の場合のみ反転する。
  // 単純多数決だと幅 1〜2px の細い線 (線画の輪郭など) が消えてしまうため、
  // ごま塩ノイズ (孤立 1〜2px) だけを除去し、線は保護する。
  const src = labels.slice();
  let maxLabel = 0;
  for (let i = 0; i < src.length; i++) if (src[i] > maxLabel) maxLabel = src[i];
  const counts = new Int32Array(maxLabel + 2); // [0]=BG, [l+1]=ラベルl
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (src[i] === BG) continue;
      let best = src[i];
      let bestC = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const l = src[ny * w + nx];
          const c = ++counts[l + 1];
          if (c > bestC) {
            bestC = c;
            best = l;
          }
        }
      }
      // カウンタをリセット (touched セルのみ)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          counts[src[ny * w + nx] + 1] = 0;
        }
      }
      if (best !== src[i] && bestC >= 7) labels[i] = best;
    }
  }
}

function mergeSmallRegions(labels: Int32Array, w: number, h: number, minPx: number): void {
  if (minPx <= 1) return;
  const n = w * h;
  for (let pass = 0; pass < 2; pass++) {
    const seen = new Uint8Array(n);
    for (let start = 0; start < n; start++) {
      if (seen[start] || labels[start] === BG) continue;
      const label = labels[start];
      // 連結成分を BFS で収集
      const region: number[] = [start];
      seen[start] = 1;
      const neighborCount = new Map<number, number>();
      for (let qi = 0; qi < region.length; qi++) {
        const i = region[qi];
        const x = i % w;
        const y = (i / w) | 0;
        const neighbors = [
          x > 0 ? i - 1 : -1,
          x < w - 1 ? i + 1 : -1,
          y > 0 ? i - w : -1,
          y < h - 1 ? i + w : -1,
        ];
        for (const ni of neighbors) {
          if (ni < 0) continue;
          if (labels[ni] === label) {
            if (!seen[ni]) {
              seen[ni] = 1;
              region.push(ni);
            }
          } else {
            neighborCount.set(labels[ni], (neighborCount.get(labels[ni]) ?? 0) + 1);
          }
        }
      }
      if (region.length >= minPx) continue;
      // 細長い領域 (線画の輪郭・髪の毛の線など) は面積が小さくても残す。
      // コンパクトネス = 境界長^2 / 面積。塊は ~16、線は線長に比例して大きくなる
      let boundary = 0;
      for (const c of neighborCount.values()) boundary += c;
      const compactness = (boundary * boundary) / region.length;
      if (region.length >= 12 && compactness > 90) continue;
      // 最も接している隣接ラベルにマージ
      let best = BG;
      let bestC = 0;
      for (const [l, c] of neighborCount) {
        if (c > bestC) {
          bestC = c;
          best = l;
        }
      }
      for (const i of region) labels[i] = best;
    }
  }
}

function rebuildPalette(
  data: Uint8ClampedArray | Uint8Array,
  labels: Int32Array,
  w: number,
  h: number,
  numClusters: number,
): QuantizeResult {
  const n = w * h;
  const sum: number[][] = [];
  for (let c = 0; c < numClusters; c++) sum.push([0, 0, 0, 0]);
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l === BG) continue;
    sum[l][0] += data[i * 4];
    sum[l][1] += data[i * 4 + 1];
    sum[l][2] += data[i * 4 + 2];
    sum[l][3]++;
  }
  // 面積降順で再番号付け
  const order = sum
    .map((s, c) => ({ c, count: s[3] }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count);
  const remap = new Int32Array(numClusters).fill(BG);
  const palette: PaletteColor[] = [];
  for (let rank = 0; rank < order.length; rank++) {
    const { c, count } = order[rank];
    remap[c] = rank;
    palette.push({
      r: Math.round(sum[c][0] / count),
      g: Math.round(sum[c][1] / count),
      b: Math.round(sum[c][2] / count),
      count,
    });
  }
  for (let i = 0; i < n; i++) {
    if (labels[i] !== BG) labels[i] = remap[labels[i]];
  }
  return { labels, width: w, height: h, palette };
}
