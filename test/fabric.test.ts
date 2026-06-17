// 布地レシピと縫い補正のテスト (Phase 9)。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import { signedArea } from "../src/core/geometry";
import type { Region } from "../src/core/region";
import type { Point } from "../src/core/types";
import { FABRIC_RECIPES, getRecipe, recipeToDigitizeOptions } from "../src/fabric/recipes";
import {
  compensateRegion,
  compensateSatinColumn,
  densityCompensatedSpacing,
  regionArea,
  regionMinExtent,
} from "../src/stitch/compensation";
import { digitizeRegions } from "../src/stitch/digitize";

const RED = { r: 220, g: 30, b: 30 };

function rect(cx: number, cy: number, w: number, h: number): Point[] {
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

function extentX(pts: Point[]): number {
  return Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
}
function extentY(pts: Point[]): number {
  return Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
}

describe("compensateRegion", () => {
  const region: Region = { outer: rect(0, 0, mm(20), mm(20)), holes: [], color: RED };

  it("Pull 補正でステッチ直交方向に広がる (角度0° → y 方向に拡張)", () => {
    // sewAngle=0 → ステッチは水平(x方向)、直交はy。Pull は y を広げる
    const out = compensateRegion(region, { pull: mm(1), push: 0, sewAngleRad: 0 });
    expect(extentY(out.outer)).toBeGreaterThan(extentY(region.outer));
    expect(extentX(out.outer)).toBeCloseTo(extentX(region.outer), 0); // 沿う方向は不変
  });

  it("Push 補正でステッチ方向に縮む (角度0° → x 方向が縮小)", () => {
    const out = compensateRegion(region, { pull: 0, push: mm(2), sewAngleRad: 0 });
    expect(extentX(out.outer)).toBeLessThan(extentX(region.outer));
    expect(extentY(out.outer)).toBeCloseTo(extentY(region.outer), 0);
  });

  it("90°回転: Pull が x 方向に効く", () => {
    const out = compensateRegion(region, { pull: mm(1), push: 0, sewAngleRad: Math.PI / 2 });
    expect(extentX(out.outer)).toBeGreaterThan(extentX(region.outer));
  });

  it("補正値0なら領域は不変", () => {
    const out = compensateRegion(region, { pull: 0, push: 0, sewAngleRad: 0 });
    expect(out).toBe(region);
  });

  it("穴も同じ重心基準で変換される", () => {
    const donut: Region = {
      outer: rect(0, 0, mm(30), mm(30)),
      holes: [rect(0, 0, mm(10), mm(10)).reverse()],
      color: RED,
    };
    const out = compensateRegion(donut, { pull: mm(1), push: 0, sewAngleRad: 0 });
    expect(out.holes.length).toBe(1);
    expect(extentY(out.holes[0])).toBeGreaterThan(extentY(donut.holes[0]));
  });
});

describe("compensateSatinColumn (サテン列の Pull 補正)", () => {
  it("細い列の幅 (短軸) を広げ、長軸は変えない", () => {
    // 横長の列 (長軸 x, 幅 y = 2mm)
    const col: Region = { outer: rect(0, 0, mm(30), mm(2)), holes: [], color: RED };
    const out = compensateSatinColumn(col, mm(0.4));
    expect(extentY(out.outer)).toBeGreaterThan(extentY(col.outer)); // 幅が広がる
    expect(extentX(out.outer)).toBeCloseTo(extentX(col.outer), 0); // 長軸は不変
  });

  it("汎用補正が弾く極細列 (短辺 < 2mm) にも適用される", () => {
    const thin: Region = { outer: rect(0, 0, mm(40), mm(1)), holes: [], color: RED };
    // 汎用補正は minExtent < 20 で素通し
    const generic = compensateRegion(thin, { pull: mm(0.3), push: 0, sewAngleRad: 0 });
    expect(generic).toBe(thin);
    // サテン専用補正は幅を広げる
    const satin = compensateSatinColumn(thin, mm(0.3));
    expect(extentY(satin.outer)).toBeGreaterThan(extentY(thin.outer));
  });

  it("縦長の列でも長軸を検出して幅 (短軸) を広げる", () => {
    const col: Region = { outer: rect(0, 0, mm(2), mm(30)), holes: [], color: RED };
    const out = compensateSatinColumn(col, mm(0.4));
    expect(extentX(out.outer)).toBeGreaterThan(extentX(col.outer)); // 幅 (x) が広がる
    expect(extentY(out.outer)).toBeCloseTo(extentY(col.outer), 0); // 長軸 (y) は不変
  });

  it("拡張量は半幅でクランプされる (幅は最大2倍まで)", () => {
    const col: Region = { outer: rect(0, 0, mm(30), mm(2)), holes: [], color: RED };
    // 過大な pull を与えても幅は 2 倍 (2mm→4mm) を超えない
    const out = compensateSatinColumn(col, mm(10));
    expect(extentY(out.outer)).toBeLessThanOrEqual(mm(2) * 2 + 1);
  });

  it("補正値0なら領域は不変", () => {
    const col: Region = { outer: rect(0, 0, mm(30), mm(2)), holes: [], color: RED };
    expect(compensateSatinColumn(col, 0)).toBe(col);
  });

  it("digitize: 細いサテン列が Pull 補正で太くなる", () => {
    const col = (): Region => ({ outer: rect(0, 0, mm(30), mm(2)), holes: [], color: RED, fillType: "satin" });
    const maxPair = (plan: ReturnType<typeof digitizeRegions>["plan"]): number => {
      let m = 0;
      for (const b of plan.blocks) {
        for (const r of b.runs) {
          if (r.stitchType !== "satin") continue;
          const st = r.stitches;
          for (let i = 0; i + 1 < st.length; i += 2) {
            m = Math.max(m, Math.hypot(st[i + 1].x - st[i].x, st[i + 1].y - st[i].y));
          }
        }
      }
      return m;
    };
    const none = digitizeRegions([col()], "N", { fillType: "satin", underlay: [] });
    const pulled = digitizeRegions([col()], "P", { fillType: "satin", underlay: [], pullCompensation: mm(0.5) });
    expect(maxPair(pulled.plan)).toBeGreaterThan(maxPair(none.plan));
  });
});

describe("densityCompensatedSpacing", () => {
  it("無効時は基準間隔のまま", () => {
    expect(densityCompensatedSpacing(100, mm(0.4), false)).toBe(mm(0.4));
  });
  it("大きい面は基準間隔、小さい面は間隔が広がる", () => {
    const base = mm(0.4);
    expect(densityCompensatedSpacing(20000, base, true)).toBe(base);
    const small = densityCompensatedSpacing(500, base, true);
    expect(small).toBeGreaterThan(base);
    expect(small).toBeLessThanOrEqual(base * 1.4);
  });
});

describe("regionArea / regionMinExtent", () => {
  it("穴を差し引いた面積を返す", () => {
    const donut: Region = {
      outer: rect(0, 0, mm(20), mm(20)),
      holes: [rect(0, 0, mm(10), mm(10)).reverse()],
      color: RED,
    };
    const area = regionArea(donut);
    expect(area).toBeCloseTo(mm(20) * mm(20) - mm(10) * mm(10), -2);
  });
  it("短辺を返す", () => {
    const r: Region = { outer: rect(0, 0, mm(30), mm(5)), holes: [], color: RED };
    expect(regionMinExtent(r)).toBeCloseTo(mm(5), 0);
  });
});

describe("布地レシピ", () => {
  it("全レシピが妥当な値を持つ", () => {
    expect(FABRIC_RECIPES.length).toBeGreaterThanOrEqual(10);
    for (const r of FABRIC_RECIPES) {
      expect(r.tatamiSpacingMm).toBeGreaterThan(0);
      expect(r.stitchLengthMm).toBeGreaterThan(0);
      expect(r.pullCompMm).toBeGreaterThanOrEqual(0);
      expect(r.recommendedNeedle.length).toBeGreaterThan(0);
    }
  });

  it("伸縮素材は標準より Pull 補正が強い", () => {
    expect(getRecipe("stretch").pullCompMm).toBeGreaterThan(getRecipe("standard").pullCompMm);
  });

  it("不明な ID は標準にフォールバック", () => {
    expect(getRecipe("nonexistent").id).toBe("standard");
  });

  it("recipeToDigitizeOptions が内部単位に変換する", () => {
    const opts = recipeToDigitizeOptions(getRecipe("denim"));
    expect(opts.rowSpacing).toBe(mm(getRecipe("denim").tatamiSpacingMm));
    expect(opts.underlay).toEqual(getRecipe("denim").underlay);
  });
});

describe("digitize: 布地補正の統合", () => {
  it("Small Object Protection: 最小サイズ未満が除外され警告が出る", () => {
    const regions: Region[] = [
      { outer: rect(0, 0, mm(20), mm(20)), holes: [], color: RED },
      { outer: rect(mm(30), 0, mm(0.5), mm(0.5)), holes: [], color: RED }, // 極小
    ];
    const { plan, warnings } = digitizeRegions(regions, "SOP", { minObjectExtent: mm(1) });
    // 1領域だけ残る
    const objectIds = new Set(plan.blocks.flatMap((b) => b.runs.map((r) => r.objectId)));
    expect(objectIds.size).toBe(1);
    expect(warnings.some((w) => w.includes("除外"))).toBe(true);
  });

  it("Pull 補正で塗り領域が広がり針数が増える", () => {
    const regions: Region[] = [{ outer: rect(0, 0, mm(20), mm(8)), holes: [], color: RED }];
    const base = digitizeRegions(regions, "A", { angleDeg: 0 });
    const pulled = digitizeRegions(regions, "B", { angleDeg: 0, pullCompensation: mm(1.5) });
    const count = (p: typeof base.plan): number =>
      p.blocks.reduce((n, bl) => n + bl.runs.reduce((m, r) => m + r.stitches.length, 0), 0);
    // Pull で直交方向に広がる → 行数が増える → 針数増
    expect(count(pulled.plan)).toBeGreaterThan(count(base.plan));
  });

  it("auto density で小領域の針数が抑えられる", () => {
    // 10mm 角 = 100mm² (<150mm² 閾値) で密度が下がり、行数=針数が減る
    const regions: Region[] = [{ outer: rect(0, 0, mm(10), mm(10)), holes: [], color: RED }];
    const dense = digitizeRegions(regions, "D", { angleDeg: 0, autoDensity: false });
    const auto = digitizeRegions(regions, "E", { angleDeg: 0, autoDensity: true });
    const count = (p: typeof dense.plan): number =>
      p.blocks.reduce((n, bl) => n + bl.runs.reduce((m, r) => m + r.stitches.length, 0), 0);
    expect(count(auto.plan)).toBeLessThan(count(dense.plan));
  });
});
