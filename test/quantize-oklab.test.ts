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

describe("色の統合強度 (mergeTol)", () => {
  // 茶系2トーン: Oklab 距離 ≈ 7.4 (弱=7 では分離、標準=11 で統合)
  function twoTone() {
    const w = 80;
    const h = 40;
    const data = blank(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (x < 40) {
          data[i] = 150;
          data[i + 1] = 90;
          data[i + 2] = 60;
        } else {
          data[i] = 125;
          data[i + 1] = 70;
          data[i + 2] = 48;
        }
        data[i + 3] = 255;
      }
    }
    return { data, width: w, height: h };
  }

  it("標準 (6) では似た2トーン (距離7.4) が分かれたまま = 色数を増やせば色が増える", () => {
    const q = quantize(twoTone(), { ...QOPTS, mergeTol: 6 });
    expect(q.palette.length).toBe(2);
  });

  it("強 (10) では似た2トーンが1本の糸に統合される", () => {
    const q = quantize(twoTone(), { ...QOPTS, mergeTol: 10 });
    expect(q.palette.length).toBe(1);
  });

  it("色数の上限を下げると最も近いペアから強制統合される", () => {
    // 4つの異なる色 → maxColors=2 で2色に
    const w = 80;
    const h = 80;
    const data = blank(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const q = (x < 40 ? 0 : 1) + (y < 40 ? 0 : 2);
        const cols = [
          [220, 40, 40],
          [40, 90, 220],
          [250, 220, 60],
          [40, 180, 90],
        ][q];
        data[i] = cols[0];
        data[i + 1] = cols[1];
        data[i + 2] = cols[2];
        data[i + 3] = 255;
      }
    }
    const q4 = quantize({ data, width: w, height: h }, { ...QOPTS, maxColors: 4, mergeTol: 6 });
    expect(q4.palette.length).toBe(4);
    const q2 = quantize({ data, width: w, height: h }, { ...QOPTS, maxColors: 2, mergeTol: 6 });
    expect(q2.palette.length).toBeLessThanOrEqual(2);
  });

  it("強 (10) でもはっきり異なる色は維持される", () => {
    const w = 80;
    const h = 40;
    const data = blank(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        data[i] = x < 40 ? 220 : 40;
        data[i + 1] = x < 40 ? 40 : 90;
        data[i + 2] = x < 40 ? 40 : 220;
        data[i + 3] = 255;
      }
    }
    const q = quantize({ data, width: w, height: h }, { ...QOPTS, mergeTol: 10 });
    expect(q.palette.length).toBe(2);
  });
});

describe("弱い色の島の吸収 (absorbWeakIslands)", () => {
  it("片方の色に囲まれた中間色の島は、囲み色とほぼ同等に近ければ吸収される", () => {
    // 赤の面 + 離れた場所に青の面 (青クラスタを作るため)。
    // 赤の中に「赤と青の中間だがわずかに青寄り」の小さな島を置く
    const w = 120;
    const h = 120;
    const data = blank(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (y < 50) {
          data[i] = 200;
          data[i + 1] = 60;
          data[i + 2] = 60; // 赤
        } else {
          data[i] = 60;
          data[i + 1] = 60;
          data[i + 2] = 200; // 青
        }
        data[i + 3] = 255;
      }
    }
    // 赤の領域内の小島 (赤と青のほぼ中間色、わずかに青寄り)。
    // maxColors=2 なので島はどちらかのクラスタに割り当てられる
    for (let y = 15; y < 23; y++) {
      for (let x = 50; x < 58; x++) {
        const i = (y * w + x) * 4;
        data[i] = 132;
        data[i + 1] = 60;
        data[i + 2] = 132;
      }
    }
    const q = quantize({ data, width: w, height: h }, { ...QOPTS, maxColors: 2, mergeTol: 6 });
    // 中間色の島は赤に吸収され、赤の領域はすべて同一ラベル
    const labelAt = (x: number, y: number) => q.labels[y * w + x];
    const redLabel = labelAt(10, 10);
    expect(labelAt(54, 18)).toBe(redLabel);
  });

  it("色が明確に異なる小領域 (瞳のような) は吸収されない", () => {
    const w = 120;
    const h = 120;
    const data = blank(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        data[i] = 250;
        data[i + 1] = 220;
        data[i + 2] = 200; // 肌色
        data[i + 3] = 255;
      }
    }
    // 黒い瞳 (10x10)
    for (let y = 55; y < 65; y++) {
      for (let x = 55; x < 65; x++) {
        const i = (y * w + x) * 4;
        data[i] = 20;
        data[i + 1] = 20;
        data[i + 2] = 25;
      }
    }
    const q = quantize({ data, width: w, height: h }, { ...QOPTS, maxColors: 4, mergeTol: 6 });
    expect(q.palette.length).toBe(2); // 肌 + 黒が残る
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
