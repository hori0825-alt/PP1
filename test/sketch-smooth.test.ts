// PP1 Sketch: 線を滑らかな曲線として縫う (カクカクしない)

import { describe, expect, it } from "vitest";
import { compileSketch, flattenPlan } from "../src/sketch/compile";
import { dist, distToPolyline, resampleAdaptive, smoothCurve } from "../src/sketch/geom";
import { newDoc, uid, type StrokeEl, type Vec } from "../src/sketch/model";

const K = { r: 0, g: 0, b: 0, pecIndex: 20 };

function circlePts(r: number, n: number): Vec[] {
  return Array.from({ length: n }, (_, i) => ({ x: r * Math.cos((i / n) * 2 * Math.PI), y: r * Math.sin((i / n) * 2 * Math.PI) }));
}

describe("smoothCurve", () => {
  it("描いた点を必ず通り、点の間は滑らかにつなぐ", () => {
    const ctrl = circlePts(5, 10);
    const c = smoothCurve(ctrl, true);
    for (const p of ctrl) expect(Math.min(...c.map((q) => dist(p, q)))).toBeLessThan(1e-6);
    // 10角形の辺 (中心から 4.76mm) よりも、本来の円 (5mm) に近い
    const radii = c.map((p) => Math.hypot(p.x, p.y));
    expect(Math.min(...radii)).toBeGreaterThan(4.9);
    expect(c.length).toBeGreaterThan(80);
  });

  it("はっきり曲げた角 (四角の角・文字の角) は角のまま", () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const c = smoothCurve(sq, true);
    // 角を丸めず、辺からはみ出さない
    for (const p of c) expect(distToPolyline(p, sq, true)).toBeLessThan(1e-6);
    const v = smoothCurve([{ x: 0, y: 0 }, { x: 5, y: 10 }, { x: 10, y: 0 }], false);
    expect(Math.min(...v.map((q) => dist(q, { x: 5, y: 10 })))).toBeLessThan(1e-6);
    for (const p of v) expect(distToPolyline(p, [{ x: 0, y: 0 }, { x: 5, y: 10 }, { x: 10, y: 0 }], false)).toBeLessThan(1e-6);
  });

  it("2点以下はそのまま", () => {
    expect(smoothCurve([{ x: 0, y: 0 }, { x: 1, y: 1 }], false)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });
});

describe("resampleAdaptive", () => {
  it("急なカーブほど針目が短く、曲線からのずれは許容値以内", () => {
    const path = smoothCurve(circlePts(3, 24), true);
    const ring = [...path, path[0]];
    const needles = resampleAdaptive(ring, 2, 0.8, 0.05);
    for (let i = 1; i < needles.length; i++) {
      const L = dist(needles[i - 1], needles[i]);
      expect(L).toBeLessThanOrEqual(2 + 1e-6);
      expect(L).toBeGreaterThan(0.39);
      // 弦の中点が円 (半径3) からどれだけ離れるか
      const m = { x: (needles[i - 1].x + needles[i].x) / 2, y: (needles[i - 1].y + needles[i].y) / 2 };
      expect(3 - Math.hypot(m.x, m.y)).toBeLessThan(0.06);
    }
    // 半径 3mm の円は 2mm 針目なら 10針程度。滑らかにするためそれより細かい
    expect(needles.length).toBeGreaterThan(14);
  });

  it("まっすぐな線は最大の針目で縫う", () => {
    const line = smoothCurve([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }], false);
    const n = resampleAdaptive(line, 2, 0.8, 0.05);
    expect(n.length).toBe(6);
    expect(n[n.length - 1]).toEqual({ x: 10, y: 0 });
  });
});

describe("compileSketch: 線は滑らかな曲線に沿って縫う", () => {
  it("少ない点で描いた小さな円も、針の位置が本来の円に沿う", () => {
    for (const width of [0.5, 1.0]) {
      const doc = newDoc();
      const el: StrokeEl = { kind: "stroke", id: uid(), points: circlePts(4, 12), closed: true, width, style: "auto", color: K };
      doc.layers[1].elements = [el];
      const pts = flattenPlan(compileSketch(doc).plan)
        .filter((p) => p.move === 0)
        .map((p) => ({ x: p.x / 10, y: p.y / 10 }));
      // 0.1mm 単位への丸め + 曲線の誤差で、円から 0.15mm 以内
      for (const p of pts) expect(Math.abs(Math.hypot(p.x, p.y) - 4)).toBeLessThan(0.15);
      // 円周 25mm を 2mm 針目 (13針) より細かく縫う
      const unique = new Set(pts.map((p) => `${p.x},${p.y}`));
      expect(unique.size).toBeGreaterThan(16);
    }
  });
});
