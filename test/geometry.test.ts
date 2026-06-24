// 幾何ユーティリティのテスト: DP 簡略化・スムージング・自己交差検出。

import { describe, expect, it } from "vitest";
import {
  chaikinClosed,
  chaikinClosedPreserveCorners,
  pointInPolygon,
  pointSegmentDistance,
  selfIntersects,
  signedArea,
  simplifyClosed,
} from "../src/core/geometry";
import type { Point } from "../src/core/types";

/** ノイズ付きの円 (閉路) */
function noisyCircle(n: number, radius: number, noise: number): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    // 決定的な擬似ノイズ
    const r = radius + noise * Math.sin(i * 7.13) * Math.cos(i * 3.7);
    pts.push({ x: r * Math.cos(t), y: r * Math.sin(t) });
  }
  return pts;
}

describe("simplifyClosed (Douglas-Peucker)", () => {
  it("点数が減り、元の点との最大誤差が許容内に収まる", () => {
    const original = noisyCircle(400, 200, 1.0);
    const tolerance = 3;
    const simplified = simplifyClosed(original, tolerance);
    expect(simplified.length).toBeLessThan(original.length / 3);
    expect(simplified.length).toBeGreaterThanOrEqual(8);

    // 全ての元の点が、簡略化後の最寄り辺から tolerance + ノイズ幅以内にある
    let maxDist = 0;
    for (const p of original) {
      let best = Infinity;
      for (let i = 0; i < simplified.length; i++) {
        const a = simplified[i];
        const b = simplified[(i + 1) % simplified.length];
        best = Math.min(best, pointSegmentDistance(p, a, b));
      }
      maxDist = Math.max(maxDist, best);
    }
    expect(maxDist).toBeLessThanOrEqual(tolerance + 0.001);
  });

  it("矩形は4頂点に簡略化される", () => {
    // 辺上に余計な中間点を持つ矩形
    const pts: Point[] = [];
    for (let x = 0; x <= 100; x += 10) pts.push({ x, y: 0 });
    for (let y = 10; y <= 100; y += 10) pts.push({ x: 100, y });
    for (let x = 90; x >= 0; x -= 10) pts.push({ x, y: 100 });
    for (let y = 90; y >= 10; y -= 10) pts.push({ x: 0, y });
    const simplified = simplifyClosed(pts, 0.5);
    expect(simplified.length).toBeLessThanOrEqual(6);
  });
});

describe("chaikinClosed", () => {
  it("角が丸まり頂点数が増える (ガタガタ輪郭の平滑化)", () => {
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const smooth = chaikinClosed(square, 2);
    expect(smooth.length).toBe(16);
    // 角 (0,0) そのものは残らない
    expect(smooth.some((p) => p.x === 0 && p.y === 0)).toBe(false);
    // 面積はほぼ保たれる (角が落ちる分やや減る)
    const a = Math.abs(signedArea(smooth));
    expect(a).toBeGreaterThan(100 * 100 * 0.8);
    expect(a).toBeLessThan(100 * 100);
  });
});

describe("chaikinClosedPreserveCorners", () => {
  it("矩形の鋭い角は固定され、丸まらない (ロゴ・文字のシャープさを保つ)", () => {
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const out = chaikinClosedPreserveCorners(square, 2);
    // 90°の角は全て固定 → 4頂点の矩形のまま (通常 Chaikin は16点に丸める)
    expect(out.length).toBe(4);
    for (const c of square) {
      expect(out.some((p) => Math.abs(p.x - c.x) < 1e-6 && Math.abs(p.y - c.y) < 1e-6)).toBe(true);
    }
  });

  it("ゆるい屈曲だけの輪郭 (多角形近似の円) は平滑化される", () => {
    const n = 24;
    const circle: Point[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * 2 * Math.PI;
      circle.push({ x: 100 * Math.cos(t), y: 100 * Math.sin(t) });
    }
    // 1頂点あたりの屈曲角は 360/24 = 15° で閾値未満 → 全て丸められ点数が増える
    const out = chaikinClosedPreserveCorners(circle, 1);
    expect(out.length).toBe(n * 2);
  });

  it("角と曲線が混在する形状: 角は残し曲線は丸める", () => {
    // 下辺が直線で上が尖った「家」形 (頂点は鋭角、底の2角は直角)
    const house: Point[] = [
      { x: 0, y: 0 },
      { x: 50, y: -80 }, // 屋根の頂点 (鋭角)
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const out = chaikinClosedPreserveCorners(house, 2);
    // 屋根の頂点は鋭角なので固定されて残る
    expect(out.some((p) => Math.abs(p.x - 50) < 1e-6 && Math.abs(p.y + 80) < 1e-6)).toBe(true);
  });
});

describe("selfIntersects", () => {
  it("単純なポリゴンは交差なし", () => {
    expect(
      selfIntersects([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ]),
    ).toBe(false);
  });

  it("8の字は交差あり", () => {
    expect(
      selfIntersects([
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        { x: 100, y: 0 },
        { x: 0, y: 100 },
      ]),
    ).toBe(true);
  });
});

describe("pointInPolygon", () => {
  it("内外判定が正しい", () => {
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 50 }, square)).toBe(false);
  });
});
