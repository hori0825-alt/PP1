// Phase 1: 永続オブジェクトモデルのテスト。
// 安定 id (選択・縫い順の同一性) と baked (マニュアル編集済み針列の温存) を検証する。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import {
  makeObject,
  objectsFromRegions,
  reconcileObjects,
  regionsOf,
} from "../src/core/object";
import type { EmbroideryObject } from "../src/core/object";
import { deserializeProject, serializeProject } from "../src/core/project";
import type { Region } from "../src/core/region";
import type { Point, StitchPlan } from "../src/core/types";
import { digitizeRegions } from "../src/stitch/digitize";
import {
  addPenPoint,
  addRegionAngleLine,
  bakeObject,
  cancelVectorEdit,
  clearRegionAngleLines,
  createState,
  deleteBakedStitch,
  enterStitchEdit,
  enterVectorEdit,
  exitStitchEdit,
  findObject,
  finishPenDraw,
  insertBakedStitch,
  liveApplyVectorEdit,
  moveBakedStitch,
  recomputeStitches,
  restoreObjectsFromProject,
  setRegionAngle,
  setRegionFill,
  startPenDraw,
  stitchEditObject,
  unbakeObject,
} from "../src/ui/state";

const COLOR = { r: 30, g: 120, b: 90 };

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

function stitchesOf(plan: StitchPlan, objectId: number): Point[] {
  return plan.blocks
    .flatMap((b) => b.runs)
    .filter((r) => r.objectId === objectId)
    .flatMap((r) => r.stitches);
}

describe("reconcileObjects: 安定 id", () => {
  it("その場編集 (同じ Region 参照) では id を維持する", () => {
    const regions = [region(-mm(20), 0, mm(15)), region(mm(20), 0, mm(15))];
    const objs = objectsFromRegions(regions);
    const ids = objs.map((o) => o.id);

    // パーツの角度をその場で変更 (参照は同じ)
    regions[0].angleDeg = 30;
    const next = reconcileObjects(objs, regions);
    expect(next.map((o) => o.id)).toEqual(ids);
    expect(next).toBe(objs); // 変化なしなら同一参照を返す
  });

  it("Region 配列を差し替えると新しい id を割り当てる", () => {
    const objs = objectsFromRegions([region(0, 0, mm(15))]);
    const oldId = objs[0].id;
    const replaced = reconcileObjects(objs, [region(0, 0, mm(15))]); // 新しい Region
    expect(replaced[0].id).not.toBe(oldId);
  });

  it("regionsOf はオブジェクトの Region 参照をそのまま返す", () => {
    const r = region(0, 0, mm(10));
    const obj = makeObject(r);
    expect(regionsOf([obj])[0]).toBe(r);
  });
});

describe("digitize: 安定 id を run.objectId に使う", () => {
  it("オブジェクトを渡すと run.objectId がオブジェクトの id になる", () => {
    const r = region(0, 0, mm(20));
    const obj: EmbroideryObject = { id: 4242, region: r };
    const { plan } = digitizeRegions([r], "ID", { fillType: "tatami" }, [obj]);
    const ids = new Set(plan.blocks.flatMap((b) => b.runs).map((rr) => rr.objectId));
    expect(ids.has(4242)).toBe(true);
  });
});

describe("baked: マニュアル針列の温存", () => {
  it("baked があるオブジェクトは針列をそのまま出力する", () => {
    const r = region(0, 0, mm(20));
    const baked = [
      { stitches: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], connection: "trim" as const },
    ];
    const obj: EmbroideryObject = { id: 7, region: r, baked };
    const { plan } = digitizeRegions([r], "BK", { fillType: "tatami" }, [obj]);
    expect(stitchesOf(plan, 7)).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]);
  });
});

describe("state: bake / unbake で手編集が再生成に耐える", () => {
  it("ベイクしたオブジェクトは角度を変えても針が変わらない", () => {
    const state = createState();
    state.regions = [region(-mm(25), 0, mm(20)), region(mm(25), 0, mm(20))];
    recomputeStitches(state);
    const baked = state.objects[0].id;
    const other = state.objects[1].id;

    const bakedBefore = JSON.stringify(stitchesOf(state.plan!, baked));
    const otherBefore = JSON.stringify(stitchesOf(state.plan!, other));

    expect(bakeObject(state, baked)).toBe(true);

    // 全体角度を変えて再生成
    state.project.settings.angleDeg = 90;
    recomputeStitches(state);

    // ベイク済みは不変、未ベイクは変化する
    expect(JSON.stringify(stitchesOf(state.plan!, baked))).toBe(bakedBefore);
    expect(JSON.stringify(stitchesOf(state.plan!, other))).not.toBe(otherBefore);

    // 解除すると再生成に戻る
    unbakeObject(state, baked);
    expect(findObject(state, baked)?.baked).toBeUndefined();
    expect(JSON.stringify(stitchesOf(state.plan!, baked))).not.toBe(bakedBefore);
  });
});

