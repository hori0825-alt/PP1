// Phase 4: ターニングステッチ (流れる方向) のテスト。
// 2本以上の方向線から、領域を覆う1本の連続 Run を作ることを検証する。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import type { DirectionLine, Region } from "../src/core/region";
import type { Point, StitchPlan } from "../src/core/types";
import { digitizeRegions } from "../src/stitch/digitize";
import { turningFill } from "../src/stitch/turning";
import type { TatamiParams } from "../src/stitch/types";

const COLOR = { r: 50, g: 150, b: 50 };
const PARAMS: TatamiParams = { angleDeg: 0, rowSpacing: mm(0.4), stitchLength: mm(3) };

function square(half: number): Point[] {
  return [
    { x: -half, y: -half },
    { x: half, y: -half },
    { x: half, y: half },
    { x: -half, y: half },
  ];
}

function bbox(pts: Point[]): { w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { w: maxX - minX, h: maxY - minY };
}

const region: Region = { outer: square(mm(15)), holes: [], color: COLOR };
// 下側に水平・右側に垂直の方向線 → 向きが流れる
const lines: DirectionLine[] = [
  { a: { x: -mm(15), y: -mm(8) }, b: { x: mm(15), y: -mm(8) } },
  { a: { x: mm(8), y: -mm(15) }, b: { x: mm(8), y: mm(15) } },
];

describe("turningFill", () => {
  it("2本の方向線から1本の連続 Run を作り、領域を覆う", () => {
    const res = turningFill(region, PARAMS, lines);
    expect(res.runs.length).toBe(1);
    const st = res.runs[0].stitches;
    expect(st.length).toBeGreaterThan(50);
    // 全座標が有限の整数
    for (const p of st) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
    }
    // ステッチ群のバウンディングが領域の大半 (≥66%) を覆う
    const b = bbox(st);
    expect(b.w).toBeGreaterThan(mm(20));
    expect(b.h).toBeGreaterThan(mm(20));
  });

  it("方向線が1本以下なら空 (呼び出し側がタタミにフォールバック)", () => {
    expect(turningFill(region, PARAMS, [lines[0]]).runs.length).toBe(0);
    expect(turningFill(region, PARAMS, []).runs.length).toBe(0);
  });

  it("穴あき領域でもターニングが生成される (穴の周囲を避ける)", () => {
    const holed: Region = {
      outer: square(mm(15)),
      holes: [square(mm(4))],
      color: COLOR,
    };
    const res = turningFill(holed, PARAMS, lines);
    expect(res.runs.length).toBe(1);
    const st = res.runs[0].stitches;
    expect(st.length).toBeGreaterThan(20);
    // ステッチが穴の内部を避けている (穴の中心付近にステッチが密集しない)
    const holeCenter = { x: 0, y: 0 };
    const holeHalf = mm(4);
    const insideHole = st.filter(
      (p) => Math.abs(p.x - holeCenter.x) < holeHalf * 0.6 && Math.abs(p.y - holeCenter.y) < holeHalf * 0.6,
    );
    // 穴の中心60%領域にステッチがほとんどないこと (渡り以外)
    expect(insideHole.length).toBeLessThan(st.length * 0.1);
  });

  it("向きが流れる: 局所的なステッチ方向が場所によって変わる", () => {
    const st = turningFill(region, PARAMS, lines).runs[0].stitches;
    // 連続ステッチの向き (mod 180) を集め、十分な広がりがあることを確認
    const angles: number[] = [];
    for (let i = 1; i < st.length; i++) {
      const dx = st[i].x - st[i - 1].x;
      const dy = st[i].y - st[i - 1].y;
      if (Math.hypot(dx, dy) < mm(1)) continue;
      let a = (Math.atan2(dy, dx) * 180) / Math.PI;
      a = ((a % 180) + 180) % 180;
      angles.push(a);
    }
    const span = Math.max(...angles) - Math.min(...angles);
    expect(span).toBeGreaterThan(30); // 一定角タタミでは起きない広がり
  });

  it("凹面 (L字型) でもターニングが生成される", () => {
    // L-shape: 右上を切り取った形
    const lShape: Point[] = [
      { x: 0, y: 0 },
      { x: mm(20), y: 0 },
      { x: mm(20), y: mm(10) },
      { x: mm(10), y: mm(10) },
      { x: mm(10), y: mm(20) },
      { x: 0, y: mm(20) },
    ];
    const concaveRegion: Region = { outer: lShape, holes: [], color: COLOR };
    const lLines: DirectionLine[] = [
      { a: { x: 0, y: mm(5) }, b: { x: mm(20), y: mm(5) } },
      { a: { x: mm(5), y: 0 }, b: { x: mm(5), y: mm(20) } },
    ];
    const res = turningFill(concaveRegion, PARAMS, lLines);
    expect(res.runs.length).toBe(1);
    expect(res.runs[0].stitches.length).toBeGreaterThan(20);
  });

  it("複数の穴でもターニングが生成される", () => {
    const multiHole: Region = {
      outer: square(mm(20)),
      holes: [
        // 左上の穴
        [{ x: -mm(12), y: -mm(12) }, { x: -mm(6), y: -mm(12) }, { x: -mm(6), y: -mm(6) }, { x: -mm(12), y: -mm(6) }],
        // 右下の穴
        [{ x: mm(6), y: mm(6) }, { x: mm(12), y: mm(6) }, { x: mm(12), y: mm(12) }, { x: mm(6), y: mm(12) }],
      ],
      color: COLOR,
    };
    const res = turningFill(multiHole, PARAMS, lines);
    expect(res.runs.length).toBe(1);
    expect(res.runs[0].stitches.length).toBeGreaterThan(20);
  });
});

describe("digitize 統合: 方向線でターニングになる", () => {
  function allStitches(plan: StitchPlan): Point[] {
    return plan.blocks.flatMap((b) => b.runs).flatMap((r) => r.stitches);
  }
  it("方向線ありの面は方向線なし(直線タタミ)と異なる縫い目になる", () => {
    const base = digitizeRegions([{ outer: square(mm(15)), holes: [], color: COLOR }], "T", {
      fillType: "tatami",
    }).plan;
    const turned = digitizeRegions(
      [{ outer: square(mm(15)), holes: [], color: COLOR, angleLines: lines }],
      "T",
      { fillType: "tatami" },
    ).plan;
    expect(allStitches(turned).length).toBeGreaterThan(0);
    expect(JSON.stringify(allStitches(turned))).not.toBe(JSON.stringify(allStitches(base)));
  });

  it("穴あり領域 + 方向線でターニングが使われる (タタミフォールバックしない)", () => {
    const holed: Region = {
      outer: square(mm(15)),
      holes: [square(mm(4))],
      color: COLOR,
      angleLines: lines,
    };
    const result = digitizeRegions([holed], "T", { fillType: "tatami" });
    const st = allStitches(result.plan);
    expect(st.length).toBeGreaterThan(0);
    // 穴なし+方向線なし (普通のタタミ) と違う結果 = ターニングが使われた
    const plain = digitizeRegions(
      [{ outer: square(mm(15)), holes: [square(mm(4))], color: COLOR }],
      "T",
      { fillType: "tatami" },
    );
    expect(JSON.stringify(st)).not.toBe(JSON.stringify(allStitches(plain.plan)));
  });
});
