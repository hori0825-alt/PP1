// PES エクスポーターのテスト: ヘッダー構造・糸色保持・PEC ステッチのラウンドトリップ。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import { countStitches } from "../src/core/plan";
import type { StitchPlan } from "../src/core/types";
import { flattenPlan } from "../src/export/flatten";
import { writePes } from "../src/export/pes";
import { decodePes } from "./helpers";

const plan: StitchPlan = {
  name: "TEST",
  blocks: [
    {
      thread: { r: 237, g: 23, b: 31 }, // Brother #5 Red と同値
      runs: [
        {
          stitches: [
            { x: mm(-10), y: mm(-10) },
            { x: mm(-5), y: mm(-10) },
            { x: mm(-5), y: mm(-5) },
            { x: mm(-10), y: mm(-5) },
          ],
          connection: "trim",
        },
      ],
    },
    {
      thread: { r: 10, g: 85, b: 163 }, // Brother #2 Blue と同値
      runs: [
        {
          stitches: [
            { x: mm(10), y: mm(10) },
            { x: mm(15), y: mm(10) },
            { x: mm(15), y: mm(15) },
          ],
          connection: "trim",
        },
      ],
    },
  ],
};

describe("writePes", () => {
  it("マジック・PEC オフセット・ラベルが正しい", () => {
    const { data } = writePes(plan);
    const dec = decodePes(data); // マジック/LA: の検証はデコーダー内で行われる
    expect(dec.label).toBe("TEST");
  });

  it("PEC パレットで糸色が保持される (色数と色番号)", () => {
    const { data, threads } = writePes(plan);
    const dec = decodePes(data);
    expect(dec.colorCount).toBe(2);
    // 赤 → Brother #5, 青 → Brother #2
    expect(dec.paletteIndices).toEqual([5, 2]);
    expect(threads.map((t) => t.pecIndex)).toEqual([5, 2]);
  });

  it("PEC ステッチのデコード結果がプランと一致する", () => {
    const { data } = writePes(plan);
    const dec = decodePes(data);

    expect(dec.ops.filter((o) => o.kind === "colorChange")).toHaveLength(1);

    // 絶対座標を復元して全ステッチ位置を照合
    let x = 0;
    let y = 0;
    const visited: { x: number; y: number }[] = [];
    for (const op of dec.ops) {
      x += op.dx;
      y += op.dy;
      if (op.kind === "stitch") visited.push({ x, y });
    }
    for (const block of plan.blocks) {
      for (const run of block.runs) {
        for (const p of run.stitches) {
          expect(visited).toContainEqual(p);
        }
      }
    }
    // 通常ステッチ数 = flatten のステッチ数 + ジャンプ着地アンカー
    const flatStitches = flattenPlan(plan).filter((o) => o.kind === "stitch").length;
    expect(flatStitches).toBeGreaterThanOrEqual(countStitches(plan));
    expect(visited.length).toBeGreaterThanOrEqual(flatStitches);
  });

  it("長距離移動を含んでもデコード可能で座標が保たれる", () => {
    const farPlan: StitchPlan = {
      name: "FAR",
      blocks: [
        {
          thread: { r: 0, g: 0, b: 0 },
          runs: [
            { stitches: [{ x: mm(-45), y: 0 }, { x: mm(-42), y: 0 }], connection: "trim" },
            { stitches: [{ x: mm(45), y: 0 }, { x: mm(42), y: 0 }], connection: "trim" },
          ],
        },
      ],
    };
    const { data } = writePes(farPlan);
    const dec = decodePes(data);
    let x = 0;
    let y = 0;
    for (const op of dec.ops) {
      x += op.dx;
      y += op.dy;
    }
    expect(x).toBe(mm(42));
    expect(y).toBe(0);
    // trim フラグ付きの移動が含まれる
    expect(dec.ops.some((o) => o.kind === "trim")).toBe(true);
  });

  it("64色パレットにない色は最近色に割り当てられる", () => {
    const offPlan: StitchPlan = {
      name: "OFF",
      blocks: [
        {
          thread: { r: 250, g: 10, b: 20 }, // 純赤に近い
          runs: [{ stitches: [{ x: 0, y: 0 }, { x: 30, y: 0 }], connection: "trim" }],
        },
      ],
    };
    const { threads } = writePes(offPlan);
    expect(threads[0].pecIndex).toBe(5); // Brother Red
  });
});
