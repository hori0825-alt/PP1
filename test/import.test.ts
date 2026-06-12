// 画像読み込みパイプラインのテスト: 減色 → 領域抽出 (穴・小領域・スムージング)。

import { describe, expect, it } from "vitest";
import { signedArea } from "../src/core/geometry";
import { quantize } from "../src/import/quantize";
import type { RasterImage } from "../src/import/raster";
import { detectWhiteBackground } from "../src/import/raster";
import { extractRegions, fitUnitsPerPixel } from "../src/import/regions";

/** 単色で塗りつぶした合成画像を作る */
function makeImage(w: number, h: number, fill: [number, number, number, number]): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(fill, i * 4);
  return { width: w, height: h, data };
}

function paintRect(
  img: RasterImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgba: [number, number, number, number],
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      img.data.set(rgba, (y * img.width + x) * 4);
    }
  }
}

function paintCircle(
  img: RasterImage,
  cx: number,
  cy: number,
  r: number,
  rgba: [number, number, number, number],
): void {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
        img.data.set(rgba, (y * img.width + x) * 4);
      }
    }
  }
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const RED: [number, number, number, number] = [220, 30, 30, 255];
const BLUE: [number, number, number, number] = [30, 60, 200, 255];
const GREEN: [number, number, number, number] = [30, 160, 60, 255];

describe("quantize", () => {
  it("3色 + 白背景の画像から3色のパレットが得られる", () => {
    const img = makeImage(120, 120, WHITE);
    paintRect(img, 10, 10, 50, 50, RED);
    paintRect(img, 60, 10, 110, 50, BLUE);
    paintRect(img, 10, 60, 110, 110, GREEN);
    const map = quantize(img, { colorCount: 3, removeWhiteBackground: true });
    expect(map.palette.length).toBe(3);
    // 背景は -1 になっている
    expect(map.labels[0]).toBe(-1);
    // 各色がパレットに近い色で存在する
    const close = (c: { r: number; g: number; b: number }, t: number[]): boolean =>
      Math.abs(c.r - t[0]) < 30 && Math.abs(c.g - t[1]) < 30 && Math.abs(c.b - t[2]) < 30;
    expect(map.palette.some((c) => close(c, RED))).toBe(true);
    expect(map.palette.some((c) => close(c, BLUE))).toBe(true);
    expect(map.palette.some((c) => close(c, GREEN))).toBe(true);
  });

  it("アンチエイリアス由来の中間色が統合される", () => {
    const img = makeImage(100, 100, WHITE);
    paintRect(img, 20, 20, 80, 80, RED);
    // 境界に中間色 (AA を模擬) を1ピクセル幅で置く
    for (let x = 19; x < 81; x++) {
      img.data.set([240, 140, 140, 255], (19 * 100 + x) * 4);
      img.data.set([240, 140, 140, 255], (80 * 100 + x) * 4);
    }
    const map = quantize(img, { colorCount: 2, removeWhiteBackground: true });
    // 中間色は赤に吸収され、実質1色になる (白は背景)
    expect(map.palette.length).toBeLessThanOrEqual(2);
    // 中間色だった画素が背景か赤系のどちらかに統合されている
    const i = 19 * 100 + 50;
    if (map.labels[i] !== -1) {
      const c = map.palette[map.labels[i]];
      expect(c.r).toBeGreaterThan(150);
    }
  });

  it("透明背景は -1 として扱われる", () => {
    const img = makeImage(60, 60, [0, 0, 0, 0]);
    paintRect(img, 20, 20, 40, 40, RED);
    const map = quantize(img, { colorCount: 3, removeWhiteBackground: false });
    expect(map.labels[0]).toBe(-1);
    expect(map.labels[30 * 60 + 30]).not.toBe(-1);
  });
});

describe("detectWhiteBackground", () => {
  it("白背景を検出し、透明背景では false", () => {
    expect(detectWhiteBackground(makeImage(50, 50, WHITE))).toBe(true);
    expect(detectWhiteBackground(makeImage(50, 50, [0, 0, 0, 0]))).toBe(false);
    expect(detectWhiteBackground(makeImage(50, 50, RED))).toBe(false);
  });
});

describe("extractRegions", () => {
  const opts = (size: number): { unitsPerPixel: number } => ({
    unitsPerPixel: fitUnitsPerPixel(size, size),
  });

  it("ドーナツ形状は外周1 + 穴1 になる", () => {
    const img = makeImage(120, 120, [0, 0, 0, 0]);
    paintCircle(img, 60, 60, 45, RED);
    paintCircle(img, 60, 60, 20, [0, 0, 0, 0]); // 中心をくり抜く
    const map = quantize(img, { colorCount: 2, removeWhiteBackground: false });
    const regions = extractRegions(map, opts(120));
    expect(regions.length).toBe(1);
    expect(regions[0].holes.length).toBe(1);
    // 外周は正、穴は負の符号付き面積
    expect(signedArea(regions[0].outer)).toBeGreaterThan(0);
    expect(signedArea(regions[0].holes[0])).toBeLessThan(0);
    // 穴の面積は外周より小さい
    expect(Math.abs(signedArea(regions[0].holes[0]))).toBeLessThan(
      signedArea(regions[0].outer) / 2,
    );
  });

  it("離れた2つの同色矩形は2領域になる", () => {
    const img = makeImage(120, 120, [0, 0, 0, 0]);
    paintRect(img, 10, 10, 50, 50, BLUE);
    paintRect(img, 70, 70, 110, 110, BLUE);
    const map = quantize(img, { colorCount: 2, removeWhiteBackground: false });
    const regions = extractRegions(map, opts(120));
    expect(regions.length).toBe(2);
  });

  it("小さすぎる領域 (3mm² 未満) は除去される", () => {
    const img = makeImage(120, 120, [0, 0, 0, 0]);
    paintRect(img, 10, 10, 90, 90, RED);
    // 100mm / 120px ≈ 0.83mm/px → 2×2px ≈ 2.8mm² < 3mm²
    paintRect(img, 110, 110, 112, 112, RED);
    const map = quantize(img, {
      colorCount: 2,
      removeWhiteBackground: false,
      minComponentPixels: 1, // 量子化での統合は無効にして領域フィルタを検証
      smoothingPasses: 0,
    });
    const regions = extractRegions(map, opts(120));
    expect(regions.length).toBe(1);
  });

  it("輪郭はピクセルのギザギザより滑らかになり座標は枠内に収まる", () => {
    const img = makeImage(100, 100, [0, 0, 0, 0]);
    paintCircle(img, 50, 50, 40, GREEN);
    const map = quantize(img, { colorCount: 2, removeWhiteBackground: false });
    const regions = extractRegions(map, opts(100));
    expect(regions.length).toBe(1);
    const outer = regions[0].outer;
    // ピクセル境界そのままなら数百点。スムージング後は大幅に減る
    expect(outer.length).toBeLessThan(220);
    expect(outer.length).toBeGreaterThan(12);
    for (const p of outer) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(500);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(500);
    }
    expect(regions[0].selfIntersecting).toBeUndefined();
  });
});
