// 画像の減色処理: 背景除去 → k-means 減色 → ノイズ除去 (モードフィルタ + 小領域マージ)

export interface RasterImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface QuantizeOptions {
  /** 最大色数 (糸の本数) */
  maxColors: number;
  /** これ未満のアルファ値は背景扱い (0-255) */
  alphaThreshold: number;
  /** 画像端から繋がる均一色を背景として除去する */
  autoBackground: boolean;
  /** 背景判定の色距離許容値 (RGB ユークリッド距離) */
  bgTolerance: number;
  /** これ未満のピクセル数の領域は周囲にマージ */
  minRegionPx: number;
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

  // 3. 前景ピクセル収集
  const fgIdx: number[] = [];
  for (let i = 0; i < n; i++) if (labels[i] !== BG) fgIdx.push(i);
  if (fgIdx.length === 0) {
    return { labels, width: w, height: h, palette: [] };
  }

  // 4. k-means 減色
  const centers = kmeans(data, fgIdx, opts.maxColors);
  for (const i of fgIdx) {
    labels[i] = nearestCenter(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], centers);
  }

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

function nearestCenter(r: number, g: number, b: number, centers: number[][]): number {
  let best = 0;
  let bestD = Infinity;
  for (let c = 0; c < centers.length; c++) {
    const dr = r - centers[c][0];
    const dg = g - centers[c][1];
    const db = b - centers[c][2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function kmeans(
  data: Uint8ClampedArray | Uint8Array,
  fgIdx: number[],
  k: number,
): number[][] {
  // サンプリング (最大5万点)
  const stride = Math.max(1, Math.floor(fgIdx.length / 50000));
  const samples: number[][] = [];
  for (let s = 0; s < fgIdx.length; s += stride) {
    const i = fgIdx[s] * 4;
    samples.push([data[i], data[i + 1], data[i + 2]]);
  }

  // k-means++ 初期化 (決定的: 乱数の代わりに最遠点選択)
  const centers: number[][] = [samples[0].slice()];
  const minD = new Float64Array(samples.length).fill(Infinity);
  while (centers.length < Math.min(k, samples.length)) {
    const c = centers[centers.length - 1];
    let far = 0;
    let farD = -1;
    for (let s = 0; s < samples.length; s++) {
      const dr = samples[s][0] - c[0];
      const dg = samples[s][1] - c[1];
      const db = samples[s][2] - c[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < minD[s]) minD[s] = d;
      if (minD[s] > farD) {
        farD = minD[s];
        far = s;
      }
    }
    if (farD <= 0) break; // 色数がサンプルの種類より多い
    centers.push(samples[far].slice());
  }

  // Lloyd 反復
  for (let iter = 0; iter < 12; iter++) {
    const sum = centers.map(() => [0, 0, 0, 0]);
    for (const s of samples) {
      const c = nearestCenter(s[0], s[1], s[2], centers);
      sum[c][0] += s[0];
      sum[c][1] += s[1];
      sum[c][2] += s[2];
      sum[c][3]++;
    }
    let moved = false;
    for (let c = 0; c < centers.length; c++) {
      if (sum[c][3] === 0) continue;
      const nr = sum[c][0] / sum[c][3];
      const ng = sum[c][1] / sum[c][3];
      const nb = sum[c][2] / sum[c][3];
      if (Math.abs(nr - centers[c][0]) > 0.5 || Math.abs(ng - centers[c][1]) > 0.5 || Math.abs(nb - centers[c][2]) > 0.5) {
        moved = true;
      }
      centers[c] = [nr, ng, nb];
    }
    if (!moved) break;
  }

  // 近すぎるクラスタを統合 (糸の色として区別する意味がない)
  const mergeTol2 = 24 * 24;
  const merged: number[][] = [];
  for (const c of centers) {
    const dup = merged.find((m) => {
      const dr = m[0] - c[0];
      const dg = m[1] - c[1];
      const db = m[2] - c[2];
      return dr * dr + dg * dg + db * db < mergeTol2;
    });
    if (!dup) merged.push(c);
  }
  return merged;
}

function modeFilter(labels: Int32Array, w: number, h: number): void {
  const src = labels.slice();
  const counts = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (src[i] === BG) continue;
      counts.clear();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const l = src[ny * w + nx];
          counts.set(l, (counts.get(l) ?? 0) + 1);
        }
      }
      let best = src[i];
      let bestC = 0;
      for (const [l, c] of counts) {
        if (c > bestC) {
          bestC = c;
          best = l;
        }
      }
      labels[i] = best;
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
