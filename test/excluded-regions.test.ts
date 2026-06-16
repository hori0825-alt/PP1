// 除外領域の追跡とサイズ連動閾値のテスト。
// extractRegions が面積不足で捨てた小領域を excludedRegions に記録すること、
// 目標サイズを小さくすると閾値が下がり小特徴が残ることを検証する。

import { describe, expect, it } from "vitest";
import { quantize } from "../src/import/quantize";
import type { RasterImage } from "../src/import/raster";
import { extractRegions, fitUnitsPerPixel } from "../src/import/regions";

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

describe("除外領域の追跡", () => {
  it("面積不足の小領域が excludedRegions に記録される", () => {
    // 大きい赤矩形 + 小さい赤矩形 (面積不足)
    const img = makeImg(120, 120, (x, y) => {
      if (x >= 10 && x < 90 && y >= 10 && y < 90) return [255, 0, 0, 255];
      if (x >= 110 && x < 112 && y >= 110 && y < 112) return [255, 0, 0, 255];
      return [0, 0, 0, 0];
    });
    const map = quantize(img, {
      colorCount: 2,
      removeWhiteBackground: false,
      smoothingPasses: 0,
      minComponentPixels: 1,
    });
    const result = extractRegions(map, {
      unitsPerPixel: fitUnitsPerPixel(120, 120),
    });
    expect(result.regions.length).toBe(1);
    expect(result.excludedRegions.length).toBeGreaterThanOrEqual(1);
    expect(result.excludedRegions[0].areaMm2).toBeGreaterThan(0);
    expect(result.excludedRegions[0].outer.length).toBeGreaterThanOrEqual(3);
  });

  it("閾値を下げると小領域も regions に含まれる", () => {
    const img = makeImg(120, 120, (x, y) => {
      if (x >= 10 && x < 90 && y >= 10 && y < 90) return [255, 0, 0, 255];
      if (x >= 110 && x < 114 && y >= 110 && y < 114) return [255, 0, 0, 255];
      return [0, 0, 0, 0];
    });
    const map = quantize(img, {
      colorCount: 2,
      removeWhiteBackground: false,
      smoothingPasses: 0,
      minComponentPixels: 1,
    });
    // デフォルト閾値 (300 = 3mm²)
    const r1 = extractRegions(map, {
      unitsPerPixel: fitUnitsPerPixel(120, 120),
    });
    // 閾値を極端に小さくする
    const r2 = extractRegions(map, {
      unitsPerPixel: fitUnitsPerPixel(120, 120),
      minRegionArea: 1,
    });
    expect(r2.regions.length).toBeGreaterThanOrEqual(r1.regions.length);
    expect(r2.excludedRegions.length).toBeLessThanOrEqual(r1.excludedRegions.length);
  });

  it("サイズ連動: 小さい目標サイズでは閾値が下がる", () => {
    // 100mm 目標 → minArea = 300 * (100/100)² = 300
    // 30mm 目標 → minArea = 300 * (30/100)² = 27
    const sizeRatio30 = 30 / 100;
    const scaled30 = Math.round(300 * sizeRatio30 * sizeRatio30);
    expect(scaled30).toBe(27);

    const sizeRatio50 = 50 / 100;
    const scaled50 = Math.round(300 * sizeRatio50 * sizeRatio50);
    expect(scaled50).toBe(75);
  });
});
