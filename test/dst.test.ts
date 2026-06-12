// DST エクスポーターのテスト: レコードエンコードのラウンドトリップと実出力の検証。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import type { StitchPlan } from "../src/core/types";
import { encodeDstRecord, writeDst } from "../src/export/dst";
import { decodeDst, decodeDstRecord } from "./helpers";

const red = { r: 255, g: 0, b: 0 };
const blue = { r: 0, g: 0, b: 255 };

describe("encodeDstRecord", () => {
  it("全範囲 (-121..121) でエンコード/デコードが一致する", () => {
    for (let v = -121; v <= 121; v++) {
      const [a0, a1, a2] = encodeDstRecord(v, 0, "stitch");
      const dx = decodeDstRecord(a0, a1, a2);
      expect(dx).toEqual({ dx: v, dy: 0, kind: "stitch" });

      const [b0, b1, b2] = encodeDstRecord(0, v, "stitch");
      const dy = decodeDstRecord(b0, b1, b2);
      expect(dy).toEqual({ dx: 0, dy: v, kind: "stitch" });
    }
  });

  it("dx/dy 同時指定とジャンプ・色替えフラグが保持される", () => {
    const pairs: [number, number][] = [
      [121, -121],
      [-73, 41],
      [1, -1],
      [0, 0],
      [100, 100],
    ];
    for (const [dx, dy] of pairs) {
      expect(decodeDstRecord(...encodeDstRecord(dx, dy, "stitch"))).toEqual({
        dx,
        dy,
        kind: "stitch",
      });
      expect(decodeDstRecord(...encodeDstRecord(dx, dy, "jump"))).toEqual({
        dx,
        dy,
        kind: "jump",
      });
    }
    expect(decodeDstRecord(...encodeDstRecord(0, 0, "colorChange")).kind).toBe("colorChange");
  });

  it("範囲外は例外を投げる", () => {
    expect(() => encodeDstRecord(122, 0, "stitch")).toThrow();
    expect(() => encodeDstRecord(0, -122, "stitch")).toThrow();
  });
});

describe("writeDst", () => {
  const plan: StitchPlan = {
    name: "TEST",
    blocks: [
      {
        thread: red,
        runs: [
          {
            stitches: [
              { x: mm(-10), y: mm(-10) },
              { x: mm(-5), y: mm(-10) },
              { x: mm(-5), y: mm(-5) },
            ],
            connection: "trim",
          },
        ],
      },
      {
        thread: blue,
        runs: [
          {
            stitches: [
              { x: mm(10), y: mm(10) },
              { x: mm(15), y: mm(10) },
            ],
            connection: "trim",
          },
        ],
      },
    ],
  };

  it("ヘッダーの ST/CO/ラベルとレコード数が一致する", () => {
    const data = writeDst(plan);
    const dec = decodeDst(data);
    expect(dec.label).toBe("TEST");
    expect(dec.records.length).toBe(dec.stitchCount);
    expect(dec.colorChangeCount).toBe(1);
    expect(dec.records.filter((r) => r.kind === "colorChange")).toHaveLength(1);
    // サイズ = 512 ヘッダー + 3×レコード + 3 終端
    expect(data.length).toBe(512 + dec.records.length * 3 + 3);
    expect(data[data.length - 1]).toBe(0xf3);
  });

  it("デコードした絶対座標がプランの座標と一致する (Y は反転)", () => {
    const data = writeDst(plan);
    const dec = decodeDst(data);
    let x = 0;
    let y = 0;
    const visited: { x: number; y: number }[] = [];
    for (const r of dec.records) {
      x += r.dx;
      y += r.dy;
      if (r.kind === "stitch") visited.push({ x, y: -y }); // 内部座標系に戻す
    }
    for (const block of plan.blocks) {
      for (const run of block.runs) {
        for (const p of run.stitches) {
          expect(visited).toContainEqual(p);
        }
      }
    }
  });

  it("遠距離の trim 接続でも全レコードが ±121 に収まる", () => {
    const farPlan: StitchPlan = {
      name: "FAR",
      blocks: [
        {
          thread: red,
          runs: [
            { stitches: [{ x: mm(-45), y: mm(-45) }, { x: mm(-42), y: mm(-45) }], connection: "trim" },
            { stitches: [{ x: mm(45), y: mm(45) }, { x: mm(42), y: mm(45) }], connection: "trim" },
          ],
        },
      ],
    };
    // writeDst 内の encodeDstRecord が範囲外なら例外になるため、正常終了自体が検証
    const data = writeDst(farPlan);
    const dec = decodeDst(data);
    // trim エミュレーション (3連ジャンプ) + 90mm 移動の分割ジャンプ
    expect(dec.records.filter((r) => r.kind === "jump").length).toBeGreaterThanOrEqual(3 + 8);
    // 終点の絶対座標が正しい
    let x = 0;
    let y = 0;
    for (const r of dec.records) {
      x += r.dx;
      y += r.dy;
    }
    expect(x).toBe(mm(42));
    expect(-y).toBe(mm(45));
  });
});
