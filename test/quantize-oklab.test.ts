// Oklab 減色: アンチエイリアス中間色の排除と微小クラスタ吸収のテスト

import { describe, expect, it } from "vitest";
import { quantize, srgbToOklab } from "../src/digitize/quantize";
import { digitize } from "../src/digitize/pipeline";

const QOPTS = {
  maxColors: 8,
  alphaThreshold: 128,
  autoBackground: false,
  bgTolerance: 40,
  minRegionPx: 4,
};

function blank(w: number, h: number) {
  return new Uint8ClampedArray(w * h * 4);
}

describe("srgbToOklab", () => {
  it("白黒の L 値が 0〜100 スケール", () => {
    const [lw] = srgbToOklab(255, 255, 255);
    const [lb] = srgbToOklab(0, 0, 0);
    expect(lw).toBeCloseTo(100, 0);
    expect(lb).toBeCloseTo(0, 0);
  });
});

describe("quantize (Oklab + エッジ除外)", () => {
  it("アンチエイリアスの中間色は独立した色として認識されない", () => {
    // 左=黒、右=白、境界に4pxのグラデーション帯
    const w = 100;
    const h = 60;
    const data = blank(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let v: number;
        if (x < 48) v = 20;
        else if (x > 52) v = 240;
        else v = 20 + ((x - 48) / 4) * 220; // 中間色の帯
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    const q = quantize({ data, width: w, height: h }, QOPTS);
    expect(q.palette.length).toBe(2); // 黒と白のみ。グレーの糸は作られない
  });

  it("前景の1%未満の微小な色は最寄りの色へ吸収される", () => {
    const w = 100;
    const h = 100;
    const data = blank(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // ほぼ全面が赤、中央に 5x5 のオレンジ (0.25%)
        const isAccent = x >= 48 && x < 53 && y >= 48 && y < 53;
        data[i] = isAccent ? 255 : 210;
        data[i + 1] = isAccent ? 120 : 30;
        data[i + 2] = 30;
        data[i + 3] = 255;
      }
    }
    const q = quantize({ data, width: w, height: h }, QOPTS);
    expect(q.palette.length).toBe(1);
  });

  it("はっきり異なる色は維持される", () => {
    const w = 90;
    const h = 60;
    const data = blank(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (x < 30) {
          data[i] = 220;
          data[i + 1] = 40;
          data[i + 2] = 40;
        } else if (x < 60) {
          data[i] = 40;
          data[i + 1] = 90;
          data[i + 2] = 220;
        } else {
          data[i] = 250;
          data[i + 1] = 220;
          data[i + 2] = 60;
        }
        data[i + 3] = 255;
      }
    }
    const q = quantize({ data, width: w, height: h }, QOPTS);
    expect(q.palette.length).toBe(3);
  });

  it("似たトーンの色 (知覚的に近い) は1本の糸に統合される", () => {
    const w = 80;
    const h = 40;
    const data = blank(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // ほぼ同じ赤系の2トーン
        data[i] = x < 40 ? 210 : 220;
        data[i + 1] = x < 40 ? 60 : 70;
        data[i + 2] = x < 40 ? 55 : 60;
        data[i + 3] = 255;
      }
    }
    const q = quantize({ data, width: w, height: h }, QOPTS);
    expect(q.palette.length).toBe(1);
  });
});

describe("pipeline: 微小 run の除去", () => {
  it("アンチエイリアス由来のゴミがないので糸切りが増えない", () => {
    // 黒線 + 白地 + アンチエイリアスのある画像 (実画像の縮図)
    const w = 200;
    const h = 200;
    const data = blank(w, h);
    const set = (x: number, y: number, v: number) => {
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, 245);
    // 黒い線 (アンチエイリアスっぽい縁つき)
    for (let x = 30; x <= 170; x++) {
      set(x, 99, 130); // 中間色の縁
      set(x, 100, 20);
      set(x, 101, 20);
      set(x, 102, 130);
    }
    const { stats, quant } = digitize(
      { data, width: w, height: h },
      { sizeMm: 60, maxColors: 6, autoBackground: false, outline: false },
    );
    expect(quant.palette.length).toBe(2); // 白と黒のみ (中間グレーなし)
    expect(stats.trims).toBeLessThanOrEqual(1); // 白面と黒線の色替え分のみ
  });
});
