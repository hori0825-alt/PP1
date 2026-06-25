// 線画アウトライン (骨格化サテン/ビーン) のテスト。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import { countStitches } from "../src/core/plan";
import type { Point, Region } from "../src/core/types";
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
  it("中幅の線はサテン1本になり、塗り(タタミ)より大幅に少ない針数", () => {
    const region = bar(40, 1.6);
    const sk = skeletonStitch(region, {});
    expect(sk.runs.length).toBeGreaterThanOrEqual(1);
    const skStitches = sk.runs.reduce((s, r) => s + r.stitches.length, 0);
    expect(skStitches).toBeGreaterThan(0);

    // 同じ領域をタタミ塗りした場合よりはるかに少ない
    const tatami = digitizeRegions([region], "T", { fillType: "tatami" });
    const outline = digitizeRegions([region], "O", { fillType: "outline" });
    expect(countStitches(outline.plan)).toBeLessThan(countStitches(tatami.plan));
  });

  it("十字 (分岐) は複数の線パスに分解される", () => {
    const a = mm(2);
    const b = mm(15);
    const plus: Region = {
      outer: [
        { x: -a, y: -b },
        { x: a, y: -b },
        { x: a, y: -a },
        { x: b, y: -a },
        { x: b, y: a },
        { x: a, y: a },
        { x: a, y: b },
        { x: -a, y: b },
        { x: -a, y: a },
        { x: -b, y: a },
        { x: -b, y: -a },
        { x: -a, y: -a },
      ] as Point[],
      holes: [],
      color: BLACK,
    };
    const sk = skeletonStitch(plus, {});
    // 中心の分岐から4本の腕が出る
    expect(sk.runs.length).toBeGreaterThanOrEqual(3);
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
