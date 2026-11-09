// PP1 Sketch (お絵かき → 刺繍) のコンパイラとバケツ塗りのテスト

import { describe, expect, it } from "vitest";
import { bucketFill } from "../src/sketch/bucket";
import { compileSketch, flattenPlan, planOrder } from "../src/sketch/compile";
import { newDoc, newLayer, uid, type FillEl, type SketchDoc, type StrokeEl, type ThreadRef } from "../src/sketch/model";
import { validatePlan } from "../src/export/validate";
import { writePes } from "../src/export/pes";
import { writeDst } from "../src/export/dst";

const BLACK: ThreadRef = { r: 0, g: 0, b: 0, pecIndex: 20 };
const RED: ThreadRef = { r: 237, g: 23, b: 31, pecIndex: 5 };
const YELLOW: ThreadRef = { r: 255, g: 255, b: 0, pecIndex: 13 };

function line(x0: number, y0: number, x1: number, y1: number, width: number, color = BLACK): StrokeEl {
  const pts = [];
  const n = 20;
  for (let i = 0; i <= n; i++) pts.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n });
  return { kind: "stroke", id: uid(), points: pts, closed: false, width, style: "auto", color };
}

function circleStroke(cx: number, cy: number, r: number, width: number, color = BLACK): StrokeEl {
  const pts = [];
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return { kind: "stroke", id: uid(), points: pts, closed: true, width, style: "auto", color };
}

function square(cx: number, cy: number, h: number, color = YELLOW): FillEl {
  return {
    kind: "fill",
    id: uid(),
    outer: [
      { x: cx - h, y: cy - h },
      { x: cx + h, y: cy - h },
      { x: cx + h, y: cy + h },
      { x: cx - h, y: cy + h },
    ],
    holes: [],
    angleDeg: null,
    color,
  };
}

function docWith(...layers: StrokeEl[][] | (StrokeEl | FillEl)[][]): SketchDoc {
  const doc = newDoc();
  doc.layers = layers.map((els, i) => {
    const l = newLayer(`L${i}`);
    l.elements = els as (StrokeEl | FillEl)[];
    return l;
  });
  return doc;
}

describe("compileSketch: 縫い順", () => {
  it("レイヤー順がそのまま縫い順になる (下のレイヤーが先)", () => {
    const fill = square(0, 0, 10);
    const outline = circleStroke(0, 0, 12, 2);
    const res = compileSketch(docWith([fill], [outline]));
    expect(res.seq.map((s) => s.elementId)).toEqual([fill.id, outline.id]);
  });

  it("レイヤーを入れ替えると縫い順も入れ替わる", () => {
    const fill = square(0, 0, 10);
    const outline = circleStroke(0, 0, 12, 2);
    const res = compileSketch(docWith([outline], [fill]));
    expect(res.seq.map((s) => s.elementId)).toEqual([outline.id, fill.id]);
  });

  it("レイヤー内では同じ色がまとまり、色替えが最少になる", () => {
    // 黒・赤・黒・赤 の順で描いても、縫うときは 黒黒 → 赤赤
    const els = [
      line(-30, -20, -10, -20, 2, BLACK),
      line(-30, 0, -10, 0, 2, RED),
      line(10, -20, 30, -20, 2, BLACK),
      line(10, 0, 30, 0, 2, RED),
    ];
    const res = compileSketch(docWith(els));
    expect(res.stats.colorChanges).toBe(1);
  });

  it("同じレイヤーに線と面があると、面を先に縫う (線が埋もれない)", () => {
    const outline = circleStroke(0, 0, 12, 2);
    const fill = square(0, 0, 10);
    const res = compileSketch(docWith([outline, fill])); // 線を先に描いた
    expect(res.seq.map((s) => s.elementId)).toEqual([fill.id, outline.id]);
  });

  it("manual のレイヤーは描いた順に縫う", () => {
    const els = [line(-30, 0, -10, 0, 2, BLACK), line(-30, 10, -10, 10, 2, RED), line(10, 0, 30, 0, 2, BLACK)];
    const doc = docWith(els);
    doc.layers[0].order = "manual";
    const res = compileSketch(doc);
    expect(res.seq.map((s) => s.elementId)).toEqual(els.map((e) => e.id));
    expect(res.stats.colorChanges).toBe(2);
  });

  it("線は近い端から縫い始める (逆向き)", () => {
    const a = line(-30, 0, 0, 0, 2);
    const b = line(30, 0, 1, 0, 2); // b の終点 (1,0) が a の終点 (0,0) に近い
    const units = planOrder(docWith([a, b]).layers);
    expect(units[1].reversed).toBe(true);
  });

  it("非表示レイヤーは縫わない", () => {
    const doc = docWith([square(0, 0, 10)], [circleStroke(0, 0, 12, 2)]);
    doc.layers[1].visible = false;
    const res = compileSketch(doc);
    expect(res.seq.length).toBe(1);
  });
});

