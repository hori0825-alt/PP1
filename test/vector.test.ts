// ベクター/ノード編集のテスト (Phase 7)。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import { signedArea } from "../src/core/geometry";
import type { Region } from "../src/core/region";
import type { Point } from "../src/core/types";
import { extractCenterline } from "../src/vector/centerline";
import {
  addNode,
  deleteNode,
  joinPaths,
  moveNode,
  pathToPolyline,
  setNodeType,
  splitPath,
} from "../src/vector/path";
import type { EditPath } from "../src/vector/path";
import { editShapeToRegion, regionToEditShape } from "../src/vector/shape";
import { pointsToPath } from "../src/vector/simplify";
import { snapToArtwork } from "../src/vector/snap";

function rect(cx: number, cy: number, w: number, h: number): Point[] {
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

function circle(cx: number, cy: number, r: number, n = 64): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    pts.push({ x: Math.round(cx + r * Math.cos(t)), y: Math.round(cy + r * Math.sin(t)) });
  }
  return pts;
}

describe("path ノード操作", () => {
  const base: EditPath = {
    closed: true,
    nodes: [
      { x: 0, y: 0, type: "corner" },
      { x: 100, y: 0, type: "corner" },
      { x: 100, y: 100, type: "corner" },
      { x: 0, y: 100, type: "corner" },
    ],
  };

  it("addNode / deleteNode / moveNode は非破壊で動く", () => {
    const added = addNode(base, 0, { x: 50, y: 0 });
    expect(added.nodes.length).toBe(5);
    expect(added.nodes[1]).toEqual({ x: 50, y: 0, type: "corner" });
    expect(base.nodes.length).toBe(4); // 元は不変

    const deleted = deleteNode(added, 1);
    expect(deleted.nodes.length).toBe(4);

    const moved = moveNode(base, 2, { x: 120, y: 90 });
    expect(moved.nodes[2]).toMatchObject({ x: 120, y: 90 });
    expect(base.nodes[2].x).toBe(100);
  });

  it("ノードは2点までしか削除できない", () => {
    let p: EditPath = { closed: false, nodes: [{ x: 0, y: 0, type: "corner" }, { x: 1, y: 1, type: "corner" }] };
    p = deleteNode(p, 0);
    expect(p.nodes.length).toBe(2);
  });

  it("setNodeType で corner↔smooth を切り替えられる", () => {
    const smooth = setNodeType(base, 1, "smooth");
    expect(smooth.nodes[1].type).toBe("smooth");
  });

  it("splitPath: 閉パスを開パスに展開、開パスを2本に分割", () => {
    const opened = splitPath(base, 1);
    expect(opened.length).toBe(1);
    expect(opened[0].closed).toBe(false);
    expect(opened[0].nodes.length).toBe(5); // 一周 + 始点複製

    const open: EditPath = { closed: false, nodes: opened[0].nodes };
    const two = splitPath(open, 2);
    expect(two.length).toBe(2);
    expect(two[0].nodes[two[0].nodes.length - 1]).toEqual(two[1].nodes[0]); // 分割点を共有
  });

  it("joinPaths: 近い端点同士で結合する", () => {
    const a: EditPath = { closed: false, nodes: [{ x: 0, y: 0, type: "corner" }, { x: 10, y: 0, type: "corner" }] };
    const b: EditPath = { closed: false, nodes: [{ x: 30, y: 0, type: "corner" }, { x: 11, y: 0, type: "corner" }] };
    // a の末尾(10,0) に近いのは b の (11,0) = b の末尾 → b を反転して連結
    const joined = joinPaths(a, b);
    expect(joined.nodes[joined.nodes.length - 1]).toMatchObject({ x: 30, y: 0 });
    expect(joined.nodes.length).toBe(4);
  });
});

