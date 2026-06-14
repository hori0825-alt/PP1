// Phase 2: 差分再生成 (オブジェクトキャッシュ) のテスト。
// - 出力はキャッシュなしと完全一致 (結果を変えない)
// - 変更のないオブジェクトは縫い直さず本体ランを再利用する (参照同一性で確認)
// - 形状・パラメータが変わるとキャッシュは無効化され再生成される

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import { makeObject, objectsFromRegions } from "../src/core/object";
import type { Region } from "../src/core/region";
import type { Point, StitchPlan } from "../src/core/types";
import { digitizeRegions } from "../src/stitch/digitize";

const COLOR = { r: 200, g: 60, b: 40 };

function rect(cx: number, cy: number, w: number, h: number): Point[] {
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

function region(cx: number, cy: number, s: number): Region {
  return { outer: rect(cx, cy, s, s), holes: [], color: COLOR };
}

const OPTS = { fillType: "tatami" as const, underlay: ["edge"] as ("edge")[] };

/** objectId を無視して幾何・接続・種別だけ取り出す (キャッシュ有無の比較用) */
function shape(plan: StitchPlan): unknown {
  return plan.blocks.map((b) => ({
    thread: b.thread,
    runs: b.runs.map((r) => ({ stitches: r.stitches, connection: r.connection, stitchType: r.stitchType })),
  }));
}

describe("差分再生成: 出力の同一性", () => {
  it("キャッシュ有り(2回目=再利用)はキャッシュ無しと完全一致する", () => {
    const regions = [region(-mm(25), 0, mm(20)), region(mm(25), 0, mm(20))];
    const base = digitizeRegions(regions, "D", OPTS).plan; // objects なし = キャッシュなし

    const objs = objectsFromRegions(regions);
    digitizeRegions(regions, "D", OPTS, objs); // 1回目: キャッシュ生成
    const cached = digitizeRegions(regions, "D", OPTS, objs).plan; // 2回目: 再利用

    expect(shape(cached)).toEqual(shape(base));
  });
});

describe("差分再生成: 変更なしは縫い直さない", () => {
  it("2回目の生成は本体ランの針配列を参照ごと再利用する", () => {
    const r = region(0, 0, mm(20));
    const objs = [makeObject(r)];
    const p1 = digitizeRegions([r], "D", OPTS, objs).plan;
    const p2 = digitizeRegions([r], "D", OPTS, objs).plan;

    const s1 = p1.blocks[0].runs.map((run) => run.stitches);
    const s2 = p2.blocks[0].runs.map((run) => run.stitches);
    expect(s2.length).toBe(s1.length);
    // 同じ針配列の参照 = 再生成されていない
    s1.forEach((arr, i) => expect(s2[i]).toBe(arr));
  });
});

describe("差分再生成: 変更でキャッシュ無効化", () => {
  it("角度を変えると再生成される (針配列の参照が変わる)", () => {
    const r = region(0, 0, mm(20));
    const objs = [makeObject(r)];
    const p1 = digitizeRegions([r], "D", OPTS, objs).plan;
    const before = p1.blocks[0].runs[0].stitches;

    r.angleDeg = 90; // 同じ outer 参照だがパラメータが変化
    const p2 = digitizeRegions([r], "D", OPTS, objs).plan;
    expect(p2.blocks[0].runs[0].stitches).not.toBe(before);
  });

  it("形状 (outer 参照) を変えると再生成される", () => {
    const obj = makeObject(region(0, 0, mm(20)));
    const p1 = digitizeRegions([obj.region], "D", OPTS, [obj]).plan;
    const before = p1.blocks[0].runs[0].stitches;

    obj.region.outer = rect(0, 0, mm(30), mm(30)); // 新しい outer 配列
    const p2 = digitizeRegions([obj.region], "D", OPTS, [obj]).plan;
    expect(p2.blocks[0].runs[0].stitches).not.toBe(before);
  });
});
