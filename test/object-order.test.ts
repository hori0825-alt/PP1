// 同色内オブジェクト縫い順 (objectOrder) のテスト。
// digitize が指定順で同色内を縫うこと、state.moveObjectInColor が色境界を越えず
// 入れ替えること、再生成後も保持されることを検証する。

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import { makeObject } from "../src/core/object";
import type { Region } from "../src/core/region";
import type { Point } from "../src/core/types";
import { digitizeRegions } from "../src/stitch/digitize";
import { createState, moveObjectInColor, recomputeStitches } from "../src/ui/state";

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

/** plan の各 run の objectId を縫い順に並べた配列 (重複除去) */
function objectSewOrder(plan: { blocks: { runs: { objectId?: number }[] }[] }): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const b of plan.blocks)
    for (const r of b.runs) {
      if (r.objectId != null && !seen.has(r.objectId)) {
        seen.add(r.objectId);
        out.push(r.objectId);
      }
    }
  return out;
}

describe("digitize objectOrder", () => {
  it("同色内を objectOrder の順で縫う", () => {
    // 同色 (RED) の3パーツ
    const regions: Region[] = [
      { outer: rect(-mm(20), 0, mm(10), mm(10)), holes: [], color: RED },
      { outer: rect(0, 0, mm(10), mm(10)), holes: [], color: RED },
      { outer: rect(mm(20), 0, mm(10), mm(10)), holes: [], color: RED },
    ];
    const objects = regions.map((r) => makeObject(r));
    const ids = objects.map((o) => o.id);
    // 逆順を指定
    const order = [ids[2], ids[1], ids[0]];
    const res = digitizeRegions(regions, "T", { objectOrder: order, optimizeOrder: true }, objects);
    expect(objectSewOrder(res.plan)).toEqual(order);
  });
});

describe("moveObjectInColor (state)", () => {
  function setup() {
    const state = createState();
    // RED 3個 + BLUE 1個
    state.regions = [
      { outer: rect(-mm(20), 0, mm(10), mm(10)), holes: [], color: RED },
      { outer: rect(0, 0, mm(10), mm(10)), holes: [], color: RED },
      { outer: rect(mm(20), 0, mm(10), mm(10)), holes: [], color: RED },
      { outer: rect(0, mm(25), mm(10), mm(10)), holes: [], color: BLUE },
    ];
    recomputeStitches(state);
    return state;
  }

  it("同色内でパーツ順を入れ替え、再生成後も保持する", () => {
    const state = setup();
    const before = objectSewOrder(state.plan!);
    // RED グループの先頭を1つ後ろへ
    const redFirst = before[0];
    moveObjectInColor(state, redFirst, 1);
    const after = objectSewOrder(state.plan!);
    expect(after).not.toEqual(before);
    // 先頭だったものが2番目に来ている
    expect(after.indexOf(redFirst)).toBe(1);
    // 設定に保存されている
    expect(state.project.settings.objectOrder).toBeDefined();
    // もう一度再生成しても順序が保たれる
    recomputeStitches(state);
    expect(objectSewOrder(state.plan!)).toEqual(after);
  });

  it("色境界は越えない (最後の同色パーツを後ろへ動かしても不変)", () => {
    const state = setup();
    const order = objectSewOrder(state.plan!);
    // RED の3個目 (同色内の末尾) を後ろへ → 動かない
    const redIds = order.slice(0, 3);
    const lastRed = redIds[2];
    moveObjectInColor(state, lastRed, 1);
    expect(objectSewOrder(state.plan!)).toEqual(order);
  });
});
