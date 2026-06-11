// 針数上限 (digitizeWithLimit) のテスト

import { describe, expect, it } from "vitest";
import { digitize, digitizeWithLimit } from "../src/digitize/pipeline";

/** 大きな塗り領域 (高針数) のテスト画像 */
function bigImage() {
  const w = 200;
  const h = 200;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 10; y < 190; y++) {
    for (let x = 10; x < 190; x++) {
      const i = (y * w + x) * 4;
      data[i] = 200;
      data[i + 1] = 40;
      data[i + 2] = 40;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

const OPTS = {
  sizeMm: 90,
  maxColors: 2,
  autoBackground: false,
  autoThinDetect: false,
  outline: false,
  outlineSmoothing: 0,
};

describe("digitizeWithLimit (最大針数)", () => {
  it("上限なし (0) は通常の digitize と同じ結果", () => {
    const img = bigImage();
    const plain = digitize(img, OPTS);
    const limited = digitizeWithLimit(img, OPTS, 0);
    expect(limited.stats.stitches).toBe(plain.stats.stitches);
    expect(limited.autoAdjusted).toBeNull();
    expect(limited.overLimit).toBe(false);
  });

  it("上限以下ならパラメータを変えない", () => {
    const img = bigImage();
    const plain = digitize(img, OPTS);
    const limited = digitizeWithLimit(img, OPTS, plain.stats.stitches + 100);
    expect(limited.autoAdjusted).toBeNull();
    expect(limited.stats.stitches).toBe(plain.stats.stitches);
  });

  it("上限を超える場合は密度を自動調整して上限以下に収める", () => {
    const img = bigImage();
    const plain = digitize(img, OPTS);
    expect(plain.stats.stitches).toBeGreaterThan(5000); // 前提: 既定密度では超過

    const limited = digitizeWithLimit(img, OPTS, 5000);
    expect(limited.stats.stitches).toBeLessThanOrEqual(5000);
    expect(limited.overLimit).toBe(false);
    expect(limited.autoAdjusted).not.toBeNull();
    expect(limited.autoAdjusted!.rowSpacingMm).toBeGreaterThan(0.4);
  });

  it("極端に低い上限では overLimit=true を返す (デザインは生成される)", () => {
    const img = bigImage();
    const limited = digitizeWithLimit(img, OPTS, 100);
    expect(limited.overLimit).toBe(true);
    expect(limited.stats.stitches).toBeGreaterThan(100);
    // それでも密度の限界までは下げている
    expect(limited.autoAdjusted).not.toBeNull();
    expect(limited.autoAdjusted!.rowSpacingMm).toBeCloseTo(1.2, 1);
  });

  it("糸切り削減などの他の機能は維持される", () => {
    const img = bigImage();
    const limited = digitizeWithLimit(img, OPTS, 5000);
    // 単一領域なので糸切り0回・開始ジャンプ1回のまま
    expect(limited.stats.trims).toBe(0);
    expect(limited.stats.jumps).toBe(1);
  });
});
