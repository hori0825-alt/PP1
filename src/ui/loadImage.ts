// ブラウザ専用: File → RasterImage デコードアダプター。
// ピクセル処理のコア (src/import/) は DOM 非依存に保ち、Canvas 利用はここに閉じ込める。

import type { RasterImage } from "../import/raster";

/** 処理負荷と輪郭品質のバランスを取るための最大辺ピクセル数 */
const MAX_DECODE_SIZE = 600;

export async function decodeImageFile(file: File): Promise<RasterImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DECODE_SIZE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: imageData.data };
}
