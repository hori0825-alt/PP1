// Phase 6: PES/DST ラウンドトリップ最終検証 + エッジケース。
// サンプルを生成 → 出力 → 自前リーダーで読み戻し、針位置・色・色替え数が
// 一致することを確認する。実機に出す前のソフト側の最終ゲート。

import { describe, expect, it } from "vitest";
import { HOOP_HALF, mm } from "../src/core/constants";
import { countColorChanges, countStitches, countTrims, planBounds } from "../src/core/plan";
import type { StitchPlan } from "../src/core/types";
import { decodeDst, decodePes, dstStitchPoints, pesStitchPoints } from "../src/export/decode";
import { writeDst } from "../src/export/dst";
import { writePes } from "../src/export/pes";
import { validatePlan } from "../src/export/validate";
import { allSamples } from "../src/samples/designs";
import { digitizeRegions } from "../src/stitch/digitize";
import type { Point } from "../src/core/types";

// -0 は 0 と同一視する (Math.round が -0 を生むため。ファイルとしては正しく往復する)
function key(p: Point): string {
  return `${p.x === 0 ? 0 : p.x},${p.y === 0 ? 0 : p.y}`;
}
function pointSet(pts: Point[]): Set<string> {
  return new Set(pts.map(key));
}
function planContainsAllIn(plan: StitchPlan, decoded: Point[]): void {
  const set = pointSet(decoded);
  for (const block of plan.blocks) {
    for (const run of block.runs) {
      for (const p of run.stitches) {
        expect(set.has(key(p))).toBe(true);
      }
    }
  }
}

describe("サンプルデザインのラウンドトリップ", () => {
  for (const sample of allSamples()) {
    describe(sample.id, () => {
      const { plan } = digitizeRegions(sample.regions, sample.name, sample.options);

      it("検証を通り、期待どおりの色替え・糸切り回数になる", () => {
        const v = validatePlan(plan);
        expect(v.ok).toBe(true);
        expect(countColorChanges(plan)).toBe(sample.expect.colorChanges);
        expect(countTrims(plan)).toBeLessThanOrEqual(sample.expect.maxTrims);
      });

      it("100mm 枠内・12,000 針以内", () => {
        const b = planBounds(plan);
        expect(b).not.toBeNull();
        if (b) {
          expect(b.minX).toBeGreaterThanOrEqual(-HOOP_HALF);
          expect(b.maxX).toBeLessThanOrEqual(HOOP_HALF);
          expect(b.minY).toBeGreaterThanOrEqual(-HOOP_HALF);
          expect(b.maxY).toBeLessThanOrEqual(HOOP_HALF);
        }
        expect(countStitches(plan)).toBeLessThanOrEqual(12000);
      });

      it("PES を読み戻すと色数・色替え・全ステッチ位置が一致する", () => {
        const { data, threads } = writePes(plan);
        const dec = decodePes(data);
        expect(dec.colorCount).toBe(threads.length);
        expect(dec.ops.filter((o) => o.kind === "colorChange").length).toBe(
          sample.expect.colorChanges,
        );
        // 全ての元ステッチ点がデコード結果に含まれる
        planContainsAllIn(plan, pesStitchPoints(dec));
      });

      it("DST を読み戻すと色替え・全ステッチ位置が一致する", () => {
        const data = writeDst(plan);
        const dec = decodeDst(data);
        expect(dec.records.filter((r) => r.kind === "colorChange").length).toBe(
          sample.expect.colorChanges,
        );
        planContainsAllIn(plan, dstStitchPoints(dec));
      });
    });
  }
});

describe("エッジケース", () => {
  const red = { r: 220, g: 30, b: 30 };

  it("1針だけの Run を含むプランが出力できる", () => {
    const plan: StitchPlan = {
      name: "ONE",
      blocks: [
        {
          thread: red,
          runs: [
            { stitches: [{ x: 0, y: 0 }], connection: "trim" },
            { stitches: [{ x: mm(5), y: 0 }, { x: mm(8), y: 0 }], connection: "continuous" },
          ],
        },
      ],
    };
    expect(() => writePes(plan)).not.toThrow();
    expect(() => writeDst(plan)).not.toThrow();
    const dec = decodePes(writePes(plan).data);
    expect(dec.colorCount).toBe(1);
  });

  it("空の ColorBlock があってもクラッシュしない", () => {
    const plan: StitchPlan = {
      name: "EMPTY",
      blocks: [
        { thread: red, runs: [] },
        { thread: { r: 0, g: 0, b: 255 }, runs: [{ stitches: [{ x: 0, y: 0 }, { x: mm(10), y: 0 }], connection: "trim" }] },
      ],
    };
    expect(() => writePes(plan)).not.toThrow();
    const dec = decodePes(writePes(plan).data);
    // 空ブロックは色替えを生まない (実ブロックは1つ)
    expect(dec.ops.filter((o) => o.kind === "colorChange").length).toBe(0);
  });

  it("枠ぴったり (±50mm) のデザインが枠内判定される", () => {
    const plan: StitchPlan = {
      name: "EDGE",
      blocks: [
        {
          thread: red,
          runs: [
            {
              stitches: [
                { x: -HOOP_HALF, y: -HOOP_HALF },
                { x: HOOP_HALF, y: -HOOP_HALF },
                { x: HOOP_HALF, y: HOOP_HALF },
                { x: -HOOP_HALF, y: HOOP_HALF },
              ],
              connection: "trim",
            },
          ],
        },
      ],
    };
    expect(validatePlan(plan).ok).toBe(true);
  });

  it("完全に空のプランは検証エラー", () => {
    expect(validatePlan({ name: "VOID", blocks: [] }).ok).toBe(false);
  });
});
