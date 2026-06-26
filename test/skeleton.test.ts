// 線画アウトライン (輪郭ビーン/三重ランニング) のテスト。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import { countStitches } from "../src/core/plan";
import type { Point } from "../src/core/types";
import type { Region } from "../src/core/region";
import { digitizeRegions } from "../src/stitch/digitize";
import { skeletonStitch } from "../src/stitch/skeleton";

const BLACK = { r: 20, g: 20, b: 20 };

function bar(lenMm: number, widthMm: number): Region {
  const hl = mm(lenMm) / 2;
  const hw = mm(widthMm) / 2;
  return {
    outer: [
      { x: -hl, y: -hw },
      { x: hl, y: -hw },
      { x: hl, y: hw },
      { x: -hl, y: hw },
    ],
    holes: [],
    color: BLACK,
  };
}

describe("skeletonStitch", () => {
  it("線は輪郭1ループ (三重) になり、塗り(タタミ)より大幅に少ない針数", () => {
    const region = bar(40, 1.6);
    const sk = skeletonStitch(region, {});
    expect(sk.runs.length).toBe(1); // 外周のみ → 1ループ
    const skStitches = sk.runs.reduce((s, r) => s + r.stitches.length, 0);
    expect(skStitches).toBeGreaterThan(0);

    // 同じ領域をタタミ塗りした場合よりはるかに少ない
    const tatami = digitizeRegions([region], "T", { fillType: "tatami" });
    const outline = digitizeRegions([region], "O", { fillType: "outline" });
    expect(countStitches(outline.plan)).toBeLessThan(countStitches(tatami.plan));
  });

  it("穴のある領域は外周 + 穴を別ループでなぞる", () => {
    const ring: Region = {
      outer: bar(40, 40).outer,
      holes: [bar(20, 20).outer],
      color: BLACK,
    };
    const sk = skeletonStitch(ring, {});
    // 外周 1 + 穴 1 = 2 ループ
    expect(sk.runs.length).toBe(2);
  });

  it("三重縫い: 1ループは輪郭を3回なぞる (周長/間隔の約3倍の針)", () => {
    const region = bar(40, 1.6);
    const sk = skeletonStitch(region, { stitchLength: mm(2) });
    const stitches = sk.runs[0].stitches.length;
    // 周長 ≈ 2*(40+1.6) = 83.2mm, 2mm間隔 ≈ 42点, 三重 ≈ 120+ 針
    expect(stitches).toBeGreaterThan(90);
  });

  it("線画モード (outline) では白い面は縫わない", () => {
    const white: Region = {
      outer: bar(40, 30).outer, // 太い白面
      holes: [],
      color: { r: 255, g: 255, b: 255 },
    };
    const out = digitizeRegions([white], "W", { fillType: "outline" });
    expect(countStitches(out.plan)).toBe(0);
  });
});
