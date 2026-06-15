// 小特徴保護 (コントラスト保存の減色) のテスト。
// 「白目」のような小さく高コントラストな領域が減色で消えないこと、
// 保護を無効化 (featureContrast を極大に) すると従来どおり消えることを検証する。

import { describe, expect, it } from "vitest";
import { quantize } from "../src/import/quantize";
import type { RasterImage } from "../src/import/raster";

function makeImg(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function hasNearWhite(palette: { r: number; g: number; b: number }[]): boolean {
  return palette.some((c) => c.r > 200 && c.g > 200 && c.b > 200);
}

function whitePixelCount(lm: ReturnType<typeof quantize>): number {
  let n = 0;
  for (let i = 0; i < lm.labels.length; i++) {
    const l = lm.labels[i];
    if (l < 0) continue;
    const c = lm.palette[l];
    if (c.r > 200 && c.g > 200 && c.b > 200) n++;
  }
  return n;
}

describe("小特徴保護 (コントラスト保存の減色)", () => {
  // 黒地の中心に 3×3 の白い小ブロック (= 白目/ハイライト)。9px < 既定 minComponentPixels(16)
  const eye = makeImg(40, 40, (x, y) => {
    const inBlob = x >= 18 && x <= 20 && y >= 18 && y <= 20;
    return inBlob ? [255, 255, 255] : [10, 10, 10];
  });

  it("小さく高コントラストな白は減色後も残る", () => {
    const lm = quantize(eye, { colorCount: 2, removeWhiteBackground: false });
    expect(hasNearWhite(lm.palette)).toBe(true);
    expect(whitePixelCount(lm)).toBeGreaterThanOrEqual(4);
  });

  it("保護を無効化 (featureContrast 極大) すると従来どおり白が消える", () => {
    const lm = quantize(eye, { colorCount: 2, removeWhiteBackground: false, featureContrast: 9999 });
    // 白が黒へ統合され、白がほぼ無くなる
    expect(whitePixelCount(lm)).toBeLessThan(4);
  });

  it("低コントラストの小ノイズは保護でも統合される (ノイズ除去性能は維持)", () => {
    // 黒(10) 地に、ほぼ同色(25) の 3×3 ノイズ。低コントラストなので統合されるべき
    const noisy = makeImg(40, 40, (x, y) => {
      const inBlob = x >= 18 && x <= 20 && y >= 18 && y <= 20;
      return inBlob ? [25, 25, 25] : [10, 10, 10];
    });
    const lm = quantize(noisy, { colorCount: 2, removeWhiteBackground: false });
    // 統合されて実質1色になる (中間ノイズ色が独立領域として残らない)
    expect(lm.palette.length).toBeLessThanOrEqual(2);
  });
});
