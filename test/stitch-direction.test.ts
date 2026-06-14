// パーツ単位のステッチ方向 (角度) と縫い方の永続化テスト。
// 「ステッチの方向や種類をパーツごとに直せる」機能の中核を検証する。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import { angleDegFromVector } from "../src/core/geometry";
import type { Region } from "../src/core/region";
import type { Point, StitchPlan } from "../src/core/types";
import { compensateRegion } from "../src/stitch/compensation";
import { digitizeRegions } from "../src/stitch/digitize";
import {
  createState,
  effectiveAngle,
  recomputeStitches,
  setRegionAngle,
  setRegionFill,
} from "../src/ui/state";

const COLOR = { r: 40, g: 80, b: 200 };

function rect(cx: number, cy: number, w: number, h: number): Point[] {
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

function allStitches(plan: StitchPlan): Point[] {
  return plan.blocks.flatMap((b) => b.runs).flatMap((r) => r.stitches);
}

describe("angleDegFromVector", () => {
  it("方向ベクトルを [0,180) のステッチ角度に正規化する", () => {
    expect(angleDegFromVector(1, 0)).toBe(0);
    expect(angleDegFromVector(0, 1)).toBe(90);
    expect(angleDegFromVector(-1, 0)).toBe(0); // 逆向きは同じ縫い目
    expect(angleDegFromVector(0, -1)).toBe(90);
    expect(angleDegFromVector(1, 1)).toBeCloseTo(45, 5);
    expect(angleDegFromVector(0, 0)).toBe(0); // 退化
  });
});

describe("パーツ固有のステッチ角度", () => {
  it("region.angleDeg を変えると面の縫い目が変わる", () => {
    const base = digitizeRegions(
      [{ outer: rect(0, 0, mm(30), mm(20)), holes: [], color: COLOR }],
      "T",
      { fillType: "tatami", angleDeg: 0 },
    ).plan;
    const turned = digitizeRegions(
      [{ outer: rect(0, 0, mm(30), mm(20)), holes: [], color: COLOR, angleDeg: 90 }],
      "T",
      { fillType: "tatami", angleDeg: 0 },
    ).plan;
    expect(allStitches(base).length).toBeGreaterThan(0);
    expect(allStitches(turned).length).toBeGreaterThan(0);
    // 同じ全体角度 0 でも、パーツ角度 90 のほうは縫い目が違う
    expect(JSON.stringify(allStitches(base))).not.toBe(JSON.stringify(allStitches(turned)));
  });

  it("パーツ角度は全体角度より優先される", () => {
    const globalOnly = digitizeRegions(
      [{ outer: rect(0, 0, mm(30), mm(20)), holes: [], color: COLOR }],
      "T",
      { fillType: "tatami", angleDeg: 90 },
    ).plan;
    const perObject = digitizeRegions(
      [{ outer: rect(0, 0, mm(30), mm(20)), holes: [], color: COLOR, angleDeg: 90 }],
      "T",
      { fillType: "tatami", angleDeg: 0 },
    ).plan;
    // 全体90 と「全体0 + パーツ90」は同じ結果になるはず
    expect(JSON.stringify(allStitches(perObject))).toBe(JSON.stringify(allStitches(globalOnly)));
  });
});

describe("compensateRegion はパーツ固有プロパティを保持する", () => {
  it("Pull/Push 補正後も fillType と angleDeg が残る (回帰防止)", () => {
    const region: Region = {
      outer: rect(0, 0, mm(20), mm(20)),
      holes: [],
      color: COLOR,
      fillType: "satin",
      angleDeg: 30,
    };
    const out = compensateRegion(region, { pull: mm(0.3), push: mm(0.2), sewAngleRad: 0 });
    expect(out.fillType).toBe("satin");
    expect(out.angleDeg).toBe(30);
    // 輪郭は補正で変化している
    expect(JSON.stringify(out.outer)).not.toBe(JSON.stringify(region.outer));
  });

  it("補正なし (pull=push=0) のときは元領域をそのまま返す", () => {
    const region: Region = {
      outer: rect(0, 0, mm(20), mm(20)),
      holes: [],
      color: COLOR,
      fillType: "tatami",
      angleDeg: 15,
    };
    const out = compensateRegion(region, { pull: 0, push: 0, sewAngleRad: 0 });
    expect(out.fillType).toBe("tatami");
    expect(out.angleDeg).toBe(15);
  });
});

describe("state ヘルパー: パーツ角度・縫い方の設定", () => {
  it("setRegionAngle / setRegionFill が領域に反映され再生成される", () => {
    const state = createState();
    state.regions = [{ outer: rect(0, 0, mm(20), mm(20)), holes: [], color: COLOR }];
    recomputeStitches(state);
    const before = state.plan;

    setRegionAngle(state, 0, 90);
    expect(state.regions[0].angleDeg).toBe(90);
    expect(effectiveAngle(state, 0)).toBe(90);
    expect(state.plan).not.toBe(before); // 再生成された

    setRegionFill(state, 0, "satin");
    expect(state.regions[0].fillType).toBe("satin");

    // null で個別設定をクリアすると全体角度に戻る
    setRegionAngle(state, 0, null);
    expect(state.regions[0].angleDeg).toBeUndefined();
    expect(effectiveAngle(state, 0)).toBe(state.project.settings.angleDeg);
  });

  it("角度は [0,180) に正規化される", () => {
    const state = createState();
    state.regions = [{ outer: rect(0, 0, mm(20), mm(20)), holes: [], color: COLOR }];
    setRegionAngle(state, 0, 200);
    expect(state.regions[0].angleDeg).toBe(20);
    setRegionAngle(state, 0, -30);
    expect(state.regions[0].angleDeg).toBe(150);
  });
});