describe("state: 方向線 (ターニング) の追加・クリア", () => {
  it("方向線を2本足すと縫い目が変わり、クリアで戻る", () => {
    const state = createState();
    state.regions = [{ outer: rect(0, 0, mm(20), mm(20)), holes: [], color: COLOR }];
    recomputeStitches(state);
    const before = JSON.stringify(stitchesOf(state.plan!, state.objects[0].id));

    addRegionAngleLine(state, 0, { a: { x: -mm(8), y: -mm(5) }, b: { x: mm(8), y: -mm(5) } });
    addRegionAngleLine(state, 0, { a: { x: mm(5), y: -mm(8) }, b: { x: mm(5), y: mm(8) } });
    expect(state.regions[0].angleLines?.length).toBe(2);
    const turned = JSON.stringify(stitchesOf(state.plan!, state.objects[0].id));
    expect(turned).not.toBe(before); // 流れる向きになった

    clearRegionAngleLines(state, 0);
    expect(state.regions[0].angleLines).toBeUndefined();
    expect(JSON.stringify(stitchesOf(state.plan!, state.objects[0].id))).toBe(before);
  });
});

describe("保存対応: 編集が save/load で保持される", () => {
  it("固定針(走り縫いの手動線)・パーツ別の縫い方/角度/方向線が往復する", () => {
    const state = createState();
    state.regions = [{ outer: rect(0, 0, mm(20), mm(20)), holes: [], color: COLOR }];
    recomputeStitches(state);
    setRegionFill(state, 0, "satin");
    setRegionAngle(state, 0, 30);
    addRegionAngleLine(state, 0, { a: { x: -mm(6), y: -mm(6) }, b: { x: mm(6), y: mm(6) } });
    addRegionAngleLine(state, 0, { a: { x: mm(6), y: -mm(6) }, b: { x: -mm(6), y: mm(6) } });

    // 手動の線 (走り縫い = baked)
    startPenDraw(state, "line");
    addPenPoint(state, { x: -mm(15), y: mm(20) });
    addPenPoint(state, { x: mm(15), y: mm(20) });
    expect(finishPenDraw(state)).toBe(true);
    expect(state.objects[1].baked).toBeDefined();

    // 保存 → 別の state へ読み込み
    const json = serializeProject(state.project);
    const s2 = createState();
    s2.project = deserializeProject(json);
    s2.regions = s2.project.regions;
    restoreObjectsFromProject(s2);
    recomputeStitches(s2);

    // パーツ設定が保持されている
    expect(s2.regions[0].fillType).toBe("satin");
    expect(s2.regions[0].angleDeg).toBe(30);
    expect(s2.regions[0].angleLines?.length).toBe(2);
    // 手動線の baked が保持され、走り縫いとして出力される
    const lineObj = s2.objects[1];
    expect(lineObj.baked).toBeDefined();
    expect(lineObj.baked![0].stitchType).toBe("running");
    const linePts = s2.plan!.blocks
      .flatMap((b) => b.runs)
      .filter((r) => r.objectId === lineObj.id)
      .flatMap((r) => r.stitches);
    expect(linePts.length).toBeGreaterThan(2);
  });

  it("古い形式 (objects なし) でも読み込める", () => {
    const state = createState();
    state.regions = [{ outer: rect(0, 0, mm(20), mm(20)), holes: [], color: COLOR }];
    recomputeStitches(state);
    const json = serializeProject(state.project);
    const parsed = JSON.parse(json);
    delete parsed.objects; // 旧形式を模す
    const s2 = createState();
    s2.project = deserializeProject(JSON.stringify(parsed));
    s2.regions = s2.project.regions;
    restoreObjectsFromProject(s2); // フォールバックで作り直す
    recomputeStitches(s2);
    expect(s2.objects.length).toBe(1);
    expect(s2.plan).not.toBeNull();
  });
});