describe("compileSketch: 糸切り", () => {
  it("部品の中では絶対に糸切りしない (validatePlan の trim-in-object がない)", () => {
    const doc = docWith(
      [square(-20, -20, 12, YELLOW), square(20, 20, 12, RED)],
      [circleStroke(-20, -20, 13, 2), circleStroke(20, 20, 13, 2), line(-40, 40, 40, 40, 0.5)],
    );
    const res = compileSketch(doc);
    const v = validatePlan(res.plan);
    expect(v.issues.find((i) => i.code === "trim-in-object")).toBeUndefined();
    expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("つながった線 (端が接している) は糸切りゼロ", () => {
    const els = [line(-20, 0, 0, 0, 2), line(0, 0, 0, 20, 2), line(0, 20, 20, 20, 2)];
    const res = compileSketch(docWith(els));
    expect(res.stats.trims).toBe(0);
    expect(res.stats.jumps).toBe(0);
  });

  it("後で縫う面の下を通る渡りは、糸切りせずつなぎ縫いになる", () => {
    // 下レイヤー: 黒い線2本 (離れている)。上レイヤー: その間を覆う黄色い面
    const a = line(-20, 0, -5, 0, 2, BLACK);
    const b = line(5, 0, 20, 0, 2, BLACK);
    const cover = square(0, 0, 8, YELLOW);
    const res = compileSketch(docWith([a, b], [cover]));
    const second = res.seq.find((s) => s.elementId === b.id)!;
    expect(second.join).toBe("walk");
  });

  it("隠れない遠い渡りは糸切り、近い渡りは渡り糸 (auto)", () => {
    const near = compileSketch(docWith([line(-10, 0, -3, 0, 2), line(3, 0, 10, 0, 2)]));
    expect(near.seq[1].join).toBe("jump");
    const far = compileSketch(docWith([line(-40, 0, -30, 0, 2), line(30, 0, 40, 0, 2)]));
    expect(far.seq[1].join).toBe("trim");
  });

  it("trimPolicy=fewer は隠れない渡りも糸切りしない", () => {
    const doc = docWith([line(-40, 0, -30, 0, 2), line(30, 0, 40, 0, 2)]);
    doc.settings.trimPolicy = "fewer";
    const res = compileSketch(doc);
    expect(res.stats.trims).toBe(0);
    expect(res.seq[1].join).toBe("jump");
  });
});

describe("compileSketch: 縫い方", () => {
  it("細い線はランニング、中くらいは3重、太い線はサテン", () => {
    const res = compileSketch(docWith([line(-30, -10, 30, -10, 0.5), line(-30, 0, 30, 0, 1.0), line(-30, 10, 30, 10, 3)]));
    const labels = res.seq.map((s) => s.styleLabel).sort();
    expect(labels).toEqual(["3重", "サテン", "ランニング"].sort());
  });

  it("サテンは線の太さぶん振れる", () => {
    const res = compileSketch(docWith([line(-30, 0, 30, 0, 4)]));
    const pts = flattenPlan(res.plan);
    const ys = pts.map((p) => p.y);
    // 4mm 幅 → ±2mm (=±20 単位) 程度振れる
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(18);
    expect(Math.min(...ys)).toBeLessThanOrEqual(-18);
  });

  it("穴のある面は穴を縫わない", () => {
    const ring: FillEl = {
      ...square(0, 0, 20),
      holes: [
        [
          { x: -8, y: -8 },
          { x: -8, y: 8 },
          { x: 8, y: 8 },
          { x: 8, y: -8 },
        ],
      ],
    };
    const res = compileSketch(docWith([ring]));
    const pts = flattenPlan(res.plan).filter((p) => p.move === 0);
    const inHole = pts.filter((p) => Math.abs(p.x) < 70 && Math.abs(p.y) < 70);
    expect(inHole.length).toBe(0);
  });

  it("PES/DST に書き出せて、PES はパレット色を保持する", () => {
    const res = compileSketch(docWith([square(0, 0, 10, YELLOW)], [circleStroke(0, 0, 11, 2, BLACK)]));
    const pes = writePes(res.plan);
    expect(pes.data.length).toBeGreaterThan(100);
    expect(pes.threads.map((t) => t.pecIndex)).toEqual([13, 20]);
    expect(writeDst(res.plan).length).toBeGreaterThan(512);
  });
});

describe("bucketFill", () => {
  it("円で囲まれた内側を塗ると、円の形の面ができる", () => {
    const r = bucketFill([circleStroke(0, 0, 15, 1)], { x: 0, y: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 半径15 + 線の下に潜り込む分 → 面積 ≈ π×15.5²
    expect(r.areaMm2).toBeGreaterThan(Math.PI * 14.5 ** 2);
    expect(r.areaMm2).toBeLessThan(Math.PI * 16.5 ** 2);
    expect(r.holes.length).toBe(0);
  });

  it("二重丸の間を塗るとドーナツ (穴あき) の面になる", () => {
    const r = bucketFill([circleStroke(0, 0, 20, 1), circleStroke(0, 0, 8, 1)], { x: 14, y: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.holes.length).toBe(1);
  });

  it("閉じていない範囲は塗らない (外に漏れる)", () => {
    const r = bucketFill([line(-10, 0, 10, 0, 1)], { x: 0, y: 5 });
    expect(r).toEqual({ ok: false, reason: "open" });
  });

  it("小さな隙間 (0.6mm) は自動で閉じる", () => {
    const c = circleStroke(0, 0, 15, 1);
    // 円を少し切って隙間を作る
    const gapped: StrokeEl = { ...c, closed: false, points: c.points.slice(1) };
    const r = bucketFill([gapped], { x: 0, y: 0 }, { gapCloseMm: 1.5 });
    expect(r.ok).toBe(true);
  });

  it("線の上をタップしたら塗らない", () => {
    const r = bucketFill([circleStroke(0, 0, 15, 2)], { x: 15, y: 0 });
    expect(r).toEqual({ ok: false, reason: "on-line" });
  });

  it("バケツ塗りの面 + 輪郭線 を縫うと、面の中で糸切りがない", () => {
    const outline = circleStroke(0, 0, 15, 2, BLACK);
    const r = bucketFill([outline], { x: 0, y: 0 });
    if (!r.ok) throw new Error("fill failed");
    const fill: FillEl = { kind: "fill", id: uid(), outer: r.outer, holes: r.holes, angleDeg: null, color: YELLOW };
    const res = compileSketch(docWith([fill], [outline]));
    const v = validatePlan(res.plan);
    expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
    // 糸切りは色替えに伴うもの (countTrims は数えない) だけ
    expect(res.stats.trims).toBe(0);
    expect(res.stats.colorChanges).toBe(1);
  });
});