describe("pathToPolyline", () => {
  it("全 corner の閉パスは入力ノードがそのまま頂点になる", () => {
    const path: EditPath = { closed: true, nodes: rect(0, 0, 100, 100).map((p) => ({ ...p, type: "corner" as const })) };
    const poly = pathToPolyline(path, 8);
    // corner のみなら頂点数 = ノード数 + 1 (始点で閉じる)
    expect(poly.length).toBe(5);
  });

  it("smooth ノードは曲線に展開され頂点が増える", () => {
    const path: EditPath = { closed: true, nodes: rect(0, 0, 100, 100).map((p) => ({ ...p, type: "smooth" as const })) };
    const poly = pathToPolyline(path, 8);
    expect(poly.length).toBeGreaterThan(20);
  });

  it("smooth 化で面積がほぼ保たれる (角が丸まる程度)", () => {
    const corners: EditPath = { closed: true, nodes: circle(0, 0, 100, 8).map((p) => ({ ...p, type: "corner" as const })) };
    const smooth: EditPath = { closed: true, nodes: circle(0, 0, 100, 8).map((p) => ({ ...p, type: "smooth" as const })) };
    const aCorner = Math.abs(signedArea(pathToPolyline(corners)));
    const aSmooth = Math.abs(signedArea(pathToPolyline(smooth)));
    // smooth は円に近づくので面積が増える (多角形 < 円)
    expect(aSmooth).toBeGreaterThan(aCorner);
  });
});

describe("pointsToPath (稠密点列 → ノード化)", () => {
  it("矩形は4ノード前後に簡略化され、角が corner になる", () => {
    const path = pointsToPath(rect(0, 0, 100, 100), true);
    expect(path.nodes.length).toBeLessThanOrEqual(6);
    expect(path.nodes.every((n) => n.type === "corner")).toBe(true);
  });

  it("円はノードが smooth 判定される", () => {
    const path = pointsToPath(circle(0, 0, 200, 64), true, { tolerance: 3 });
    const smoothCount = path.nodes.filter((n) => n.type === "smooth").length;
    expect(smoothCount).toBeGreaterThan(path.nodes.length / 2);
  });
});

describe("shape: Region ↔ EditShape ラウンドトリップ", () => {
  it("矩形領域を編集形状に変換して戻すと面積が保たれる", () => {
    const region: Region = { outer: rect(0, 0, mm(20), mm(20)), holes: [], color: { r: 0, g: 0, b: 0 } };
    const shape = regionToEditShape(region);
    const back = editShapeToRegion(shape);
    expect(back.outer.length).toBeGreaterThanOrEqual(4);
    expect(signedArea(back.outer)).toBeGreaterThan(0); // 外周は正
    const a0 = Math.abs(signedArea(region.outer));
    const a1 = Math.abs(signedArea(back.outer));
    expect(Math.abs(a1 - a0) / a0).toBeLessThan(0.1);
  });

  it("穴あき領域: 外周は正、穴は負の符号で復元される", () => {
    const region: Region = {
      outer: circle(0, 0, mm(30)),
      holes: [circle(0, 0, mm(12)).reverse()],
      color: { r: 0, g: 0, b: 0 },
    };
    const back = editShapeToRegion(regionToEditShape(region));
    expect(signedArea(back.outer)).toBeGreaterThan(0);
    expect(back.holes.length).toBe(1);
    expect(signedArea(back.holes[0])).toBeLessThan(0);
  });

  it("ノード移動が Region に反映される", () => {
    const region: Region = { outer: rect(0, 0, mm(20), mm(20)), holes: [], color: { r: 0, g: 0, b: 0 } };
    const shape = regionToEditShape(region);
    shape.outer = moveNode(shape.outer, 0, { x: -mm(20), y: -mm(20) }); // 角を外へ
    const back = editShapeToRegion(shape);
    expect(Math.abs(signedArea(back.outer))).toBeGreaterThan(Math.abs(signedArea(region.outer)));
  });
});

describe("snapToArtwork", () => {
  const ref = [rect(0, 0, 100, 100)];
  it("閾値内なら最寄りエッジに吸着する", () => {
    const snapped = snapToArtwork({ x: 52, y: 30 }, ref, 10);
    expect(snapped.x).toBeCloseTo(50, 0); // 右辺 x=50 に吸着
    expect(snapped.y).toBeCloseTo(30, 0);
  });

  it("閾値外なら元の点を返す", () => {
    const p = { x: 80, y: 30 };
    expect(snapToArtwork(p, ref, 10)).toEqual(p);
  });
});

describe("extractCenterline (Quick Trace)", () => {
  it("細長い横長領域の中心線が水平に伸びる", () => {
    const region: Region = { outer: rect(0, 0, mm(40), mm(4)), holes: [], color: { r: 0, g: 0, b: 0 } };
    const line = extractCenterline(region);
    expect(line.length).toBeGreaterThan(3);
    // 中心線の y はほぼ 0 付近
    const maxAbsY = Math.max(...line.map((p) => Math.abs(p.y)));
    expect(maxAbsY).toBeLessThan(mm(2));
    // x は広い範囲に分布
    const xs = line.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(mm(30));
  });
});
