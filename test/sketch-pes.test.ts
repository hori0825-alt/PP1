// PP1 Sketch: PES の読み込み (編集用データの埋め込み・縫い目としての取り込み)

import { describe, expect, it } from "vitest";
import { decodePes } from "../src/export/decode";
import { writePes } from "../src/export/pes";
import { validatePlan } from "../src/export/validate";
import { compileSketch, flattenPlan } from "../src/sketch/compile";
import { stitchesLookLikeLine, stitchesToStroke } from "../src/sketch/edit";
import { newDoc, uid, type FillEl, type SketchDoc, type StitchesEl, type StrokeEl, type ThreadRef } from "../src/sketch/model";
import { encodeEmbedded, extractEmbedded, importPes } from "../src/sketch/pesio";

const BLACK: ThreadRef = { r: 0, g: 0, b: 0, pecIndex: 20, name: "Black" };
const YELLOW: ThreadRef = { r: 255, g: 255, b: 0, pecIndex: 13, name: "Yellow" };

function sample(): SketchDoc {
  const doc = newDoc(80, 60);
  doc.settings.name = "TEST";
  const fill: FillEl = {
    kind: "fill",
    id: uid(),
    outer: [
      { x: -15, y: -10 },
      { x: 15.123456, y: -10 },
      { x: 15, y: 10 },
      { x: -15, y: 10 },
    ],
    holes: [],
    angleDeg: 30,
    color: YELLOW,
  };
  const pts = [];
  for (let i = 0; i < 72; i++) pts.push({ x: 18 * Math.cos((i / 72) * Math.PI * 2), y: 13 * Math.sin((i / 72) * Math.PI * 2) });
  const ring: StrokeEl = { kind: "stroke", id: uid(), points: pts, closed: true, width: 2, style: "auto", color: BLACK };
  const line: StrokeEl = {
    kind: "stroke",
    id: uid(),
    points: [
      { x: -20, y: 20 },
      { x: 0, y: 24 },
      { x: 20, y: 20 },
    ],
    closed: false,
    width: 0.5,
    style: "auto",
    color: BLACK,
  };
  doc.layers[0].elements = [fill];
  doc.layers[1].elements = [ring, line];
  doc.layers[1].name = "線画レイヤー";
  return doc;
}

describe("PES に編集用データを埋め込む", () => {
  it("埋め込んでも PEC (刺繍機が読む縫い目) は変わらない", () => {
    const doc = sample();
    const plan = compileSketch(doc).plan;
    const plain = writePes(plan).data;
    const withDoc = writePes(plan, { extra: encodeEmbedded(doc) }).data;
    expect(withDoc.length).toBeGreaterThan(plain.length);
    const a = decodePes(plain);
    const b = decodePes(withDoc);
    expect(b.ops).toEqual(a.ops);
    expect(b.paletteIndices).toEqual(a.paletteIndices);
    expect(b.label).toBe(a.label);
    // PEC 以降のバイト列 (ステッチ・サムネイル) が完全に一致
    expect(Array.from(withDoc.subarray(b.pecOffset))).toEqual(Array.from(plain.subarray(a.pecOffset)));
  });

  it("読み込むと、描いたときの線・面・レイヤー・設定に戻る", () => {
    const doc = sample();
    const pes = writePes(compileSketch(doc).plan, { extra: encodeEmbedded(doc) }).data;
    const r = importPes(pes);
    expect(r.restored).toBe(true);
    expect(r.doc.layers.map((l) => l.name)).toEqual(["塗り", "線画レイヤー"]);
    expect(r.doc.settings.canvasW).toBe(80);
    expect(r.doc.settings.name).toBe("TEST");
    const f = r.doc.layers[0].elements[0] as FillEl;
    expect(f.kind).toBe("fill");
    expect(f.angleDeg).toBe(30);
    expect(f.outer[1].x).toBe(15.123); // 0.001mm に丸めて保存
    const s = r.doc.layers[1].elements[0] as StrokeEl;
    expect(s.width).toBe(2);
    expect(s.closed).toBe(true);
    expect(s.points.length).toBe(72);
    expect(extractEmbedded(writePes(compileSketch(doc).plan).data)).toBeNull();
  });
});

