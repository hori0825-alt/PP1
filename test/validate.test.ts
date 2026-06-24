// バリデーターのテスト: 枠外・針数超過・短ステッチ・continuous 距離の検出。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import type { StitchPlan } from "../src/core/types";
import { validatePlan } from "../src/export/validate";

const black = { r: 0, g: 0, b: 0 };

function planWith(stitches: { x: number; y: number }[]): StitchPlan {
  return {
    name: "T",
    blocks: [{ thread: black, runs: [{ stitches, connection: "trim" }] }],
  };
}

describe("validatePlan", () => {
  it("正常なプランは ok", () => {
    const result = validatePlan(
      planWith([
        { x: 0, y: 0 },
        { x: mm(3), y: 0 },
        { x: mm(6), y: 0 },
      ]),
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.stats.stitchCount).toBe(3);
  });

  it("枠外ステッチは error", () => {
    const result = validatePlan(
      planWith([
        { x: 0, y: 0 },
        { x: mm(51), y: 0 }, // 中心から 51mm = 100mm 枠の外
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "out-of-hoop" && i.severity === "error")).toBe(
      true,
    );
  });

  it("12,000 針超過は error", () => {
    const stitches: { x: number; y: number }[] = [];
    for (let i = 0; i < 12001; i++) {
      stitches.push({ x: (i % 2) * mm(3), y: Math.floor(i / 100) % 10 });
    }
    const result = validatePlan(planWith(stitches));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "stitch-count-exceeded")).toBe(true);
  });

  it("短すぎるステッチは warning (error にはしない)", () => {
    const result = validatePlan(
      planWith([
        { x: 0, y: 0 },
        { x: 2, y: 0 }, // 0.2mm
        { x: mm(3), y: 0 },
      ]),
    );
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.code === "short-stitches")).toBe(true);
    expect(result.stats.shortStitches).toBe(1);
  });

  it("continuous 接続の距離超過は warning", () => {
    const plan: StitchPlan = {
      name: "T",
      blocks: [
        {
          thread: black,
          runs: [
            { stitches: [{ x: 0, y: 0 }, { x: mm(3), y: 0 }], connection: "trim" },
            { stitches: [{ x: mm(30), y: 0 }, { x: mm(33), y: 0 }], connection: "continuous" },
          ],
        },
      ],
    };
    const result = validatePlan(plan);
    expect(result.issues.some((i) => i.code === "continuous-too-far")).toBe(true);
  });

  it("空のプランは error", () => {
    const result = validatePlan({ name: "E", blocks: [] });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "empty-plan")).toBe(true);
  });

  it("同一オブジェクト内の糸切りは error (面内糸切り検出)", () => {
    const plan: StitchPlan = {
      name: "T",
      blocks: [
        {
          thread: black,
          runs: [
            { stitches: [{ x: 0, y: 0 }, { x: mm(3), y: 0 }], connection: "trim", objectId: 1 },
            { stitches: [{ x: mm(6), y: 0 }, { x: mm(9), y: 0 }], connection: "trim", objectId: 1 },
          ],
        },
      ],
    };
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "trim-in-object" && i.severity === "error")).toBe(
      true,
    );
  });

  it("別オブジェクト間の糸切りは許容される (error にしない)", () => {
    const plan: StitchPlan = {
      name: "T",
      blocks: [
        {
          thread: black,
          runs: [
            { stitches: [{ x: 0, y: 0 }, { x: mm(3), y: 0 }], connection: "trim", objectId: 1 },
            { stitches: [{ x: mm(6), y: 0 }, { x: mm(9), y: 0 }], connection: "trim", objectId: 2 },
          ],
        },
      ],
    };
    const result = validatePlan(plan);
    expect(result.issues.some((i) => i.code === "trim-in-object")).toBe(false);
  });

  it("糸切りなしの長い渡り (jump) は warning", () => {
    const plan: StitchPlan = {
      name: "T",
      blocks: [
        {
          thread: black,
          runs: [
            { stitches: [{ x: 0, y: 0 }, { x: mm(3), y: 0 }], connection: "trim" },
            // 前 Run 終点 (3mm,0) から 15mm 離れた点へ糸を切らずに渡る
            { stitches: [{ x: mm(18), y: 0 }, { x: mm(21), y: 0 }], connection: "jump" },
          ],
        },
      ],
    };
    const result = validatePlan(plan);
    expect(result.issues.some((i) => i.code === "long-jump" && i.severity === "warning")).toBe(
      true,
    );
  });
});
