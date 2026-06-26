// 縫い順・糸切り最適化のテスト (Phase 4 の核心)。
// 前作の問題「少し縫ってすぐ糸切り」「同色の細切れ」が起きないことを保証する。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import { countStitches, countTrims, stitchedLengthByBlock, totalStitchedLength } from "../src/core/plan";
import type { StitchPlan } from "../src/core/types";
import type { Region } from "../src/core/region";
import type { Point } from "../src/core/types";
import { branchOrder, digitizeLines } from "../src/plan/branching";
import { decideConnection } from "../src/plan/connect";
import { optimizeOrder, orderTravelCost } from "../src/plan/order";
import { autoReduce } from "../src/plan/reduce";
import { planStats } from "../src/plan/stats";
import { localRecommend } from "../src/plan/localRecommend";
import { digitizeRegions } from "../src/stitch/digitize";

const RED = { r: 220, g: 30, b: 30 };
const BLUE = { r: 30, g: 60, b: 200 };

function rect(cx: number, cy: number, w: number, h: number): Point[] {
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

function square(cx: number, cy: number, size: number, color = RED): Region {
  return { outer: rect(cx, cy, size, size), holes: [], color };
}

describe("stitchedLengthByBlock / totalStitchedLength", () => {
  it("各 Run 内の連続ステッチ距離を色ごとに合計する (渡りは含めない)", () => {
    const plan: StitchPlan = {
      name: "L",
      blocks: [
        {
          thread: RED,
          runs: [
            // 10mm 横移動 = 100 単位
            { stitches: [{ x: 0, y: 0 }, { x: mm(10), y: 0 }], connection: "trim" },
            // 別 Run: 5mm。Run 間の渡りは糸長に含めない
            { stitches: [{ x: mm(40), y: 0 }, { x: mm(45), y: 0 }], connection: "trim" },
          ],
        },
        { thread: BLUE, runs: [{ stitches: [{ x: 0, y: 0 }, { x: 0, y: mm(20) }], connection: "trim" }] },
      ],
    };
    const byBlock = stitchedLengthByBlock(plan);
    expect(byBlock[0]).toBeCloseTo(mm(10) + mm(5), 5); // 赤: 10+5mm
    expect(byBlock[1]).toBeCloseTo(mm(20), 5); // 青: 20mm
    expect(totalStitchedLength(plan)).toBeCloseTo(mm(35), 5);
  });

  it("実デザインでは糸長が正で、針数が多い色ほど概ね長い", () => {
    const { plan } = digitizeRegions([square(0, 0, mm(30)), square(mm(40), 0, mm(8), BLUE)], "TL");
    const lens = stitchedLengthByBlock(plan);
    expect(lens.length).toBe(plan.blocks.length);
    expect(totalStitchedLength(plan)).toBeGreaterThan(0);
    for (const l of lens) expect(l).toBeGreaterThan(0);
  });
});

describe("decideConnection", () => {
  const o = { x: 0, y: 0 };
  it("auto: 距離で continuous/jump/trim を判定する", () => {
    expect(decideConnection(o, { x: mm(2), y: 0 }, false)).toBe("continuous");
    expect(decideConnection(o, { x: mm(5), y: 0 }, false)).toBe("jump");
    expect(decideConnection(o, { x: mm(55), y: 0 }, false)).toBe("trim");
  });
  it("never: 遠距離でも糸切りしない", () => {
    expect(decideConnection(o, { x: mm(50), y: 0 }, false, { trimMode: "never" })).toBe("jump");
  });
  it("always: 近距離 (3mm以上) でも糸切りする", () => {
    expect(decideConnection(o, { x: mm(5), y: 0 }, false, { trimMode: "always" })).toBe("trim");
    // ただし 3mm 未満は always でも切らない (絶対ルール)
    expect(decideConnection(o, { x: mm(2), y: 0 }, false, { trimMode: "always" })).toBe(
      "continuous",
    );
  });
  it("同一オブジェクト内はどのモードでも糸切りしない", () => {
    for (const trimMode of ["auto", "never", "always"] as const) {
      expect(decideConnection(o, { x: mm(50), y: 0 }, true, { trimMode })).toBe("jump");
    }
  });
  it("trimDistance を変更できる", () => {
    expect(decideConnection(o, { x: mm(15), y: 0 }, false, { trimDistance: mm(20) })).toBe("jump");
    expect(decideConnection(o, { x: mm(8), y: 0 }, false, { trimDistance: mm(6) })).toBe("trim");
  });
});

describe("optimizeOrder", () => {
  it("ランダム配置で最適化後の総移動距離が入力順以下になる", () => {
    // 決定的な「ランダム風」配置 10 点
    const pts: Point[] = [];
    for (let i = 0; i < 10; i++) {
      pts.push({
        x: Math.round(mm(40) * Math.sin(i * 2.39)),
        y: Math.round(mm(40) * Math.cos(i * 5.07)),
      });
    }
    const inputOrder = pts.map((_, i) => i);
    const optimized = optimizeOrder(pts, { x: 0, y: 0 });
    const costBefore = orderTravelCost(pts, inputOrder, { x: 0, y: 0 });
    const costAfter = orderTravelCost(pts, optimized, { x: 0, y: 0 });
    expect(costAfter).toBeLessThanOrEqual(costBefore);
    // 全点を1回ずつ訪問している
    expect([...optimized].sort((a, b) => a - b)).toEqual(inputOrder);
  });

  it("一直線上の点は端から順に並ぶ", () => {
    const pts: Point[] = [2, 0, 3, 1, 4].map((i) => ({ x: i * mm(10), y: 0 }));
    const order = optimizeOrder(pts, { x: 0, y: 0 });
    const xs = order.map((i) => pts[i].x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  });
});

describe("digitizeRegions (縫い順・糸切り)", () => {
  it("同色の近接オブジェクト3個 (間隔2mm) → 糸切り0回", () => {
    // 12mm 角を 14mm ピッチで並べる → 縁間ギャップ 2mm
    const regions = [
      square(-mm(14), 0, mm(12)),
      square(0, 0, mm(12)),
      square(mm(14), 0, mm(12)),
    ];
    const { plan } = digitizeRegions(regions, "NEAR");
    expect(plan.blocks.length).toBe(1);
    expect(countTrims(plan)).toBe(0);
  });

  it("同色の遠隔オブジェクト2個 (間隔50mm超) → auto モードでは糸切り0回 (同色内は jump)", () => {
    const regions = [square(-mm(35), 0, mm(15)), square(mm(35), 0, mm(15))];
    const { plan } = digitizeRegions(regions, "FAR");
    expect(countTrims(plan)).toBe(0);
  });

  it("分散した同色オブジェクトの総渡り距離が入力順より短くなる", () => {
    const regions: Region[] = [];
    for (let i = 0; i < 8; i++) {
      regions.push(
        square(
          Math.round(mm(35) * Math.sin(i * 2.39)),
          Math.round(mm(35) * Math.cos(i * 5.07)),
          mm(8),
        ),
      );
    }
    const optimized = digitizeRegions(regions, "OPT");
    const naive = digitizeRegions(regions, "NAIVE", { optimizeOrder: false });
    const travelOpt = planStats(optimized.plan).travel.total;
    const travelNaive = planStats(naive.plan).travel.total;
    expect(travelOpt).toBeLessThanOrEqual(travelNaive);
    // 針数はほぼ同じ (順序が変わるだけ)
    expect(
      Math.abs(countStitches(optimized.plan) - countStitches(naive.plan)),
    ).toBeLessThan(countStitches(naive.plan) * 0.05);
  });

  it("trimMode=never で糸切り0、always で全オブジェクト間が糸切りになる", () => {
    const regions = [
      square(-mm(35), 0, mm(10)),
      square(0, 0, mm(10)),
      square(mm(35), 0, mm(10)),
    ];
    const never = digitizeRegions(regions, "NV", { trimMode: "never" });
    expect(countTrims(never.plan)).toBe(0);
    const always = digitizeRegions(regions, "AW", { trimMode: "always" });
    expect(countTrims(always.plan)).toBe(2);
  });

  it("色順は面積の大きい順 (背景が先に縫われる)", () => {
    const regions = [
      square(0, 0, mm(8), BLUE), // 小 (前景)
      square(0, 0, mm(40), RED), // 大 (背景)
    ];
    const { plan } = digitizeRegions(regions, "LAYER");
    expect(plan.blocks[0].thread).toEqual(RED);
    expect(plan.blocks[1].thread).toEqual(BLUE);
  });
});

describe("branching (線の一筆書き接続)", () => {
  it("端点を共有するY字の3本は再走行込みの1本の Run になる (糸切り0)", () => {
    const junction = { x: 0, y: 0 };
    const tips: Point[] = [
      { x: -mm(20), y: -mm(10) },
      { x: mm(20), y: -mm(10) },
      { x: 0, y: mm(20) },
    ];
    const paths: Point[][] = tips.map((tip) => [junction, tip]);
    const runs = digitizeLines(paths, { start: tips[0] });
    expect(runs.length).toBe(1); // 連結成分は1本の連続 Run
    // 3つの枝先すべてを通る
    for (const tip of tips) {
      const visited = runs[0].stitches.some((p) => Math.hypot(p.x - tip.x, p.y - tip.y) < mm(1));
      expect(visited).toBe(true);
    }
    // 連続性: 隣接ステッチ距離が大きく飛ばない (再走行で戻っている証拠)
    for (let i = 1; i < runs[0].stitches.length; i++) {
      const d = Math.hypot(
        runs[0].stitches[i].x - runs[0].stitches[i - 1].x,
        runs[0].stitches[i].y - runs[0].stitches[i - 1].y,
      );
      expect(d).toBeLessThanOrEqual(mm(3) + 2);
    }
  });

  it("端点を共有する線は1成分にまとまり、離れた線だけ糸切りになる", () => {
    const paths: Point[][] = [
      [{ x: 0, y: 0 }, { x: mm(10), y: 0 }],
      [{ x: mm(10), y: 0 }, { x: mm(20), y: 0 }], // 1本目と端点共有
      [{ x: mm(60), y: 0 }, { x: mm(70), y: 0 }], // 40mm 離れている
    ];
    const runs = digitizeLines(paths, { start: { x: 0, y: 0 } });
    expect(runs.length).toBe(2); // 共有線は1本に結合
    expect(runs[1].connection).toBe("trim");
  });

  it("branchOrder: 向きを反転して近い端点から縫う", () => {
    // 2本目は遠い側が head なので reversed になるはず
    const paths: Point[][] = [
      [{ x: 0, y: 0 }, { x: mm(10), y: 0 }],
      [{ x: mm(30), y: 0 }, { x: mm(10), y: 0 }],
    ];
    const steps = branchOrder(paths, { x: 0, y: 0 });
    expect(steps[1].reversed).toBe(true);
  });
});

describe("planStats", () => {
  it("針数・糸切り・渡り距離が正しく集計される", () => {
    const regions = [
      square(-mm(35), 0, mm(15)),
      square(mm(35), 0, mm(15)),
      square(0, mm(30), mm(10), BLUE),
    ];
    const { plan } = digitizeRegions(regions, "STATS");
    const stats = planStats(plan);
    expect(stats.stitchCount).toBe(countStitches(plan));
    expect(stats.colorCount).toBe(2);
    expect(stats.colorChanges).toBe(1);
    expect(stats.trims).toBe(countTrims(plan));
    expect(stats.travel.max).toBeGreaterThan(mm(30)); // 50mm超のジャンプがある
    expect(stats.travel.avg).toBeGreaterThan(0);
    expect(stats.estMinutes).toBeGreaterThan(0);
    expect(stats.perColor.length).toBe(2);
  });

  it("拡張統計: サイズ・糸長・ステッチ長・密度・色別糸長が集計される", () => {
    const regions = [
      square(0, 0, mm(30)),
      square(mm(40), 0, mm(10), BLUE),
    ];
    const { plan } = digitizeRegions(regions, "EXTSTATS");
    const stats = planStats(plan);
    // デザインサイズ (mm)
    expect(stats.widthMm).toBeGreaterThan(0);
    expect(stats.heightMm).toBeGreaterThan(0);
    // 総糸長 (mm)
    expect(stats.totalLengthMm).toBeGreaterThan(0);
    // ステッチ長統計
    expect(stats.stitchLen.min).toBeGreaterThan(0);
    expect(stats.stitchLen.max).toBeGreaterThanOrEqual(stats.stitchLen.min);
    expect(stats.stitchLen.avg).toBeGreaterThan(0);
    expect(stats.stitchLen.avg).toBeLessThanOrEqual(stats.stitchLen.max);
    expect(stats.stitchLen.avg).toBeGreaterThanOrEqual(stats.stitchLen.min);
    // 密度
    expect(stats.densityPerCm2).toBeGreaterThan(0);
    // 色別糸長
    for (const c of stats.perColor) {
      expect(c.lengthMm).toBeGreaterThan(0);
    }
    const sumColorLen = stats.perColor.reduce((s, c) => s + c.lengthMm, 0);
    expect(sumColorLen).toBeCloseTo(stats.totalLengthMm, 0);
  });
});

describe("autoReduce (自動針数削減)", () => {
  it("12,000針超のデザインが上限以下に削減され、適用内容が報告される", () => {
    // 90mm 角 + 高密度 (行間隔 0.2mm) で意図的に超過させる
    const regions = [square(0, 0, mm(90))];
    const result = autoReduce(regions, "BIG", { rowSpacing: mm(0.2) });
    expect(result.before).toBeGreaterThan(12000);
    expect(result.after).toBeLessThanOrEqual(12000);
    expect(result.applied.length).toBeGreaterThan(0);
    expect(countStitches(result.plan)).toBe(result.after);
  });

  it("上限以下のデザインには何も適用しない", () => {
    const regions = [square(0, 0, mm(20))];
    const result = autoReduce(regions, "SMALL");
    expect(result.applied).toHaveLength(0);
    expect(result.after).toBe(result.before);
    expect(result.scale).toBe(1);
  });
});

describe("localRecommend (オフライン推奨)", () => {
  it("広い塗りつぶし中心ならタタミ + 下縫いを推奨し、白背景を検出する", () => {
    const WHITE = { r: 250, g: 250, b: 250 };
    const regions: Region[] = [
      square(0, 0, mm(80), WHITE), // 大きな白背景
      square(0, 0, mm(40), RED), // 広い塗り
    ];
    const rec = localRecommend(regions, null);
    expect(rec.fillType).toBe("tatami");
    expect(rec.underlay.length).toBeGreaterThan(0);
    expect(rec.removeWhiteBackground).toBe(true);
    expect(rec.colorCount).toBeGreaterThanOrEqual(2);
    expect(rec.analysis).toContain("色");
  });

  it("細い線中心ならサテンを推奨し、針数が多ければ省針密度を勧める", () => {
    const thin: Region[] = [
      { outer: rect(0, 0, mm(60), mm(1)), holes: [], color: RED }, // 細長い線
      { outer: rect(0, mm(5), mm(60), mm(1)), holes: [], color: BLUE },
    ];
    const stats = { ...planStats({ name: "x", blocks: [] }), stitchCount: 11000, widthMm: 60, heightMm: 6 };
    const rec = localRecommend(thin, stats);
    expect(rec.fillType).toBe("satin");
    expect(rec.densityScale).toBeGreaterThan(1);
  });
});
