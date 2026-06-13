// ラスタ画像の表現と前処理 (DOM 非依存)。
// ブラウザ側では Canvas で RGBA にデコードして RasterImage に詰める。

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA 順、width*height*4 バイト */
  data: Uint8ClampedArray;
}

/** アルファ値がこの値未満のピクセルは「領域外 (透明)」として扱う */
export const ALPHA_THRESHOLD = 128;

/**
 * ラベルマップ。各ピクセルにパレットインデックス、背景は -1。
 */
export interface LabelMap {
  width: number;
  height: number;
  labels: Int16Array;
  palette: { r: number; g: number; b: number }[];
}

/**
 * 四隅のサンプリングで白背景かどうかを推定する。
 * 透明背景の画像では false (透明が背景として優先される)。
 */
export function detectWhiteBackground(img: RasterImage, threshold = 240): boolean {
  const { width: w, height: h, data } = img;
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4];
  let white = 0;
  for (const off of corners) {
    const [r, g, b, a] = [data[off], data[off + 1], data[off + 2], data[off + 3]];
    if (a < ALPHA_THRESHOLD) return false;
    if (r >= threshold && g >= threshold && b >= threshold) white++;
  }
  return white >= 3;
}

/**
 * 背景マスクを作る (true = 背景)。
 * - 透明ピクセルは常に背景
 * - removeWhite 指定時は、画像の縁に接する白連結成分のみ背景にする
 *   (デザイン内部の白は残す)
 */
export function backgroundMask(img: RasterImage, removeWhite: boolean, whiteThreshold = 240): Uint8Array {
  const { width: w, height: h, data } = img;
  const bg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < ALPHA_THRESHOLD) bg[i] = 1;
  }
  if (!removeWhite) return bg;

  const isWhite = (i: number): boolean =>
    data[i * 4 + 3] >= ALPHA_THRESHOLD &&
    data[i * 4] >= whiteThreshold &&
    data[i * 4 + 1] >= whiteThreshold &&
    data[i * 4 + 2] >= whiteThreshold;

  // 縁の白ピクセルから BFS で白背景を広げる
  const queue: number[] = [];
  const visit = (i: number): void => {
    if (bg[i] === 0 && isWhite(i)) {
      bg[i] = 1;
      queue.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    visit(x);
    visit((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    visit(y * w);
    visit(y * w + w - 1);
  }
  while (queue.length > 0) {
    const i = queue.pop() as number;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (y > 0) visit(i - w);
    if (y < h - 1) visit(i + w);
  }
  return bg;
}
