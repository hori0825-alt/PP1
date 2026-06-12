// v2 オブジェクトベースパイプライン (objectizer + planner + diagnostics) のテスト

import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL, type GlobalSettings } from "../src/core/object";
import { objectize } from "../src/core/objectizer";
import { compilePlan, compileWithLimit } from "../src/core/planner";
import { diagnose, worstLevel } from "../src/core/diagnostics";
import { COLOR_CHANGE, STITCH, TRIM } from "../src/embroidery/pattern";

function blank(w: number, h: number) {
  return new Uint8ClampedArray(w * h * 4);
}
function set(d: Uint8ClampedArray, w: number, x: number, y: number, r: number, g: number, b: number) {
  const i = (y * w + x) * 4;
  d[i] = r;
  d[i + 1] = g;
  d[i + 2] = b;
  d[i + 3] = 255;
}

const G: GlobalSettings = {
  ...DEFAULT_GLOBAL,
  sizeMm: 60,
  autoBackground: false,
  outline: false,
  outlineSmoothing: 0,
  autoThinDetect: false,
};

/** 赤い四角2つ + 黒い線1本 */
function testImage() {
  const w = 200;
  const h = 200;
  const d = blank(w, h);
  for (let y = 20; y < 80; y++) for (let x = 20; x < 80; x++) set(d, w, x, y, 220, 50, 50);
  for (let y = 120; y < 180; y++) for (let x = 120; x < 180; x++) set(d, w, x, y, 220, 50, 50);
  for (let x = 20; x < 180; x++) for (let y = 98; y < 101; y++) set(d, w, x, y, 30, 30, 30);
  return { data: d, width: w, height: h };
}

describe("objectize (オートデジタイズ)", () => {
  it("色ごとのコンポーネントが刺繍オブジェクトになる", () => {
    const oz = objectize(testImage(), { ...G, autoThinDetect: true });
    // 赤2 + 黒線1 = 3オブジェクト
    expect(oz.objects.length).toBe(3);
    expect(oz.order.length).toBe(3);
    const kinds = oz.objects.map((o) => o.settings.kind);
    expect(kinds.filter((k) => k === "tatami").length).toBe(2);
    expect(kinds.filter((k) => k !== "tatami").length).toBe(1); // 黒線はサテン/中心線
  });

  it("線画系の色は縫い順の最後になる", () => {
    const oz = objectize(testImage(), { ...G, autoThinDetect: true });
    const lastId = oz.order[oz.order.length - 1];
    const lastObj = oz.objects.find((o) => o.id === lastId)!;
    expect(lastObj.settings.kind).not.toBe("tatami"); // 黒線が最後
  });
});

describe("compilePlan (縫い計画)", () => {
  it("オブジェクト内部に糸切り・色替えが存在しない", () => {
    const oz = objectize(testImage(), G);
    const plan = compilePlan(oz.objects, oz.order, G, oz.quant, oz.transform, oz.mmPerPx);
    for (const seg of plan.segments) {
      for (let i = seg.from; i < seg.to; i++) {
        const cmd = plan.pattern.stitches[i].cmd;
        expect(cmd === TRIM || cmd === COLOR_CHANGE).toBe(false);
      }
    }
  });

  it("セグメントは縫い順と一致し、針数を持つ", () => {
    const oz = objectize(testImage(), G);
    const plan = compilePlan(oz.objects, oz.order, G, oz.quant, oz.transform, oz.mmPerPx);
    expect(plan.segments.length).toBe(3);
    expect(plan.segments.map((s) => s.objectId)).toEqual(
      oz.order.filter((id) => plan.segments.some((s) => s.objectId === id)),
    );
    for (const seg of plan.segments) expect(seg.stitches).toBeGreaterThan(0);
    // 範囲が重ならず昇順
    for (let i = 1; i < plan.segments.length; i++) {
      expect(plan.segments[i].from).toBeGreaterThanOrEqual(plan.segments[i - 1].to);
    }
  });

  it("trimMode=never では糸切りが発生しない", () => {
    const oz = objectize(testImage(), G);
    for (const o of oz.objects) o.settings.trimMode = "never";
    const plan = compilePlan(
      oz.objects,
      oz.order,
      { ...G, trimMode: "never" },
      oz.quant,
      oz.transform,
      oz.mmPerPx,
    );
    // 色替え分の TRIM はあるが、同色間の TRIM はゼロ
    expect(plan.stats.trims).toBe(plan.stats.colorChanges);
  });

  it("trimMode=always では同色オブジェクト間も毎回糸切りする", () => {
    const oz = objectize(testImage(), G);
    for (const o of oz.objects) o.settings.trimMode = "always";
    const plan = compilePlan(oz.objects, oz.order, G, oz.quant, oz.transform, oz.mmPerPx);
    // 3オブジェクト: 開始1 + 同色間1(always) + 色替え1 → trims = 同色間1 + 色替え前1 = 2
    expect(plan.stats.trims).toBeGreaterThanOrEqual(2);
  });

  it("非表示オブジェクトは縫われない", () => {
    const oz = objectize(testImage(), G);
    oz.objects[0].settings.visible = false;
    const plan = compilePlan(oz.objects, oz.order, G, oz.quant, oz.transform, oz.mmPerPx);
    expect(plan.segments.length).toBe(2);
  });

  it("縫い順の並べ替えがセグメント順に反映される", () => {
    const oz = objectize(testImage(), G);
    const reversed = [...oz.order].reverse();
    const plan = compilePlan(oz.objects, reversed, G, oz.quant, oz.transform, oz.mmPerPx);
    expect(plan.segments[0].objectId).toBe(reversed[0]);
  });
});

describe("compileWithLimit (12,000針制限)", () => {
  it("上限を超える場合は密度を緩めて収める", () => {
    const w = 200;
    const h = 200;
    const d = blank(w, h);
    for (let y = 5; y < 195; y++) for (let x = 5; x < 195; x++) set(d, w, x, y, 220, 50, 50);
    const g: GlobalSettings = { ...G, sizeMm: 95, maxStitches: 4000 };
    const oz = objectize({ data: d, width: w, height: h }, g);
    const r = compileWithLimit(oz.objects, oz.order, g, oz.quant, oz.transform, oz.mmPerPx);
    expect(r.plan.stats.stitches).toBeLessThanOrEqual(4000);
    expect(r.adjusted).not.toBeNull();
    expect(r.overLimit).toBe(false);
  });
});

describe("diagnose (刺繍データ診断)", () => {
  it("正常データは OK、針数超過は修正必須", () => {
    const oz = objectize(testImage(), G);
    const plan = compilePlan(oz.objects, oz.order, G, oz.quant, oz.transform, oz.mmPerPx);
    const items = diagnose(plan, G);
    expect(worstLevel(items)).not.toBe("error");
    const midTrims = items.find((i) => i.id === "midTrims")!;
    expect(midTrims.level).toBe("ok");

    const strict = diagnose(plan, { ...G, maxStitches: 10 });
    expect(worstLevel(strict)).toBe("error");
    expect(strict.find((i) => i.id === "stitches")!.fix).toBe("reduceStitches");
  });
});
