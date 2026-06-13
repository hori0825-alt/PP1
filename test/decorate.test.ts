// 装飾配置とアップリケのテスト (Phase 12)。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import { pathBounds, signedArea } from "../src/core/geometry";
import type { Region } from "../src/core/region";
import type { Point } from "../src/core/types";
import { appliqueBlocks, appliquePlan } from "../src/applique/applique";
import {
  makeKaleidoscope,
  makeMirror,
  makeRadial,
  normalizeRegion,
  rotateRegion,
} from "../src/decorate/arrange";

const RED = { r: 220, g: 30, b: 30 };

function tri(cx: number, cy: number, s: number): Point[] {
  // 時計回りの三角形 (signedArea > 0)
  return [
    { x: cx, y: cy - s },
    { x: cx + s, y: cy + s },
    { x: cx - s, y: cy + s },
  ];
}
function region(pts: Point[]): Region {
  return { outer: signedArea(pts) < 0 ? [...pts].reverse() : pts, holes: [], color: RED };
}

describe("normalizeRegion", () => {
  it("外周を正、穴を負に揃える", () => {
    const r: Region = {
      outer: [...tri(0, 0, mm(5))].reverse(), // 負にしておく
      holes: [tri(0, 0, mm(2))], // 正にしておく
      color: RED,
    };
    const n = normalizeRegion(r);
    expect(signedArea(n.outer)).toBeGreaterThan(0);
    expect(signedArea(n.holes[0])).toBeLessThan(0);
  });
});

describe("makeMirror", () => {
  it("左右反転コピーを追加し、全体が x=0 で対称になる", () => {
    const src = [region(tri(mm(20), 0, mm(5)))];
    const out = makeMirror(src, "x", 0);
    expect(out.length).toBe(2);
    // 反転コピーは x が負側
    const b0 = pathBounds(out[0].outer);
    const b1 = pathBounds(out[1].outer);
    expect((b0.minX + b0.maxX) / 2).toBeCloseTo(mm(20), 0);
    expect((b1.minX + b1.maxX) / 2).toBeCloseTo(-mm(20), 0);
    // 反転後も外周は正の巻き (normalize 済み)
    expect(signedArea(out[1].outer)).toBeGreaterThan(0);
  });

  it("keepOriginal=false で反転のみ返す", () => {
    const out = makeMirror([region(tri(mm(20), 0, mm(5)))], "y", 0, false);
    expect(out.length).toBe(1);
    expect(pathBounds(out[0].outer).minY).toBeLessThan(0);
  });
});

describe("rotateRegion", () => {
  it("中心まわりに回転する", () => {
    const r = region(tri(mm(20), 0, mm(3)));
    const rotated = rotateRegion(r, { x: 0, y: 0 }, Math.PI / 2);
    const b = pathBounds(rotated.outer);
    // (20,0) 付近 → 90度回転で (0,20) 付近
    expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 0);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(mm(20), 0);
    expect(signedArea(rotated.outer)).toBeGreaterThan(0);
  });
});

describe("makeRadial", () => {
  it("count 個を円周上に等角配置する", () => {
    const src = [region(tri(mm(25), 0, mm(4)))];
    const out = makeRadial(src, { count: 6, center: { x: 0, y: 0 } });
    expect(out.length).toBe(6);
    // 各コピーの重心が中心から ~25mm の円周上
    for (const r of out) {
      const cx = r.outer.reduce((s, p) => s + p.x, 0) / r.outer.length;
      const cy = r.outer.reduce((s, p) => s + p.y, 0) / r.outer.length;
      expect(Math.hypot(cx, cy)).toBeGreaterThan(mm(20));
      expect(Math.hypot(cx, cy)).toBeLessThan(mm(30));
    }
    // 全体は原点対称に近い (重心の合計 ≈ 0)
    const sx = out.reduce((s, r) => s + r.outer.reduce((a, p) => a + p.x, 0) / r.outer.length, 0);
    expect(Math.abs(sx)).toBeLessThan(mm(2));
  });

  it("rotateEach=false は自転しない (向き一定)", () => {
    const src = [region(tri(mm(25), 0, mm(4)))];
    const out = makeRadial(src, { count: 4, rotateEach: false });
    // 全コピーの「上頂点→底辺」向きが元と同じ (相対形状不変)
    for (const r of out) {
      const top = r.outer[0];
      const cx = r.outer.reduce((s, p) => s + p.x, 0) / r.outer.length;
      const cy = r.outer.reduce((s, p) => s + p.y, 0) / r.outer.length;
      // 頂点は重心より上 (y 小)
      expect(top.y).toBeLessThan(cy);
      void cx;
    }
  });
});

describe("makeKaleidoscope", () => {
  it("segments の2倍 (回転コピー + 鏡像) を返す", () => {
    const src = [region(tri(mm(20), mm(5), mm(4)))];
    const out = makeKaleidoscope(src, { segments: 4 });
    expect(out.length).toBe(8);
    for (const r of out) expect(signedArea(r.outer)).toBeGreaterThan(0);
  });
});

describe("appliqueBlocks", () => {
  const r = region(tri(0, 0, mm(15)));

  it("配置線→仮止め→仕上げの3工程を別ブロックで生成する", () => {
    const blocks = appliqueBlocks(r, { satinWidthMm: 2.5 });
    expect(blocks.length).toBe(3);
    expect(blocks[0].thread.name).toBe("配置線");
    expect(blocks[1].thread.name).toBe("仮止め");
    // 仕上げは region の色
    expect(blocks[2].thread.r).toBe(RED.r);
    // 工程はランニング/サテンのタイプを持つ
    expect(blocks[0].runs[0].stitchType).toBe("running");
    expect(blocks[2].runs[0].stitchType).toBe("satin");
  });

  it("各工程は連続 Run (工程内に糸切りなし)", () => {
    const blocks = appliqueBlocks(r);
    for (const b of blocks) {
      for (const run of b.runs) {
        expect(run.stitches.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("appliquePlan は工程が色替えで区切られる (= 実機停止)", () => {
    const plan = appliquePlan([r], "APPLIQUE");
    // 3工程 → 3ブロック → 色替え2回 (= 工程停止)
    expect(plan.blocks.length).toBe(3);
  });
});
