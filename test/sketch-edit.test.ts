// PP1 Sketch: 描いた後の修正操作 (edit.ts) のテスト

import { describe, expect, it } from "vitest";
import {
  decimate,
  deleteNodes,
  duplicateElements,
  elementBox,
  flipElement,
  insertNode,
  mapElement,
  nearestNode,
  nearestSegment,
  nodeCount,
  rotateElement,
  scaleFn,
  selectionBox,
  softMoveNodes,
  subdivide,
} from "../src/sketch/edit";
import { compileSketch } from "../src/sketch/compile";
import {
  imageCorners,
  newDoc,
  parseDocWithImages,
  uid,
  type FillEl,
  type ImageEl,
  type StrokeEl,
  type ThreadRef,
} from "../src/sketch/model";

const BLACK: ThreadRef = { r: 0, g: 0, b: 0, pecIndex: 20 };

function line(n = 20, len = 20): StrokeEl {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push({ x: (len * i) / n, y: 0 });
  return { kind: "stroke", id: uid(), points: pts, closed: false, width: 1, style: "auto", color: BLACK };
}

function ring(h = 10, angleDeg: number | null = null): FillEl {
  return {
    kind: "fill",
    id: uid(),
    outer: [
      { x: -h, y: -h },
      { x: h, y: -h },
      { x: h, y: h },
      { x: -h, y: h },
    ],
    holes: [
      [
        { x: -2, y: -2 },
        { x: -2, y: 2 },
        { x: 2, y: 2 },
        { x: 2, y: -2 },
      ],
    ],
    angleDeg,
    color: BLACK,
  };
}

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe("部品の変形", () => {
  it("外接矩形は線の太さぶん広がる", () => {
    const b = elementBox(line());
    expect(b).toEqual({ minX: -0.5, minY: -0.5, maxX: 20.5, maxY: 0.5 });
    expect(selectionBox([])).toBeNull();
  });

  it("拡大縮小は基準点を固定し、穴も一緒に変わる", () => {
    const f = mapElement(ring(), scaleFn(-10, -10, 2, 0.5)) as FillEl;
    expect(f.outer[0]).toEqual({ x: -10, y: -10 });
    expect(f.outer[2]).toEqual({ x: 30, y: 0 });
    expect(f.holes[0][2]).toEqual({ x: 14, y: -4 });
  });

  it("回転で点と縫い角度が回る (自動角度はそのまま)", () => {
    const f = rotateElement(ring(10, 30), 0, 0, Math.PI / 2) as FillEl;
    close(f.outer[0].x, 10);
    close(f.outer[0].y, -10);
    expect(f.angleDeg).toBe(120);
    const auto = rotateElement(ring(10, null), 0, 0, 1) as FillEl;
    expect(auto.angleDeg).toBeNull();
  });

  it("左右反転で x が反転し、角度は 180-角度", () => {
    const f = flipElement(ring(10, 30), 0, 0, true) as FillEl;
    expect(f.outer[0]).toEqual({ x: 10, y: -10 });
    expect(f.angleDeg).toBe(150);
    const s = flipElement(line(), 0, 0, false) as StrokeEl;
    expect(s.points[5].y === 0 || Object.is(s.points[5].y, -0)).toBe(true);
  });

  it("複製は新しい id でずらした位置にでき、元は変わらない", () => {
    const a = line();
    const [b] = duplicateElements([a], 5, 3) as StrokeEl[];
    expect(b.id).not.toBe(a.id);
    expect(b.points[0]).toEqual({ x: 5, y: 3 });
    expect(a.points[0]).toEqual({ x: 0, y: 0 });
    b.points[1].x = 999;
    expect(a.points[1].x).not.toBe(999);
  });
});

