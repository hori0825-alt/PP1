// スケルトン (中心線) ベースの線縫いのテスト

import { describe, expect, it } from "vitest";
import {
  distanceTransform,
  resamplePath,
  routeSkeleton,
  skeletonGraph,
  stitchRoute,
  thinMask,
} from "../src/digitize/skeleton";
import { digitize } from "../src/digitize/pipeline";

/** 矩形ストロークのマスクを作る */
function stripMask(w: number, h: number, rects: number[][]): Uint8Array {
  const m = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * w + x] = 1;
  }
  return m;
}

describe("thinMask / skeletonGraph", () => {
  it("横長ストロークの中心線は1本のエッジ (端点2つ)", () => {
    const w = 40;
    const h = 12;
    const mask = stripMask(w, h, [[3, 4, 36, 8]]); // 幅5pxの横棒
    const skel = thinMask(mask, w, h);
    const { edges, nodes } = skeletonGraph(skel, w, h);
    expect(edges.length).toBe(1);
    expect(edges[0].a).not.toBe(edges[0].b);
    // 中心線はおおむね y=6 付近
    for (const [, y] of edges[0].path) {
      expect(Math.abs(y - 6)).toBeLessThanOrEqual(2);
    }
    void nodes;
  });

  it("T字ストロークは3本のエッジに分かれる", () => {
    const w = 40;
    const h = 40;
    const mask = stripMask(w, h, [
      [4, 18, 36, 22], // 横棒
      [18, 4, 22, 22], // 縦棒 (上から中央へ)
    ]);
    const skel = thinMask(mask, w, h);
    const { edges } = skeletonGraph(skel, w, h);
    expect(edges.length).toBeGreaterThanOrEqual(3);
  });

  it("リング (輪) のスケルトンも閉路として抽出できる", () => {
    const w = 40;
    const h = 40;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const r = Math.hypot(x - 20, y - 20);
        if (r >= 10 && r <= 15) mask[y * w + x] = 1;
      }
    }
    const skel = thinMask(mask, w, h);
    const { edges } = skeletonGraph(skel, w, h);
    expect(edges.length).toBeGreaterThanOrEqual(1);
    const totalLen = edges.reduce((s, e) => s + e.path.length, 0);
    expect(totalLen).toBeGreaterThan(40); // 半径約12.5の円周相当
  });
});

describe("routeSkeleton (一筆書きルート)", () => {
  it("全エッジを行き帰り2回ずつ通り、移動が連続している", () => {
    const w = 40;
    const h = 40;
    const mask = stripMask(w, h, [
      [4, 18, 36, 22],
      [18, 4, 22, 22],
    ]);
    const skel = thinMask(mask, w, h);
    const { edges, nodes } = skeletonGraph(skel, w, h);
    const moves = routeSkeleton(edges, nodes);
    expect(moves.length).toBe(edges.length * 2);
    // 連続性: 各 move の終点 = 次の move の始点
    for (let i = 0; i + 1 < moves.length; i++) {
      const end = moves[i].path[moves[i].path.length - 1];
      const next = moves[i + 1].path[0];
      expect(end).toEqual(next);
    }
    // 行き (underpath) と帰り (本縫い) が同数
    const under = moves.filter((m) => m.underpath).length;
    expect(under).toBe(moves.length / 2);
  });
});

describe("stitchRoute (サテン生成)", () => {
  it("サテンは中心線をまたいで左右交互に振れ、振れ幅が線幅に対応する", () => {
    const w = 40;
    const h = 12;
    const mask = stripMask(w, h, [[3, 4, 36, 8]]); // 幅5px → 半幅2.5px
    const skel = thinMask(mask, w, h);
    const dt = distanceTransform(mask, w, h);
    const { edges, nodes } = skeletonGraph(skel, w, h);
    const moves = routeSkeleton(edges, nodes);
    const run = stitchRoute(moves, {
      mode: "satin",
      satinStepPx: 1.5,
      runStepPx: 4,
      dt,
      w,
      maxHalfWidthPx: 10,
    });
    expect(run.length).toBeGreaterThan(20);
    // 本縫い部分の y は中心線 (y≈6) の上下に振れる
    let above = 0;
    let below = 0;
    for (const [, y] of run) {
      if (y < 5) above++;
      if (y > 7) below++;
    }
    expect(above).toBeGreaterThan(5);
    expect(below).toBeGreaterThan(5);
  });
});

describe("resamplePath", () => {
  it("一定ピッチで再サンプリングされ両端を含む", () => {
    const path: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    const out = resamplePath(path, 2);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([10, 10]);
    for (let i = 1; i < out.length; i++) {
      const d = Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]);
      expect(d).toBeLessThanOrEqual(2.5);
    }
  });
});

describe("pipeline: スケルトンによる線縫い", () => {
  /** L字の細い線 (幅3px) */
  function lineImage(extraBlob = false) {
    const w = 150;
    const h = 150;
    const data = new Uint8ClampedArray(w * h * 4);
    const paint = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      data[i] = 40;
      data[i + 1] = 40;
      data[i + 2] = 40;
      data[i + 3] = 255;
    };
    for (let x = 20; x <= 120; x++) for (let y = 20; y <= 22; y++) paint(x, y); // 横線
    for (let y = 20; y <= 120; y++) for (let x = 20; x <= 22; x++) paint(x, y); // 縦線
    if (extraBlob) {
      for (let y = 100; y <= 130; y++) for (let x = 100; x <= 130; x++) paint(x, y);
    }
    return { data, width: w, height: h };
  }

  const OPTS = {
    sizeMm: 60,
    maxColors: 2,
    autoBackground: false,
    autoThinDetect: true,
    centerlineMaxWidthMm: 1.8,
    satinMaxWidthMm: 6,
    outline: false,
    outlineSmoothing: 0,
    minRegionMm2: 0.5,
  };

  it("連結したL字の線は糸切りゼロ・ジャンプ1回で縫い切る", () => {
    const { pattern, stats } = digitize(lineImage(), OPTS);
    expect(stats.trims).toBe(0);
    expect(stats.jumps).toBe(1);
    expect(stats.stitches).toBeGreaterThan(50);
    // 線に沿って縫われている (バウンディングボックスが線全体をカバー)
    const b = pattern.bounds();
    expect(b.maxX - b.minX).toBeGreaterThan(380);
    expect(b.maxY - b.minY).toBeGreaterThan(380);
  });

  it("線と離れた塊が同色でも糸切りは1回だけ", () => {
    const { stats } = digitize(lineImage(true), OPTS);
    expect(stats.trims).toBe(1); // L字 ↔ 塊の間のみ
  });

  it("太い領域はスケルトンでなくタタミで縫われる", () => {
    const w = 100;
    const h = 100;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 20; y < 80; y++) {
      for (let x = 20; x < 80; x++) {
        const i = (y * w + x) * 4;
        data[i] = 40;
        data[i + 1] = 40;
        data[i + 2] = 200;
        data[i + 3] = 255;
      }
    }
    const { stats } = digitize({ data, width: w, height: h }, { ...OPTS, sizeMm: 50 });
    // 30mm 角のタタミ → 行間隔 0.4mm で十分なステッチ数
    expect(stats.stitches).toBeGreaterThan(1500);
    expect(stats.trims).toBe(0);
  });
});
