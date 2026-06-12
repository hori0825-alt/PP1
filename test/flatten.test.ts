// flattenPlan のテスト: 接続属性の忠実な変換と、Run 内連続性の保証。

import { describe, expect, it } from "vitest";
import { MAX_STITCH_LEN, mm } from "../src/core/constants";
import type { StitchPlan } from "../src/core/types";
import { flattenPlan } from "../src/export/flatten";

const red = { r: 255, g: 0, b: 0 };
const blue = { r: 0, g: 0, b: 255 };

function simplePlan(): StitchPlan {
  return {
    name: "T",
    blocks: [
      {
        thread: red,
        runs: [
          {
            stitches: [
              { x: 0, y: 0 },
              { x: 30, y: 0 },
              { x: 60, y: 0 },
            ],
            connection: "trim",
          },
        ],
      },
    ],
  };
}

describe("flattenPlan", () => {
  it("Run 内はステッチのみで構成される (途中にジャンプ・糸切りが入らない)", () => {
    const ops = flattenPlan(simplePlan());
    const firstStitch = ops.findIndex((o) => o.kind === "stitch");
    const lastStitch = ops.length - 1 - [...ops].reverse().findIndex((o) => o.kind === "stitch");
    for (let i = firstStitch; i <= lastStitch; i++) {
      expect(ops[i].kind).toBe("stitch");
    }
    expect(ops[ops.length - 1].kind).toBe("end");
  });

  it("continuous 接続は通常ステッチで移動する", () => {
    const plan: StitchPlan = {
      name: "T",
      blocks: [
        {
          thread: red,
          runs: [
            { stitches: [{ x: 0, y: 0 }, { x: 30, y: 0 }], connection: "trim" },
            { stitches: [{ x: 50, y: 0 }, { x: 80, y: 0 }], connection: "continuous" },
          ],
        },
      ],
    };
    const ops = flattenPlan(plan);
    expect(ops.filter((o) => o.kind === "trim")).toHaveLength(0);
    // 最初の位置合わせ以外にジャンプがない
    const jumpsAfterStart = ops.slice(ops.findIndex((o) => o.kind === "stitch"));
    expect(jumpsAfterStart.filter((o) => o.kind === "jump")).toHaveLength(0);
  });

  it("trim 接続は trim → jump の順で出力される", () => {
    const plan: StitchPlan = {
      name: "T",
      blocks: [
        {
          thread: red,
          runs: [
            { stitches: [{ x: 0, y: 0 }, { x: 30, y: 0 }], connection: "trim" },
            { stitches: [{ x: mm(50), y: 0 }, { x: mm(53), y: 0 }], connection: "trim" },
          ],
        },
      ],
    };
    const ops = flattenPlan(plan);
    const trimIdx = ops.findIndex((o) => o.kind === "trim");
    expect(trimIdx).toBeGreaterThan(0);
    expect(ops[trimIdx + 1].kind).toBe("jump");
  });

  it("ブロック間は colorChange + jump になり trim 命令は出ない", () => {
    const plan: StitchPlan = {
      name: "T",
      blocks: [
        { thread: red, runs: [{ stitches: [{ x: 0, y: 0 }, { x: 30, y: 0 }], connection: "trim" }] },
        { thread: blue, runs: [{ stitches: [{ x: mm(40), y: 0 }, { x: mm(43), y: 0 }], connection: "trim" }] },
      ],
    };
    const ops = flattenPlan(plan);
    const ccIdx = ops.findIndex((o) => o.kind === "colorChange");
    expect(ccIdx).toBeGreaterThan(0);
    expect(ops[ccIdx + 1].kind).toBe("jump");
    expect(ops.filter((o) => o.kind === "trim")).toHaveLength(0);
    expect(ops.filter((o) => o.kind === "colorChange")).toHaveLength(1);
  });

  it("長距離ジャンプは MAX_STITCH_LEN 以下に分割される", () => {
    const plan: StitchPlan = {
      name: "T",
      blocks: [
        {
          thread: red,
          runs: [
            { stitches: [{ x: 0, y: 0 }, { x: 30, y: 0 }], connection: "trim" },
            { stitches: [{ x: mm(50), y: mm(40) }, { x: mm(53), y: mm(40) }], connection: "trim" },
          ],
        },
      ],
    };
    const ops = flattenPlan(plan);
    let prev = { x: 0, y: 0 };
    for (const op of ops) {
      if (op.kind === "stitch" || op.kind === "jump") {
        expect(Math.abs(op.x - prev.x)).toBeLessThanOrEqual(MAX_STITCH_LEN);
        expect(Math.abs(op.y - prev.y)).toBeLessThanOrEqual(MAX_STITCH_LEN);
        prev = { x: op.x, y: op.y };
      }
    }
    // 50mm の移動には複数ジャンプが必要
    expect(ops.filter((o) => o.kind === "jump").length).toBeGreaterThanOrEqual(4);
  });

  it("Run 内の長すぎる区間は糸を切らず中間ステッチで分割される", () => {
    const plan: StitchPlan = {
      name: "T",
      blocks: [
        {
          thread: red,
          runs: [{ stitches: [{ x: 0, y: 0 }, { x: mm(30), y: 0 }], connection: "trim" }],
        },
      ],
    };
    const ops = flattenPlan(plan);
    expect(ops.filter((o) => o.kind === "jump" && o.x > 0)).toHaveLength(0);
    const stitches = ops.filter((o) => o.kind === "stitch");
    // 30mm を 12.1mm 以下で進むには 3 分割以上
    expect(stitches.length).toBeGreaterThanOrEqual(4);
  });
});
