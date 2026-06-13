// PhotoStitch のテスト。連続性 (糸切り爆発しない) と針数制限を重視。

import { describe, expect, it } from "vitest";
import { HOOP_HALF, MAX_STITCH_LEN, mm } from "../src/core/constants";
import { countStitches, countTrims, planBounds } from "../src/core/plan";
import type { RasterImage } from "../src/import/raster";
import { generatePhotoStitch, toLuminanceGrid } from "../src/photo/photostitch";
import { validatePlan } from "../src/export/validate";

/** 左→右で黒→白のグラデーション画像 (不透明) */
function gradient(w: number, h: number): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round((x / (w - 1)) * 255);
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** 中央に暗い円、周囲白の画像 */
function darkBlob(w: number, h: number): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const r = Math.min(w, h) * 0.3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = (x - w / 2) ** 2 + (y - h / 2) ** 2 <= r * r;
      const v = inside ? 20 : 255;
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const baseOpts = {
  targetSizeMm: 80,
  colorCount: 1,
  contrast: 1,
  brightness: 0,
  removeBackground: false,
};

describe("toLuminanceGrid", () => {
  it("グレースケール化され、暗い画素ほど lum が小さい", () => {
    const grid = toLuminanceGrid(gradient(50, 10), baseOpts as never);
    const left = grid.lum[5 * 50 + 2];
    const right = grid.lum[5 * 50 + 47];
    expect(left).toBeLessThan(right);
    expect(left).toBeLessThan(0.2);
    expect(right).toBeGreaterThan(0.8);
  });

  it("コントラストを上げると明暗差が拡大する", () => {
    const normal = toLuminanceGrid(gradient(50, 10), baseOpts as never);
    const high = toLuminanceGrid(gradient(50, 10), { ...baseOpts, contrast: 2 } as never);
    const idx = 5 * 50 + 15; // 中間より暗め
    expect(high.lum[idx]).toBeLessThanOrEqual(normal.lum[idx]);
  });
});

describe("generatePhotoStitch", () => {
  it("連続性: 全 Run の隣接ステッチが最大ステッチ長以下 (Run 内に糸切りなし)", () => {
    const { plan } = generatePhotoStitch(darkBlob(120, 120), "BLOB", baseOpts);
    expect(plan.blocks.length).toBeGreaterThanOrEqual(1);
    for (const block of plan.blocks) {
      for (const run of block.runs) {
        for (let i = 1; i < run.stitches.length; i++) {
          const d = Math.hypot(
            run.stitches[i].x - run.stitches[i - 1].x,
            run.stitches[i].y - run.stitches[i - 1].y,
          );
          expect(d).toBeLessThanOrEqual(MAX_STITCH_LEN + 2);
        }
      }
    }
  });

  it("1色・凸被写体は糸切りがほぼ無い (色数-1+α 程度)", () => {
    const { plan } = generatePhotoStitch(darkBlob(120, 120), "BLOB", baseOpts);
    // 単一の塊なので各行1区間 → ボストロフェドンで近接 → 糸切り0近辺
    expect(countTrims(plan)).toBeLessThanOrEqual(2);
  });

  it("暗い側が明るい側よりステッチが密 (密度変調)", () => {
    // 左暗→右明グラデーション。左半分と右半分のステッチ数を比較
    const { plan } = generatePhotoStitch(gradient(120, 120), "GRAD", baseOpts);
    let leftCount = 0;
    let rightCount = 0;
    for (const block of plan.blocks) {
      for (const run of block.runs) {
        for (const p of run.stitches) {
          if (p.x < 0) leftCount++;
          else rightCount++;
        }
      }
    }
    // 暗い左側のほうが密
    expect(leftCount).toBeGreaterThan(rightCount);
  });

  it("枠内に収まり、検証を通る", () => {
    const { plan } = generatePhotoStitch(darkBlob(120, 120), "BLOB", baseOpts);
    const b = planBounds(plan);
    expect(b).not.toBeNull();
    if (b) {
      expect(b.minX).toBeGreaterThanOrEqual(-HOOP_HALF - 1);
      expect(b.maxX).toBeLessThanOrEqual(HOOP_HALF + 1);
    }
    expect(validatePlan(plan).ok).toBe(true);
  });

  it("針数上限を超える設定では行間隔が自動で広がり上限以下に収まる", () => {
    // 全面黒 + 細かい設定で過大にし、低い上限を課す
    const black: RasterImage = {
      width: 200,
      height: 200,
      data: new Uint8ClampedArray(200 * 200 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 0)),
    };
    const result = generatePhotoStitch(black, "BLACK", {
      ...baseOpts,
      targetSizeMm: 100,
      rowSpacingMm: 0.8,
      minStitchMm: 1.2,
      maxStitches: 4000,
    });
    expect(result.stitchCount).toBeLessThanOrEqual(4000);
    expect(result.rowSpacingMm).toBeGreaterThan(0.8); // 広げられた
    expect(result.warnings.some((w) => w.includes("行間隔"))).toBe(true);
  });

  it("colorCount=3 で輝度バンドが3色に分解される", () => {
    const { plan } = generatePhotoStitch(gradient(120, 120), "GRAD", { ...baseOpts, colorCount: 3 });
    expect(plan.blocks.length).toBe(3);
    // 各色は異なるグレー
    const grays = plan.blocks.map((b) => b.thread.r);
    expect(new Set(grays).size).toBe(3);
  });

  it("生成した plan は針数を集計できる (StitchPlan 統一)", () => {
    const { plan, stitchCount } = generatePhotoStitch(darkBlob(100, 100), "B", baseOpts);
    expect(countStitches(plan)).toBe(stitchCount);
  });
});
