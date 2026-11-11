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
    const r = importPes(pes);
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
    const r = importPes(pes);
    expect(r.doc.layers.length).toBe(2);
    expect(() => importPes(new TextEncoder().encode("hello world, not a pes"))).toThrow();
  });

  it("ランニングの縫い目は線に変換できる、サテン・タタミは線と見なさない", () => {
    const r = importPes(writePes(compileSketch(sample()).plan).data);
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
