// フェーズ9: ストローク (線) の解析と縫い方のテスト。
// 細長い領域を中心線へ畳み、細線=ランニング / 太線=サテンで縫うこと、
// 面塗りに比べ針数が大幅に減ること、線でない形は線化しないことを検証する。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import type { Region } from "../src/core/region";
import type { Point, StitchPlan } from "../src/core/types";
import { digitizeRegions } from "../src/stitch/digitize";
import { strokeStitch } from "../src/stitch/stroke";
import { analyzeStroke, looksLikeStroke } from "../src/vector/stroke";

const COLOR = { r: 20, g: 20, b: 20 };

/** 中心 (0,0)、長さ L・幅 W の水平リボン (細長い長方形) */
function ribbon(L: number, W: number): Point[] {
  return [
    { x: -L / 2, y: -W / 2 },
    { x: L / 2, y: -W / 2 },
    { x: L / 2, y: W / 2 },
    { x: -L / 2, y: W / 2 },
  ];
}

function square(half: number): Point[] {
  return [
    { x: -half, y: -half },
    { x: half, y: -half },
    { x: half, y: half },
    { x: -half, y: half },
  ];
}

function allStitches(plan: StitchPlan): Point[] {
  return plan.blocks.flatMap((b) => b.runs).flatMap((r) => r.stitches);
}

describe("analyzeStroke / looksLikeStroke", () => {
  it("細長いリボンを中心線+幅に畳む", () => {
    const region: Region = { outer: ribbon(mm(100), mm(1.2)), holes: [], color: COLOR };
    const a = analyzeStroke(region);
    expect(a).not.toBeNull();
    expect(a!.width).toBeGreaterThan(mm(0.8));
    expect(a!.width).toBeLessThan(mm(2));
    expect(a!.length).toBeGreaterThan(mm(90));
    expect(looksLikeStroke(a!)).toBe(true);
  });

  it("正方形 (細長くない) は線とみなさない", () => {
    const a = analyzeStroke({ outer: square(mm(20)), holes: [], color: COLOR });
    expect(a).not.toBeNull();
    expect(looksLikeStroke(a!)).toBe(false);
  });

  it("穴あき領域は解析対象外 (null)", () => {
    const a = analyzeStroke({ outer: square(mm(20)), holes: [square(mm(5))], color: COLOR });
    expect(a).toBeNull();
  });

  it("L字に曲がった帯でも中心線が追従する", () => {
    // 太さ 2mm 程度の L 字リボン
    const lRibbon: Point[] = [
      { x: 0, y: 0 },
      { x: mm(20), y: 0 },
      { x: mm(20), y: mm(20) },
      { x: mm(18), y: mm(20) },
      { x: mm(18), y: mm(2) },
      { x: 0, y: mm(2) },
    ];
    const a = analyzeStroke({ outer: lRibbon, holes: [], color: COLOR });
    expect(a).not.toBeNull();
    expect(looksLikeStroke(a!)).toBe(true);
    // 中心線の長さは L 字の腕の合計 (約 38mm) に近い
    expect(a!.length).toBeGreaterThan(mm(30));
  });
});

describe("strokeStitch", () => {
  it("細い線 (1.2mm) は中心線ランニングになる", () => {
    const region: Region = { outer: ribbon(mm(100), mm(1.2)), holes: [], color: COLOR };
    const res = strokeStitch(region);
    expect(res.tag).toBe("running");
    expect(res.runs.length).toBe(1);
    // 100mm をランニング長 ~2.5mm で割った程度 (≈40点)。面塗りの数百針より遥かに少ない
    expect(res.runs[0].stitches.length).toBeLessThan(80);
    expect(res.runs[0].stitches.length).toBeGreaterThan(20);
  });

  it("太い線 (4mm) は中心線サテンコラムになる", () => {
    const region: Region = { outer: ribbon(mm(60), mm(4)), holes: [], color: COLOR };
    const res = strokeStitch(region);
    expect(res.tag).toBe("satin");
    expect(res.runs.length).toBe(1);
    // サテンは左右レール交互なので偶数点
    expect(res.runs[0].stitches.length % 2).toBe(0);
  });

  it("正方形は線化せず runs 空 (フィルにフォールバック)", () => {
    const res = strokeStitch({ outer: square(mm(20)), holes: [], color: COLOR });
    expect(res.runs.length).toBe(0);
  });

  it("force=true なら細長くない帯も幅上限まで線化する", () => {
    // 縦横比の低い帯 (10mm × 4mm)
    const region: Region = { outer: ribbon(mm(10), mm(4)), holes: [], color: COLOR };
    expect(strokeStitch(region).runs.length).toBe(0); // auto では線化しない
    expect(strokeStitch(region, { force: true }).runs.length).toBe(1); // 明示なら線化
  });
});

describe("digitize 統合: auto が線画を中心線で縫い、針数が激減する", () => {
  it("細線リボンは auto で面塗りより大幅に少ない針数になる", () => {
    const region: Region = { outer: ribbon(mm(100), mm(1.2)), holes: [], color: COLOR };
    const auto = digitizeRegions([{ ...region }], "L", { fillType: "auto", underlay: ["edge"] });
    const tatami = digitizeRegions([{ ...region }], "L", { fillType: "tatami", underlay: ["edge"] });
    const autoN = allStitches(auto.plan).length;
    const tatamiN = allStitches(tatami.plan).length;
    expect(autoN).toBeGreaterThan(0);
    // 中心線ランニングは固定45°タタミ塗りの半分未満
    expect(autoN).toBeLessThan(tatamiN / 2);
  });

  it("stroke 明示でも線化され、下縫いは付かない (underlay 指定でも)", () => {
    const region: Region = { outer: ribbon(mm(80), mm(1.0)), holes: [], color: COLOR };
    const res = digitizeRegions([{ ...region, fillType: "stroke" }], "L", { underlay: ["edge"] });
    const types = new Set(res.plan.blocks.flatMap((b) => b.runs).map((r) => r.stitchType));
    expect(types.has("running")).toBe(true);
    expect(types.has("underlay")).toBe(false); // 線には下縫いを付けない
  });

  it("大きな面 (40mm円) は auto でも線化せずタタミのまま", () => {
    function circle(r: number, n = 64): Point[] {
      const pts: Point[] = [];
      for (let i = 0; i < n; i++) {
        const t = (i / n) * 2 * Math.PI;
        pts.push({ x: Math.round(r * Math.cos(t)), y: Math.round(r * Math.sin(t)) });
      }
      return pts;
    }
    const res = digitizeRegions([{ outer: circle(mm(20)), holes: [], color: COLOR }], "C", {
      fillType: "auto",
    });
    const types = new Set(res.plan.blocks.flatMap((b) => b.runs).map((r) => r.stitchType));
    expect(types.has("tatami")).toBe(true);
    expect(types.has("running")).toBe(false);
  });
});
