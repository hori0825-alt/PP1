// 針数削減策のテスト: 密度スケール (行間隔) と 選択的下縫い (細い面は下縫い省略)。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import type { Region } from "../src/core/region";
import type { Point, StitchPlan } from "../src/core/types";
import { digitizeRegions } from "../src/stitch/digitize";

const COLOR = { r: 40, g: 40, b: 40 };

function circle(r: number, n = 64): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    pts.push({ x: Math.round(r * Math.cos(t)), y: Math.round(r * Math.sin(t)) });
  }
  return pts;
}
function ribbon(L: number, W: number): Point[] {
  return [
    { x: -L / 2, y: -W / 2 },
    { x: L / 2, y: -W / 2 },
    { x: L / 2, y: W / 2 },
    { x: -L / 2, y: W / 2 },
  ];
}
function count(plan: StitchPlan): number {
  return plan.blocks.flatMap((b) => b.runs).flatMap((r) => r.stitches).length;
}
function stitchTypes(plan: StitchPlan): Set<string | undefined> {
  return new Set(plan.blocks.flatMap((b) => b.runs).map((r) => r.stitchType));
}

describe("密度スケール (行間隔)", () => {
  const region: Region = { outer: circle(mm(20)), holes: [], color: COLOR };
  it("行間隔を粗くすると針数が減る", () => {
    const dense = digitizeRegions([{ ...region }], "C", { rowSpacing: mm(0.4), underlay: [] });
    const eco = digitizeRegions([{ ...region }], "C", { rowSpacing: mm(0.5), underlay: [] });
    expect(count(eco.plan)).toBeLessThan(count(dense.plan));
    // 0.4→0.5 は約 -20% 前後
    expect(count(eco.plan)).toBeLessThan(count(dense.plan) * 0.9);
  });
});

describe("選択的下縫い", () => {
  it("細い面 (短辺 < 2.5mm) は edge 下縫いを付けない", () => {
    const thin: Region = { outer: ribbon(mm(30), mm(2)), holes: [], color: COLOR, fillType: "tatami" };
    const res = digitizeRegions([thin], "T", { underlay: ["edge"] });
    expect(stitchTypes(res.plan).has("underlay")).toBe(false);
  });

  it("広い面には edge 下縫いが付く", () => {
    const wide: Region = { outer: circle(mm(15)), holes: [], color: COLOR, fillType: "tatami" };
    const res = digitizeRegions([wide], "W", { underlay: ["edge"] });
    expect(stitchTypes(res.plan).has("underlay")).toBe(true);
  });

  it("underlayMinExtent を 0 にすれば細い面にも下縫いが付く", () => {
    const thin: Region = { outer: ribbon(mm(30), mm(2)), holes: [], color: COLOR, fillType: "tatami" };
    const res = digitizeRegions([thin], "T", { underlay: ["edge"], underlayMinExtent: 0 });
    expect(stitchTypes(res.plan).has("underlay")).toBe(true);
  });
});

describe("サテン下縫い (中心線)", () => {
  const underlayRuns = (plan: StitchPlan): { stitches: Point[]; connection: string }[] =>
    plan.blocks.flatMap((b) => b.runs).filter((r) => r.stitchType === "underlay");
  const ulStitches = (plan: StitchPlan): number =>
    underlayRuns(plan).flatMap((r) => r.stitches).length;

  it("細いサテン列にも中心線下縫いが付く (edge 下縫いはスキップされていた範囲)", () => {
    // 短辺 3mm の列。面なら underlayMinExtent(2.5mm) は超えるが edge 下縫いは細くて潰れる。
    // サテンとして縫う場合は中心線下縫い (center) を敷く。
    const col: Region = { outer: ribbon(mm(30), mm(3)), holes: [], color: COLOR, fillType: "satin" };
    const res = digitizeRegions([col], "S", { underlay: ["edge"] });
    expect(underlayRuns(res.plan).length).toBeGreaterThanOrEqual(1);
  });

  it("下縫いなし指定ならサテン下縫いも付かない", () => {
    const col: Region = { outer: ribbon(mm(30), mm(3)), holes: [], color: COLOR, fillType: "satin" };
    const res = digitizeRegions([col], "S", { underlay: [] });
    expect(underlayRuns(res.plan).length).toBe(0);
  });

  it("下縫いと本縫いは同一オブジェクトで、間に糸切りが入らない (糸切り根絶を維持)", () => {
    const col: Region = { outer: ribbon(mm(30), mm(3)), holes: [], color: COLOR, fillType: "satin" };
    const res = digitizeRegions([col], "S", { underlay: ["edge"] });
    const block = res.plan.blocks[0];
    expect(block.runs[0].stitchType).toBe("underlay"); // 下縫いが先頭
    expect(block.runs.some((r) => r.stitchType === "satin")).toBe(true); // サテン本縫いがある
    for (let i = 1; i < block.runs.length; i++) {
      expect(block.runs[i].connection).not.toBe("trim"); // 同一面内は糸切りなし
    }
    expect(new Set(block.runs.map((r) => r.objectId)).size).toBe(1); // 全 run 同一オブジェクト
  });

  it("極細サテン (短辺 < 1.2mm) には下縫いを付けない (糸の盛りすぎ防止)", () => {
    const col: Region = { outer: ribbon(mm(40), mm(1)), holes: [], color: COLOR, fillType: "satin" };
    const res = digitizeRegions([col], "S", { underlay: ["edge"] });
    expect(underlayRuns(res.plan).length).toBe(0);
  });

  it("tatami 指定で幅のあるサテンにジグザグ下縫いが足される", () => {
    const wide = (): Region => ({ outer: ribbon(mm(30), mm(5)), holes: [], color: COLOR, fillType: "satin" });
    const center = digitizeRegions([wide()], "C", { underlay: ["edge"] }); // center のみ
    const both = digitizeRegions([wide()], "B", { underlay: ["edge", "tatami"] }); // center + zigzag
    expect(ulStitches(both.plan)).toBeGreaterThan(ulStitches(center.plan));
  });
});
