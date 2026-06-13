// 文字刺繍のレイアウト計算と品質警告のテスト (DOM 非依存部分)。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import { layoutText } from "../src/text/layout";
import type { GlyphMetric } from "../src/text/layout";
import { checkTextQuality } from "../src/text/metrics";

function metrics(text: string, advance: number): GlyphMetric[] {
  return [...text].map((ch) => ({ char: ch, advance: ch === "\n" ? 0 : advance }));
}

describe("layoutText 横書き", () => {
  it("グリフが左から右に等間隔で並び、中心化される", () => {
    const placements = layoutText(metrics("ABC", mm(10)), {
      mode: "horizontal",
      fontSize: mm(10),
    });
    expect(placements.length).toBe(3);
    // x が単調増加
    expect(placements[0].x).toBeLessThan(placements[1].x);
    expect(placements[1].x).toBeLessThan(placements[2].x);
    // 中心化: x の平均がほぼ0
    const avg = placements.reduce((s, p) => s + p.x, 0) / 3;
    expect(Math.abs(avg)).toBeLessThan(1);
    // 隣接間隔 = advance
    expect(placements[1].x - placements[0].x).toBeCloseTo(mm(10), 0);
    expect(placements.every((p) => p.rotation === 0)).toBe(true);
  });

  it("字間スペースが間隔に加算される", () => {
    const noSpace = layoutText(metrics("AB", mm(10)), { mode: "horizontal", fontSize: mm(10) });
    const withSpace = layoutText(metrics("AB", mm(10)), {
      mode: "horizontal",
      fontSize: mm(10),
      letterSpacing: mm(5),
    });
    const gap0 = noSpace[1].x - noSpace[0].x;
    const gap1 = withSpace[1].x - withSpace[0].x;
    expect(gap1 - gap0).toBeCloseTo(mm(5), 0);
  });

  it("改行で次の行が下に送られる", () => {
    const placements = layoutText(metrics("A\nB", mm(10)), {
      mode: "horizontal",
      fontSize: mm(10),
      lineHeight: mm(14),
    });
    expect(placements.length).toBe(2);
    expect(placements[1].y - placements[0].y).toBeCloseTo(mm(14), 0);
  });
});

describe("layoutText 縦書き", () => {
  it("グリフが上から下に並ぶ", () => {
    const placements = layoutText(metrics("あいう", mm(12)), {
      mode: "vertical",
      fontSize: mm(12),
    });
    expect(placements.length).toBe(3);
    expect(placements[0].y).toBeLessThan(placements[1].y);
    expect(placements[1].y).toBeLessThan(placements[2].y);
    // x はほぼ同じ (1列)
    expect(Math.abs(placements[0].x - placements[2].x)).toBeLessThan(1);
  });
});

describe("layoutText 円弧配置", () => {
  it("グリフが円弧上に配置され、接線方向に回転する", () => {
    const placements = layoutText(metrics("ABCDE", mm(10)), {
      mode: "arc",
      fontSize: mm(10),
      arcRadius: mm(40),
    });
    expect(placements.length).toBe(5);
    // 各グリフが半径 ~40mm の円周付近にある (中心化前は半径一定だが
    // recenter で原点がずれるため、相対的な弧の形を確認)
    // 端のグリフより中央のグリフのほうが上 (上弧) にある
    const midY = placements[2].y;
    const endY = placements[0].y;
    expect(midY).toBeLessThan(endY);
    // 回転が0でない (接線方向)
    expect(Math.abs(placements[0].rotation)).toBeGreaterThan(0.01);
    // 中央のグリフはほぼ回転なし
    expect(Math.abs(placements[2].rotation)).toBeLessThan(0.2);
  });
});

describe("checkTextQuality", () => {
  it("十分大きい文字は警告なし", () => {
    expect(checkTextQuality({ fontSize: mm(15) })).toHaveLength(0);
  });

  it("小さい文字は critical 警告", () => {
    const w = checkTextQuality({ fontSize: mm(3) });
    expect(w.some((x) => x.level === "critical")).toBe(true);
  });

  it("細い線幅は notice 警告 (6mm 高 → ステム約0.7mm)", () => {
    const w = checkTextQuality({ fontSize: mm(6) });
    expect(w.some((x) => x.level === "notice" && x.message.includes("線幅"))).toBe(true);
  });

  it("パフィー文字はより大きいサイズを要求する", () => {
    // 9mm は通常文字なら警告なし (ステム1.08mm) だがパフィーでは notice
    expect(checkTextQuality({ fontSize: mm(9) })).toHaveLength(0);
    expect(checkTextQuality({ fontSize: mm(9), puffy: true }).length).toBeGreaterThan(0);
  });
});
