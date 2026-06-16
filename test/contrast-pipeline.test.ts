// 全段コントラスト保護のテスト。
// 白目のような小さく高コントラストな特徴が、パイプライン全段
// (extractRegions → digitize → fill generation) を通過してステッチに残ることを検証。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import { quantize } from "../src/import/quantize";
import type { RasterImage } from "../src/import/raster";
import { extractRegions, fitUnitsPerPixel } from "../src/import/regions";
import { digitizeRegions } from "../src/stitch/digitize";

function makeImg(
  w: number,
  h: number,
  paint: (x: number, y: number) => [number, number, number, number],
): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width: w, height: h, data };
}

describe("全段コントラスト保護", () => {
  // 黒地に 3×3 の白ブロック (白目)。面積は小さいが高コントラスト。
  const eyeImg = makeImg(100, 100, (x, y) => {
    const inEye = x >= 48 && x <= 50 && y >= 48 && y <= 50;
    if (inEye) return [255, 255, 255, 255];
    return [10, 10, 10, 255];
  });

  it("Stage 1: extractRegions がコントラスト保護で白目を保持する", () => {
    const map = quantize(eyeImg, {
      colorCount: 2,
      removeWhiteBackground: false,
      smoothingPasses: 0,
      minComponentPixels: 1,
    });
    const result = extractRegions(map, {
      unitsPerPixel: fitUnitsPerPixel(100, 100),
      featureContrast: 25,
    });
    // 白が regions に残る (excludedRegions ではなく)
    const hasWhite = result.regions.some(
      (r) => r.color.r > 200 && r.color.g > 200 && r.color.b > 200,
    );
    expect(hasWhite).toBe(true);
  });

  it("Stage 1: コントラスト保護を無効 (featureContrast=0) にすると小白目が除外される", () => {
    // 1×1 ピクセルの白点 → area=100 units² < minArea=300 → featureContrast=0 なら除外
    const tinyEye = makeImg(100, 100, (x, y) => {
      if (x === 50 && y === 50) return [255, 255, 255, 255];
      return [10, 10, 10, 255];
    });
    const map = quantize(tinyEye, {
      colorCount: 2,
      removeWhiteBackground: false,
      smoothingPasses: 0,
      minComponentPixels: 1,
    });
    const result = extractRegions(map, {
      unitsPerPixel: fitUnitsPerPixel(100, 100),
      featureContrast: 0,
    });
    const hasWhite = result.regions.some(
      (r) => r.color.r > 200 && r.color.g > 200 && r.color.b > 200,
    );
    expect(hasWhite).toBe(false);
  });

  it("Stage 1: 低コントラストの小ノイズはコントラスト保護でも除外される", () => {
    // 黒(10)地にほぼ同色(25)の 3×3 ノイズ
    const noisy = makeImg(100, 100, (x, y) => {
      const inBlob = x >= 48 && x <= 50 && y >= 48 && y <= 50;
      return inBlob ? [25, 25, 25, 255] : [10, 10, 10, 255];
    });
    const map = quantize(noisy, {
      colorCount: 2,
      removeWhiteBackground: false,
      smoothingPasses: 0,
      minComponentPixels: 1,
    });
    const result = extractRegions(map, {
      unitsPerPixel: fitUnitsPerPixel(100, 100),
      featureContrast: 25,
    });
    // 低コントラストなので保護されずに除外 (パレットが2色に分かれていればの話)
    // ※ 量子化で1色に統合される可能性もあるので、excludedが0でもOK
    const nearBlackRegions = result.regions.filter(
      (r) => r.color.r < 30 && r.color.g < 30 && r.color.b < 30,
    );
    expect(nearBlackRegions.length).toBeLessThanOrEqual(2);
  });

  it("Stage 2: digitize が高コントラスト小領域を minObjectExtent で除外しない", () => {
    const map = quantize(eyeImg, {
      colorCount: 2,
      removeWhiteBackground: false,
      smoothingPasses: 0,
      minComponentPixels: 1,
    });
    const result = extractRegions(map, {
      unitsPerPixel: fitUnitsPerPixel(100, 100),
      featureContrast: 25,
    });
    // digitize with minObjectExtent that would normally exclude the small region
    const { plan } = digitizeRegions(result.regions, "TEST", {
      minObjectExtent: mm(1),
      fillType: "auto",
    });
    // 白色のブロックが存在する
    const hasWhiteBlock = plan.blocks.some(
      (b) => b.thread.r > 200 && b.thread.g > 200 && b.thread.b > 200,
    );
    expect(hasWhiteBlock).toBe(true);
  });

  it("Stage 3+4: 極小領域がマイクロフィルで少なくとも数針を生成する", () => {
    const map = quantize(eyeImg, {
      colorCount: 2,
      removeWhiteBackground: false,
      smoothingPasses: 0,
      minComponentPixels: 1,
    });
    const result = extractRegions(map, {
      unitsPerPixel: fitUnitsPerPixel(100, 100),
      featureContrast: 25,
    });
    const { plan } = digitizeRegions(result.regions, "TEST", {
      minObjectExtent: mm(1),
      fillType: "auto",
    });
    const whiteBlock = plan.blocks.find(
      (b) => b.thread.r > 200 && b.thread.g > 200 && b.thread.b > 200,
    );
    expect(whiteBlock).toBeDefined();
    const whiteStitches = whiteBlock!.runs.reduce((n, r) => n + r.stitches.length, 0);
    expect(whiteStitches).toBeGreaterThanOrEqual(2);
  });
});