describe("編集点", () => {
  it("近い点・近い辺を見つける", () => {
    const f = ring();
    expect(nearestNode(f, { x: 9.5, y: 9.6 }, 1)).toEqual({ ring: 0, index: 2 });
    expect(nearestNode(f, { x: 0, y: 0 }, 1)).toBeNull();
    const seg = nearestSegment(f, { x: 0, y: 10.3 }, 1)!;
    expect(seg.ring).toBe(0);
    expect(seg.index).toBe(2); // (10,10)→(-10,10) の辺
    expect(seg.point).toEqual({ x: 0, y: 10 });
    // 閉じた輪は最後→最初の辺も対象
    expect(nearestSegment(f, { x: -10.2, y: 0 }, 1)!.index).toBe(3);
  });

  it("辺に点を追加できる", () => {
    const f = ring();
    const { el, ref } = insertNode(f, 0, 2, { x: 0, y: 10 });
    expect(ref).toEqual({ ring: 0, index: 3 });
    expect((el as FillEl).outer.length).toBe(5);
    expect((el as FillEl).outer[3]).toEqual({ x: 0, y: 10 });
    expect(f.outer.length).toBe(4); // 元は変わらない
  });

  it("点を削除できるが、最低限の点数は残す", () => {
    const s = line(4);
    const d = deleteNodes(s, [1, 2, 3].map((index) => ({ ring: 0, index }))) as StrokeEl;
    expect(d.points.length).toBe(2);
    const all = deleteNodes(s, [0, 1, 2, 3, 4].map((index) => ({ ring: 0, index }))) as StrokeEl;
    expect(all.points.length).toBe(2);
    const f = deleteNodes(ring(), [0, 1, 2, 3].map((index) => ({ ring: 0, index }))) as FillEl;
    expect(f.outer.length).toBe(3);
  });

  it("穴の点を3点未満にすると穴ごと消える", () => {
    const f = deleteNodes(ring(), [
      { ring: 1, index: 0 },
      { ring: 1, index: 1 },
    ]) as FillEl;
    expect(f.holes.length).toBe(0);
    expect(f.outer.length).toBe(4);
  });

  it("やわらか変形: 選んだ点は全部動き、遠い点は動かない", () => {
    const s = line(20, 20); // 1mm 間隔
    const m = softMoveNodes(s, [{ ring: 0, index: 10 }], 0, 5, 4) as StrokeEl;
    expect(m.points[10].y).toBe(5);
    expect(m.points[8].y).toBeGreaterThan(0);
    expect(m.points[8].y).toBeLessThan(5);
    expect(m.points[12].y).toBeCloseTo(m.points[8].y, 9);
    expect(m.points[14].y).toBe(0);
    expect(m.points[0].y).toBe(0);
    // 半径 0 なら選んだ点だけ
    const hard = softMoveNodes(s, [{ ring: 0, index: 10 }], 0, 5, 0) as StrokeEl;
    expect(hard.points[9].y).toBe(0);
  });

  it("やわらか変形は閉じた輪の継ぎ目をまたいで効く", () => {
    const pts = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      pts.push({ x: 10 * Math.cos(a), y: 10 * Math.sin(a) });
    }
    const c: StrokeEl = { ...line(), points: pts, closed: true };
    const m = softMoveNodes(c, [{ ring: 0, index: 0 }], 3, 0, 4) as StrokeEl;
    expect(m.points[39].x).toBeGreaterThan(pts[39].x);
    expect(m.points[1].x - pts[1].x).toBeCloseTo(m.points[39].x - pts[39].x, 6);
  });

  it("間引くと点が減り、増やすと各辺に中点が入る", () => {
    const pts = [];
    for (let i = 0; i <= 60; i++) pts.push({ x: i * 0.5, y: Math.sin(i * 0.2) * 3 });
    const s: StrokeEl = { ...line(), points: pts };
    const d = decimate(s) as StrokeEl;
    expect(d.points.length).toBeLessThanOrEqual(Math.floor(61 * 0.6));
    expect(d.points.length).toBeGreaterThanOrEqual(2);
    expect(d.points[0]).toEqual(pts[0]);
    expect(d.points[d.points.length - 1]).toEqual(pts[60]);

    const f = subdivide(ring()) as FillEl;
    expect(f.outer.length).toBe(8);
    expect(f.outer[1]).toEqual({ x: 0, y: -10 });
    expect(f.outer[7]).toEqual({ x: -10, y: 0 }); // 閉じる辺の中点
    expect(nodeCount(f)).toBe(16);
    expect((subdivide(line(4)) as StrokeEl).points.length).toBe(9);
  });
});

describe("下敷きの画像とキャンバス", () => {
  const img = (): ImageEl => ({
    kind: "image",
    id: uid(),
    imageId: "img1",
    p0: { x: -10, y: -5 },
    p1: { x: 10, y: -5 },
    p2: { x: -10, y: 5 },
    opacity: 0.5,
  });

  it("画像は縫わない (コンパイル結果に出てこない)", () => {
    const doc = newDoc();
    doc.layers[0].elements.push(img());
    doc.layers[1].elements.push(line());
    const res = compileSketch(doc);
    expect(res.seq.length).toBe(1);
    expect(res.seq[0].kind).toBe("stroke");
    const only = newDoc();
    only.layers[0].elements.push(img());
    expect(compileSketch(only).stats.stitches).toBe(0);
  });

  it("画像も拡大縮小・回転・反転できる (3つの角で表す)", () => {
    expect(elementBox(img())).toEqual({ minX: -10, minY: -5, maxX: 10, maxY: 5 });
    const s = mapElement(img(), scaleFn(0, 0, 2, 2)) as ImageEl;
    expect(imageCorners(s)[2]).toEqual({ x: 20, y: 10 });
    const r = rotateElement(img(), 0, 0, Math.PI / 2) as ImageEl;
    close(r.p0.x, 5);
    close(r.p0.y, -10);
    const f = flipElement(img(), 0, 0, true) as ImageEl;
    expect(f.p0).toEqual({ x: 10, y: -5 });
    expect(f.p1).toEqual({ x: -10, y: -5 });
    expect(nodeCount(img())).toBe(0);
    const [d] = duplicateElements([img()], 3, 0) as ImageEl[];
    expect(d.imageId).toBe("img1");
    expect(d.p0).toEqual({ x: -7, y: -5 });
  });

  it("キャンバスのサイズは作品に保存され、古いファイルは 100×100 になる", () => {
    const d = newDoc(80, 50);
    expect([d.settings.canvasW, d.settings.canvasH]).toEqual([80, 50]);
    const old = JSON.stringify({ app: "pp1-sketch", version: 1, layers: [], settings: { name: "OLD" } });
    const p = parseDocWithImages(old);
    expect([p.doc.settings.canvasW, p.doc.settings.canvasH]).toEqual([100, 100]);
    expect(p.images).toEqual({});
    const withImg = JSON.stringify({ ...d, images: { img1: "data:image/png;base64,AAAA" } });
    expect(parseDocWithImages(withImg).images.img1).toContain("data:image/png");
  });
});
