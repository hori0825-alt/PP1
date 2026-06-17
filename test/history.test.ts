// 編集履歴 (Undo/Redo) のテスト。DOM 非依存のロジック層を直接検証する。

import { beforeEach, describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import type { Region } from "../src/core/region";
import type { Point } from "../src/core/types";
import { canRedo, canUndo, recordHistory, redo, resetHistory, undo } from "../src/ui/history";
import { createState, recomputeStitches } from "../src/ui/state";
import type { AppState } from "../src/ui/state";

const RED = { r: 220, g: 30, b: 30 };

function rect(cx: number, cy: number, w: number, h: number): Point[] {
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

function square(cx: number, cy: number, size: number): Region {
  return { outer: rect(cx, cy, size, size), holes: [], color: RED };
}

/** 領域を差し替えて再生成し、履歴に1コミットする (UI の編集 1 操作に相当) */
function commit(state: AppState, regions: Region[]): void {
  state.regions = regions;
  state.project.regions = regions;
  recomputeStitches(state);
  recordHistory(state);
}

describe("history (Undo/Redo)", () => {
  beforeEach(() => resetHistory());

  it("初期状態では戻る/やり直しともに不可", () => {
    const state = createState();
    recordHistory(state); // 初期スナップショット
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });

  it("変更を戻すと前の領域に復元される", () => {
    const state = createState();
    recordHistory(state); // 空 (present)
    commit(state, [square(0, 0, mm(20))]); // 1個
    commit(state, [square(0, 0, mm(20)), square(mm(30), 0, mm(20))]); // 2個

    expect(state.regions.length).toBe(2);
    expect(canUndo()).toBe(true);

    expect(undo(state)).toBe(true);
    expect(state.regions.length).toBe(1); // 1個に戻る

    expect(undo(state)).toBe(true);
    expect(state.regions.length).toBe(0); // 空に戻る
    expect(canUndo()).toBe(false);
  });

  it("戻した後にやり直すと元に戻る", () => {
    const state = createState();
    recordHistory(state);
    commit(state, [square(0, 0, mm(20))]);
    commit(state, [square(0, 0, mm(20)), square(mm(30), 0, mm(20))]);

    undo(state);
    expect(state.regions.length).toBe(1);
    expect(canRedo()).toBe(true);

    expect(redo(state)).toBe(true);
    expect(state.regions.length).toBe(2);
    expect(canRedo()).toBe(false);
  });

  it("戻した後に新しい変更を入れると、やり直し系列は破棄される", () => {
    const state = createState();
    recordHistory(state);
    commit(state, [square(0, 0, mm(20))]);
    commit(state, [square(0, 0, mm(20)), square(mm(30), 0, mm(20))]);

    undo(state); // 1個
    expect(canRedo()).toBe(true);

    commit(state, [square(0, mm(40), mm(15))]); // 別の編集を入れる
    expect(canRedo()).toBe(false); // redo 系列は消える
    expect(state.regions.length).toBe(1);
  });

  it("設計に変化がなければ履歴は増えない (表示切替などで no-op)", () => {
    const state = createState();
    recordHistory(state);
    commit(state, [square(0, 0, mm(20))]);
    // 何も変えずに記録 (タブ切替の render 相当)
    recordHistory(state);
    recordHistory(state);
    // 戻れるのは1段だけ (空に戻る)
    expect(undo(state)).toBe(true);
    expect(state.regions.length).toBe(0);
    expect(canUndo()).toBe(false);
  });

  it("復元後も plan が領域と整合する", () => {
    const state = createState();
    recordHistory(state);
    commit(state, [square(0, 0, mm(20))]);
    commit(state, [square(0, 0, mm(20)), square(mm(30), 0, mm(20))]);
    undo(state);
    expect(state.regions.length).toBe(1);
    expect(state.plan).not.toBeNull();
    // 1領域 = 1色ブロック
    expect(state.plan?.blocks.length).toBe(1);
  });

  it("resetHistory で履歴がクリアされる", () => {
    const state = createState();
    recordHistory(state);
    commit(state, [square(0, 0, mm(20))]);
    expect(canUndo()).toBe(true);
    resetHistory();
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });
});
