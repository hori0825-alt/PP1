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

  it("指定色数より多くの色がある画像でも、パレットは指定色数を超えない", () => {
    // 6 色のベタ帯。指定 4 色なら 4 色以下に厳守される (promoteFeatures で増えない)
    const cols: [number, number, number, number][] = [
      [200, 30, 30, 255], [30, 160, 60, 255], [40, 70, 200, 255],
      [220, 200, 40, 255], [150, 40, 160, 255], [60, 60, 60, 255],
    ];
    const img = makeImage(120, 80, WHITE);
    const bandW = 120 / cols.length;
    cols.forEach((c, i) => paintRect(img, Math.round(i * bandW), 0, Math.round((i + 1) * bandW), 80, c));
    expect(quantize(img, { colorCount: 4, removeWhiteBackground: false }).palette.length).toBeLessThanOrEqual(4);
    expect(quantize(img, { colorCount: 6, removeWhiteBackground: false }).palette.length).toBeLessThanOrEqual(6);
    // 自然色数より多く指定しても増えない (6 色しかないので 10 指定でも 6 以下)
    expect(quantize(img, { colorCount: 10, removeWhiteBackground: false }).palette.length).toBeLessThanOrEqual(6);
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

  it("2色の絵は色数を多く指定しても過剰な色数にならない (過分割の抑制)", () => {
    // 黒い四角 + 白背景の実質2色画像。境界に AA の灰色ランプ (中間色) を数段置く。
    // colorCount=6 を指定しても、k-means の過分割は畳まれ 2 色に収まるべき。
    const BLACK: [number, number, number, number] = [20, 20, 20, 255];
    const img = makeImage(100, 100, WHITE);
    paintRect(img, 25, 25, 75, 75, BLACK);
    const ramp: [number, number, number, number][] = [
      [200, 200, 200, 255],
      [140, 140, 140, 255],
      [80, 80, 80, 255],
    ];
    // 上下の境界に 1px 幅ずつ中間色 (黒↔白の線分上にある灰) を置く
    ramp.forEach((g, k) => {
      for (let x = 25; x < 75; x++) {
        img.data.set(g, ((24 - k) * 100 + x) * 4);
        img.data.set(g, ((75 + k) * 100 + x) * 4);
      }
    });
    const map = quantize(img, { colorCount: 6, removeWhiteBackground: false });
    // 自然な色数は黒・白の2色。AA の灰は最寄り色へ吸収される。
    expect(map.palette.length).toBeLessThanOrEqual(2);
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
    const { regions } = extractRegions(map, opts(120));
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

  it("黒い細リング (目の輪郭) は穴を保持し領域ごと除外されない (白目が消えない)", () => {
    // 黒い円から中央をくり抜いた細いリング。穴 (白目) が保持され、
    // 穴の誤割り当てで net 面積が負になって領域が消える不具合がないこと。
    const BLACK: [number, number, number, number] = [20, 20, 20, 255];
    const img = makeImage(120, 120, WHITE);
    paintCircle(img, 60, 60, 22, BLACK);
    paintCircle(img, 60, 60, 15, WHITE); // 中央をくり抜く
    const map = quantize(img, {
      colorCount: 3,
      removeWhiteBackground: false,
      minComponentPixels: 1,
      smoothingPasses: 0,
    });
    const { regions } = extractRegions(map, opts(120));
    const black = regions.find((r) => r.color.r < 60 && r.color.g < 60 && r.color.b < 60);
    expect(black).toBeDefined();
    expect(black?.holes.length).toBeGreaterThanOrEqual(1); // 白目 = 穴が残る
  });

  it("離れた2つの同色矩形は2領域になる", () => {
    const img = makeImage(120, 120, [0, 0, 0, 0]);
    paintRect(img, 10, 10, 50, 50, BLUE);
    paintRect(img, 70, 70, 110, 110, BLUE);
    const map = quantize(img, { colorCount: 2, removeWhiteBackground: false });
    const { regions } = extractRegions(map, opts(120));
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
    const { regions } = extractRegions(map, opts(120));
    expect(regions.length).toBe(1);
  });

  it("輪郭はピクセルのギザギザより滑らかになり座標は枠内に収まる", () => {
    const img = makeImage(100, 100, [0, 0, 0, 0]);
    paintCircle(img, 50, 50, 40, GREEN);
    const map = quantize(img, { colorCount: 2, removeWhiteBackground: false });
    const { regions } = extractRegions(map, opts(100));
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