describe("編集用データのない PES は縫い目として取り込む", () => {
  it("色ごとにレイヤーを分け、縫い直すと元と同じ針の位置になる", () => {
    const doc = sample();
    const plan = compileSketch(doc).plan;
    const pes = writePes(plan).data;
    const r = importPes(pes, "PES", { reconstruct: false });
    expect(r.restored).toBe(false);
    expect(r.doc.layers.length).toBe(2);
    expect(r.doc.layers[0].elements.every((e) => e.kind === "stitches")).toBe(true);
    expect((r.doc.layers[0].elements[0] as StitchesEl).color.pecIndex).toBe(13);
    expect((r.doc.layers[1].elements[0] as StitchesEl).color.pecIndex).toBe(20);

    const before = flattenPlan(plan).filter((p) => p.move === 0);
    const again = compileSketch(r.doc);
    const after = flattenPlan(again.plan).filter((p) => p.move === 0);
    // 縫い目の位置の集合が一致する (0.1mm 単位)
    const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    const setA = new Set(before.map(key));
    const setB = new Set(after.map(key));
    let same = 0;
    for (const k of setA) if (setB.has(k)) same++;
    expect(same / setA.size).toBeGreaterThan(0.99);
    expect(Math.abs(after.length - before.length) / before.length).toBeLessThan(0.02);
    expect(validatePlan(again.plan).issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("バージョンの違う PES (#PES0060 など) も読める", () => {
    const pes = writePes(compileSketch(sample()).plan).data.slice();
    pes.set([0x30, 0x30, 0x36, 0x30], 4); // "#PES0060"
    const r = importPes(pes, "PES", { reconstruct: false });
    expect(r.doc.layers.length).toBe(2);
    expect(() => importPes(new TextEncoder().encode("hello world, not a pes"))).toThrow();
  });

  it("ランニングの縫い目は線に変換できる、サテン・タタミは線と見なさない", () => {
    const r = importPes(writePes(compileSketch(sample()).plan).data, "PES", { reconstruct: false });
    const els = r.doc.layers.flatMap((l) => l.elements) as StitchesEl[];
    const kinds = els.map((e) => stitchesLookLikeLine(e.points));
    // 面 (タタミ) とサテンの輪は線ではない。0.5mm の細線 (ランニング) は線
    expect(kinds.filter((k) => k).length).toBeGreaterThanOrEqual(1);
    expect(stitchesLookLikeLine((r.doc.layers[0].elements[0] as StitchesEl).points)).toBe(false);
    const lineEl = els.find((e, i) => kinds[i])!;
    const s = stitchesToStroke(lineEl);
    expect(s.kind).toBe("stroke");
    expect(s.style).toBe("running");
    expect(s.points.length).toBeGreaterThanOrEqual(2);
  });
});

describe("編集用データのない PES から線・面を推定して戻す", () => {
  const K: ThreadRef = { r: 0, g: 0, b: 0, pecIndex: 20 };
  const R: ThreadRef = { r: 237, g: 23, b: 31, pecIndex: 5 };
  const circ = (cx: number, cy: number, r: number, n = 72) =>
    Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((i / n) * 2 * Math.PI), y: cy + r * Math.sin((i / n) * 2 * Math.PI) }));
  const stroke = (points: { x: number; y: number }[], width: number, closed = false): StrokeEl => ({
    kind: "stroke",
    id: uid(),
    points,
    closed,
    width,
    style: "auto",
    color: K,
  });

  function face(): SketchDoc {
    const doc = newDoc();
    doc.layers[0].elements = [
      { kind: "fill", id: uid(), outer: circ(0, 0, 25), holes: [], angleDeg: null, color: YELLOW },
      { kind: "fill", id: uid(), outer: circ(30, 30, 10), holes: [circ(30, 30, 4).reverse()], angleDeg: 0, color: R },
    ];
    doc.layers[1].elements = [
      stroke(circ(0, 0, 25), 2, true), // 輪郭 (サテン)
      stroke([{ x: -10, y: -8 }, { x: -6, y: -8 }], 1), // 目 (3重)
      stroke([{ x: 6, y: -8 }, { x: 10, y: -8 }], 1),
      stroke(Array.from({ length: 11 }, (_, i) => ({ x: -10 + i * 2, y: 8 + 4 * Math.sin((i / 10) * Math.PI) })), 0.5), // 口
      stroke([{ x: -40, y: -40 }, { x: -40, y: -20 }, { x: -20, y: -20 }], 4), // 角のある太線
    ];
    return doc;
  }

  it("サテン・3重・ランニング・タタミ (穴あり) を見分けて、太さ・形を戻す", () => {
    const r = importPes(writePes(compileSketch(face()).plan).data);
    expect(r.restored).toBe(false);
    expect(r.reconstructed).toBe(true);
    const els = r.doc.layers.flatMap((l) => l.elements);
    const fills = els.filter((e) => e.kind === "fill") as FillEl[];
    const strokes = els.filter((e) => e.kind === "stroke") as StrokeEl[];
    expect(els.filter((e) => e.kind === "stitches")).toEqual([]);
    expect(fills.length).toBe(2);
    expect(strokes.length).toBe(5); // 下縫い・つなぎ縫いは消える

    const box = (pts: { x: number; y: number }[]) => [
      Math.min(...pts.map((p) => p.x)),
      Math.min(...pts.map((p) => p.y)),
      Math.max(...pts.map((p) => p.x)),
      Math.max(...pts.map((p) => p.y)),
    ];
    const yellow = fills.find((f) => f.color.pecIndex === 13)!;
    box(yellow.outer).forEach((v, i) => expect(Math.abs(v - [-25, -25, 25, 25][i])).toBeLessThan(0.4));
    const red = fills.find((f) => f.color.pecIndex === 5)!;
    expect(red.holes.length).toBe(1);
    expect(red.angleDeg).toBe(0);

    const ring = strokes.find((s) => s.closed)!;
    expect(ring.width).toBeCloseTo(2, 1);
    const eyes = strokes.filter((s) => s.width === 1);
    expect(eyes.length).toBe(2);
    const mouth = strokes.find((s) => s.width === 0.5)!;
    expect(mouth.points.length).toBeGreaterThanOrEqual(5);
    const thick = strokes.find((s) => s.width > 3)!;
    expect(thick.width).toBeGreaterThan(3.8);
    expect(thick.width).toBeLessThan(4.3);
    // 角が残っている (端と角の3点を通る)
    for (const c of [{ x: -40, y: -40 }, { x: -40, y: -20 }, { x: -20, y: -20 }]) {
      expect(Math.min(...thick.points.map((p) => Math.hypot(p.x - c.x, p.y - c.y)))).toBeLessThan(0.8);
    }
  });

  it("手描きの揺れがある太い線も、細切れにならず1本の線に戻る", () => {
    const wob = (i: number) => 0.4 * Math.sin(i * 1.7) + 0.3 * Math.cos(i * 0.9);
    const doc = newDoc();
    doc.layers[1].elements = [
      stroke(
        Array.from({ length: 90 }, (_, i) => {
          const a = (i / 90) * 2 * Math.PI;
          return { x: (28 + wob(i)) * Math.cos(a), y: (28 + wob(i)) * Math.sin(a) };
        }),
        2,
        true,
      ),
      stroke(Array.from({ length: 41 }, (_, i) => ({ x: -30 + i * 1.5, y: -36 + 3 * Math.sin(i / 3) })), 3),
    ];
    const r = importPes(writePes(compileSketch(doc).plan).data);
    const els = r.doc.layers.flatMap((l) => l.elements) as StrokeEl[];
    expect(els.map((e) => `${e.kind}:${e.width}:${e.closed}`).sort()).toEqual(["stroke:2:true", "stroke:3:false"]);
  });

  it("推定した作品をそのまま縫い直しても、針数は元と大きく変わらない", () => {
    const plan = compileSketch(face()).plan;
    const before = compileSketch(face()).stats.stitches;
    const r = importPes(writePes(plan).data);
    const after = compileSketch(r.doc).stats.stitches;
    expect(Math.abs(after - before) / before).toBeLessThan(0.12);
  });
});
