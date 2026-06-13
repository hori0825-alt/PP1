// UI スモークテスト (jsdom)。
// メイン UI がエラーなく描画され、状態ロジックが破綻しないことを確認する。
// 詳細な描画は Canvas API のスタブが要るため、ここでは「例外を投げない」ことを主眼にする。

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mm } from "../src/core/constants";
import type { Region } from "../src/core/region";
import type { Point } from "../src/core/types";
import { renderSequence } from "../src/ui/sequenceView";
import {
  applyVectorEdit,
  cancelVectorEdit,
  createState,
  enterVectorEdit,
  recomputeStitches,
} from "../src/ui/state";

function rect(cx: number, cy: number, w: number, h: number): Point[] {
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

const RED = { r: 220, g: 30, b: 30 };
const BLUE = { r: 30, g: 60, b: 200 };

describe("UI state ロジック", () => {
  it("領域からステッチ・診断・シーケンス・シミュレーションが揃う", () => {
    const state = createState();
    const regions: Region[] = [
      { outer: rect(-mm(20), 0, mm(15), mm(15)), holes: [], color: RED },
      { outer: rect(mm(20), 0, mm(10), mm(10)), holes: [], color: BLUE },
    ];
    state.regions = regions;
    recomputeStitches(state);

    expect(state.plan).not.toBeNull();
    expect(state.diagnostics).not.toBeNull();
    expect(state.sequence).not.toBeNull();
    expect(state.simulation).not.toBeNull();
    expect(state.sequence?.entries.length).toBeGreaterThanOrEqual(2);
    expect(state.simulation?.totalStitches).toBeGreaterThan(0);
  });
});

describe("シーケンスビュー描画 (jsdom)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("エントリ行が描画され、目アイコンで表示/非表示が切り替わる", () => {
    const state = createState();
    state.regions = [
      { outer: rect(-mm(20), 0, mm(15), mm(15)), holes: [], color: RED },
      { outer: rect(mm(20), 0, mm(12), mm(12)), holes: [], color: BLUE },
    ];
    recomputeStitches(state);
    state.onChange = vi.fn();

    const container = document.createElement("div");
    document.body.appendChild(container);
    renderSequence(container, state, "all");

    const rows = container.querySelectorAll(".seq-row");
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // 目アイコンクリックで hiddenObjectIds が更新される
    const eye = container.querySelector<HTMLElement>(".seq-eye");
    expect(eye).not.toBeNull();
    eye?.click();
    expect(state.hiddenObjectIds.size).toBe(1);
    expect(state.onChange).toHaveBeenCalled();
  });

  it("糸切りフィルターで糸切りのある行だけ表示される", () => {
    const state = createState();
    // 遠隔配置で糸切りを発生させる
    state.regions = [
      { outer: rect(-mm(40), 0, mm(12), mm(12)), holes: [], color: RED },
      { outer: rect(mm(40), 0, mm(12), mm(12)), holes: [], color: RED },
    ];
    recomputeStitches(state);

    const container = document.createElement("div");
    renderSequence(container, state, "trims");
    // 糸切りのある行のみ (summary + 該当行)
    const rows = container.querySelectorAll(".seq-row");
    rows.forEach((r) => {
      expect(r.querySelector(".badge.trim")).not.toBeNull();
    });
  });
});

describe("ベクター編集ライフサイクル", () => {
  it("編集開始→ノード移動→適用で領域が更新される", () => {
    const state = createState();
    state.regions = [{ outer: rect(0, 0, mm(20), mm(20)), holes: [], color: RED }];
    recomputeStitches(state);
    const before = state.plan;

    enterVectorEdit(state);
    expect(state.vectorEdit).not.toBeNull();
    expect(state.vectorEdit?.shapes.length).toBe(1);

    // 外周の角ノードを外側へ動かす
    const ve = state.vectorEdit;
    if (ve) {
      const path = ve.shapes[0].outer;
      path.nodes[0] = { ...path.nodes[0], x: -mm(20), y: -mm(20) };
    }
    applyVectorEdit(state);
    expect(state.vectorEdit).toBeNull();
    expect(state.plan).not.toBe(before); // 再生成された
    expect(state.plan?.blocks.length).toBe(1);
  });

  it("破棄すると領域は変わらない", () => {
    const state = createState();
    state.regions = [{ outer: rect(0, 0, mm(20), mm(20)), holes: [], color: RED }];
    recomputeStitches(state);
    const regionsBefore = state.regions;

    enterVectorEdit(state);
    cancelVectorEdit(state);
    expect(state.vectorEdit).toBeNull();
    expect(state.regions).toBe(regionsBefore);
  });
});
