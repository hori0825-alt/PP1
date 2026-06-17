// Phase 5 のコアロジックのテスト: 診断・シミュレーション・シーケンス・プロジェクト。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import {
  createEmptyProject,
  deserializeProject,
  serializeProject,
} from "../src/core/project";
import type { Region } from "../src/core/region";
import type { Point, StitchPlan } from "../src/core/types";
import { diagnose } from "../src/plan/diagnostics";
import { buildSequence, reorderBlocks } from "../src/plan/sequence";
import { buildSimulation } from "../src/plan/simulate";
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

describe("diagnose", () => {
  it("正常なデザインは overall=ok", () => {
    const { plan } = digitizeRegions([square(0, 0, mm(20))], "OK");
    const report = diagnose(plan);
    expect(report.overall).toBe("ok");
    expect(report.items.some((i) => i.level === "ok")).toBe(true);
  });

  it("枠外デザインは overall=critical で枠外項目が出る", () => {
    const { plan } = digitizeRegions([square(0, 0, mm(120))], "BIG");
    const report = diagnose(plan);
    expect(report.overall).toBe("critical");
    expect(report.items[0].level).toBe("critical"); // critical が先頭
    expect(report.items.some((i) => i.title.includes("枠外"))).toBe(true);
  });

  it("針数超過には自動修正 (reduce-stitches) が付く", () => {
    const { plan } = digitizeRegions([square(0, 0, mm(90))], "DENSE", { rowSpacing: mm(0.2) });
    const report = diagnose(plan);
    const item = report.items.find((i) => i.autofix === "reduce-stitches");
    expect(item).toBeDefined();
  });
});

describe("buildSimulation", () => {
  const plan: StitchPlan = {
    name: "SIM",
    blocks: [
      {
        thread: RED,
        runs: [
          {
            stitches: [
              { x: 0, y: 0 },
              { x: mm(5), y: 0 },
              { x: mm(10), y: 0 },
            ],
            connection: "trim",
          },
        ],
      },
      {
        thread: BLUE,
        runs: [
          {
            stitches: [
              { x: mm(30), y: mm(30) },
              { x: mm(35), y: mm(30) },
            ],
            connection: "trim",
          },
        ],
      },
    ],
  };

  it("フレーム数が総ステッチ数と一致する", () => {
    const sim = buildSimulation(plan);
    // 論理ステッチ 5 針に加え、糸切り境界の止め縫い (tie-in/off) が含まれる
    expect(sim.totalStitches).toBeGreaterThanOrEqual(5);
    expect(sim.frames.length).toBeGreaterThanOrEqual(sim.totalStitches);
    // stitchNumber が単調増加
    let prev = 0;
    for (const f of sim.frames) {
      expect(f.stitchNumber).toBeGreaterThanOrEqual(prev);
      prev = f.stitchNumber;
    }
  });

  it("色替えフレームが記録される", () => {
    const sim = buildSimulation(plan);
    expect(sim.colorChangeFrames.length).toBe(1);
    const cf = sim.frames[sim.colorChangeFrames[0]];
    expect(cf.colorChanged).toBe(true);
    expect(cf.colorIndex).toBe(1);
  });

  it("最終フレームの位置が最後のステッチと一致する", () => {
    const sim = buildSimulation(plan);
    const last = sim.frames[sim.frames.length - 1];
    expect(last.x).toBe(mm(35));
    expect(last.y).toBe(mm(30));
    expect(last.colorIndex).toBe(1);
  });
});

describe("buildSequence", () => {
  it("縫製順のエントリが生成され、色替え・糸切りが記録される", () => {
    const regions = [square(-mm(35), 0, mm(15)), square(mm(35), 0, mm(15)), square(0, mm(30), mm(10), BLUE)];
    const { plan } = digitizeRegions(regions, "SEQ");
    const seq = buildSequence(plan);
    expect(seq.entries.length).toBeGreaterThanOrEqual(3);
    // order が 0,1,2,... と連続
    seq.entries.forEach((e, i) => expect(e.order).toBe(i));
    // 色替えが1回 (赤→青)
    expect(seq.entries.filter((e) => e.colorChange).length).toBe(1);
    // 遠隔の赤2個の間に糸切りがある
    expect(seq.entries.some((e) => e.trim)).toBe(true);
  });

  it("objectId でグループ化できる", () => {
    const { plan } = digitizeRegions([square(0, 0, mm(20))], "OBJ", { underlay: ["edge"] });
    const seq = buildSequence(plan);
    // 下縫い + 本縫いが同じ objectId
    expect(seq.byObject.size).toBe(1);
    const ids = [...seq.byObject.values()][0];
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it("reorderBlocks がブロック順を入れ替える", () => {
    const regions = [square(0, 0, mm(40), RED), square(0, 0, mm(8), BLUE)];
    const { plan } = digitizeRegions(regions, "REORDER");
    const original = plan.blocks.map((b) => b.thread);
    const reordered = reorderBlocks(plan, 0, 1);
    expect(reordered.blocks[0].thread).toEqual(original[1]);
    expect(reordered.blocks[1].thread).toEqual(original[0]);
    // 元のプランは不変
    expect(plan.blocks[0].thread).toEqual(original[0]);
  });
});

describe("project 保存/読み込み", () => {
  it("ラウンドトリップで内容が保持される", () => {
    const project = createEmptyProject("テストデザイン");
    project.settings.colorCount = 8;
    project.settings.trimMode = "never";
    project.regions = [square(0, 0, mm(20))];
    const { plan } = digitizeRegions(project.regions, "RT");
    project.plan = plan;
    project.meta.tags = ["花", "サンプル"];
    project.meta.favorite = true;

    const restored = deserializeProject(serializeProject(project));
    expect(restored.name).toBe("テストデザイン");
    expect(restored.settings.colorCount).toBe(8);
    expect(restored.settings.trimMode).toBe("never");
    expect(restored.regions.length).toBe(1);
    expect(restored.plan?.blocks.length).toBe(1);
    expect(restored.meta.tags).toEqual(["花", "サンプル"]);
    expect(restored.meta.favorite).toBe(true);
    expect(restored.id).toBe(project.id);
  });

  it("欠損フィールドは空プロジェクトで補完される (前方互換)", () => {
    const minimal = JSON.stringify({ version: 2, name: "minimal" });
    const restored = deserializeProject(minimal);
    expect(restored.settings.colorCount).toBe(6);
    expect(restored.meta.favorite).toBe(false);
    expect(restored.regions).toEqual([]);
  });

  it("不正な形式・新しすぎるバージョンは例外", () => {
    expect(() => deserializeProject("{}")).toThrow();
    expect(() => deserializeProject(JSON.stringify({ version: 999 }))).toThrow();
  });
});
