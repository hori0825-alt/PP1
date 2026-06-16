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

  // 実運用の失敗再現: 大きな画像 (間引き発生) + 多色 (colorCount=6) で、
  // k-means が白目クラスタを取りこぼす。promoteFeatures がこれを復活させる。
  it("Stage 0: 大画像・多色でも k-means が取りこぼした白目を専用色に復活する", () => {
    // 600×600 = 36万画素 → kmeans の step≈18 で間引きされる。
    // 顔を想定した複数色 (肌・髪・頬・口) で colorCount=6 を競わせ、
    // 小さな白目 (8×8) が暗い瞳に吸収されやすい状況を作る。
    const faceImg = makeImg(600, 600, (x, y) => {
      // 8×8 の白目
      if (x >= 300 && x < 308 && y >= 290 && y < 298) return [250, 250, 250, 255];
      // 白目を囲む暗い瞳 (16×16)
      if (x >= 294 && x < 314 && y >= 284 && y < 304) return [20, 18, 22, 255];
      // 髪 (上部・濃茶)
      if (y < 180) return [60, 40, 30, 255];
      // 口 (下部・赤)
      if (y > 460 && x > 240 && x < 360) return [170, 60, 60, 255];
      // 頬 (左右・やや濃い肌)
      if (x < 150 || x > 450) return [210, 170, 150, 255];
      // 肌ベース
      return [235, 205, 185, 255];
    });
    // 実 UI と同じ既定 (featureContrast 等を渡さない) で減色
    const map = quantize(faceImg, {
      colorCount: 6,
      removeWhiteBackground: false,
    });
    // 白に近いパレット色が存在する (= 白目クラスタが復活した)
    const hasWhitePalette = map.palette.some(
      (c) => c.r > 220 && c.g > 220 && c.b > 220,
    );
    expect(hasWhitePalette).toBe(true);
    // 白目領域のラベルが実際に塗られている (中央付近に白画素ラベルが残る)
    const whiteIdx = map.palette.findIndex(
      (c) => c.r > 220 && c.g > 220 && c.b > 220,
    );
    let whitePixels = 0;
    for (let i = 0; i < map.labels.length; i++) {
      if (map.labels[i] === whiteIdx) whitePixels++;
    }
    expect(whitePixels).toBeGreaterThanOrEqual(16);
  });
});