describe("手動デジタイズ (ペン, フェーズ8)", () => {
  it("面を描くとフィルの新規オブジェクトができる", () => {
    const state = createState();
    startPenDraw(state, "fill");
    addPenPoint(state, { x: -mm(10), y: -mm(10) });
    addPenPoint(state, { x: mm(10), y: -mm(10) });
    addPenPoint(state, { x: mm(10), y: mm(10) });
    addPenPoint(state, { x: -mm(10), y: mm(10) });
    expect(finishPenDraw(state)).toBe(true);
    expect(state.penDraw).toBeNull();
    expect(state.regions.length).toBe(1);
    const cnt = state.plan!.blocks.flatMap((b) => b.runs).reduce((n, r) => n + r.stitches.length, 0);
    expect(cnt).toBeGreaterThan(10); // フィルの針が出ている
  });

  it("線を描くと走り縫いの baked オブジェクトができる", () => {
    const state = createState();
    startPenDraw(state, "line");
    addPenPoint(state, { x: -mm(20), y: 0 });
    addPenPoint(state, { x: mm(20), y: 0 });
    expect(finishPenDraw(state)).toBe(true);
    expect(state.regions.length).toBe(1);
    const obj = state.objects[0];
    expect(obj.baked).toBeDefined();
    expect(obj.baked![0].stitchType).toBe("running");
    const pts = state.plan!.blocks.flatMap((b) => b.runs).flatMap((r) => r.stitches);
    expect(pts.length).toBeGreaterThan(2); // 走り縫いが再サンプルされている
  });

  it("点が足りなければ作成しない", () => {
    const state = createState();
    startPenDraw(state, "fill");
    addPenPoint(state, { x: 0, y: 0 });
    expect(finishPenDraw(state)).toBe(false);
    expect(state.regions.length).toBe(0);
  });
});

describe("針 (ステッチ点) 編集 (フェーズ7)", () => {
  it("ベイクして針を移動/追加/削除でき、plan に反映される", () => {
    const state = createState();
    state.regions = [{ outer: rect(0, 0, mm(20), mm(20)), holes: [], color: COLOR }];
    recomputeStitches(state);

    expect(enterStitchEdit(state, 0)).toBe(true);
    expect(state.stitchEdit).not.toBeNull();
    const obj = stitchEditObject(state)!;
    expect(obj.baked).toBeDefined();
    const before = obj.baked!.reduce((n, r) => n + r.stitches.length, 0);
    expect(before).toBeGreaterThan(2);

    // 追加 (run0 の先頭の後ろ)
    insertBakedStitch(state, 0, 0, { x: 5, y: 5 });
    const afterAdd = stitchEditObject(state)!.baked!.reduce((n, r) => n + r.stitches.length, 0);
    expect(afterAdd).toBe(before + 1);

    // 移動
    moveBakedStitch(state, 0, 1, { x: 123, y: 45 });
    expect(stitchEditObject(state)!.baked![0].stitches[1]).toEqual({ x: 123, y: 45 });
    // plan にも出ている
    const id = state.stitchEdit!.objectId;
    const planPts = state.plan!.blocks
      .flatMap((b) => b.runs)
      .filter((r) => r.objectId === id)
      .flatMap((r) => r.stitches);
    expect(planPts.some((p) => p.x === 123 && p.y === 45)).toBe(true);

    // 削除
    deleteBakedStitch(state, 0, 0);
    const afterDel = stitchEditObject(state)!.baked!.reduce((n, r) => n + r.stitches.length, 0);
    expect(afterDel).toBe(afterAdd - 1);

    exitStitchEdit(state);
    expect(state.stitchEdit).toBeNull();
  });
});

describe("輪郭ノード編集の統合 (フェーズ5)", () => {
  it("ライブ編集でオブジェクトidを保ち、破棄で元に戻る", () => {
    const state = createState();
    state.regions = [{ outer: rect(0, 0, mm(20), mm(20)), holes: [], color: COLOR }];
    recomputeStitches(state);
    const id = state.objects[0].id;
    const before = JSON.stringify(stitchesOf(state.plan!, id));

    enterVectorEdit(state, 0);
    expect(state.vectorEdit).not.toBeNull();
    // 外周の角ノードを外側へ動かす
    const ve = state.vectorEdit!;
    const node = ve.shapes[0].outer.nodes[0];
    ve.shapes[0].outer.nodes[0] = { ...node, x: -mm(40), y: -mm(40) };
    liveApplyVectorEdit(state, { skipDerived: true });

    // 同じオブジェクト (id 不変) で、形が変わって縫い直された
    expect(state.objects[0].id).toBe(id);
    expect(JSON.stringify(stitchesOf(state.plan!, id))).not.toBe(before);

    // 破棄で開始時の形状・縫い目に戻る
    cancelVectorEdit(state);
    expect(state.vectorEdit).toBeNull();
    expect(state.objects[0].id).toBe(id);
    expect(JSON.stringify(stitchesOf(state.plan!, state.objects[0].id))).toBe(before);
  });
});
