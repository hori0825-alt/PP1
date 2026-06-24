// SVG インポーターのテスト: 図形・パス・色・穴 (evenodd)・スケーリング。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import { pathBounds, signedArea } from "../src/core/geometry";
import { countStitches } from "../src/core/plan";
import { importSvg, parseColor, parsePathData } from "../src/import/svg";
import { digitizeRegions } from "../src/stitch/digitize";

describe("parseColor", () => {
  it("各形式をパースし、none は null", () => {
    expect(parseColor("#f00")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColor("#1a2b3c")).toEqual({ r: 26, g: 43, b: 60 });
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30 });
    expect(parseColor("red")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColor("none")).toBeNull();
  });
});

describe("parsePathData", () => {
  it("直線コマンド (M/L/H/V/Z) を処理する", () => {
    const subs = parsePathData("M 0 0 L 10 0 V 10 H 0 Z");
    expect(subs.length).toBe(1);
    expect(subs[0].closed).toBe(true);
    expect(subs[0].points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
  });

  it("相対コマンドと暗黙の lineto を処理する", () => {
    const subs = parsePathData("m 5 5 10 0 l 0 10 z");
    expect(subs[0].points).toEqual([
      { x: 5, y: 5 },
      { x: 15, y: 5 },
      { x: 15, y: 15 },
    ]);
    expect(subs[0].closed).toBe(true);
  });

  it("ベジェ曲線が平坦化される", () => {
    const subs = parsePathData("M 0 0 C 0 -50 100 -50 100 0 Z");
    expect(subs[0].points.length).toBeGreaterThan(10);
    // 曲線の中間が上に膨らむ
    const midY = Math.min(...subs[0].points.map((p) => p.y));
    expect(midY).toBeLessThan(-30);
  });

  it("複数サブパスを分離する", () => {
    const subs = parsePathData("M0 0 L10 0 L10 10 Z M20 20 L30 20 L30 30 Z");
    expect(subs.length).toBe(2);
  });
});

describe("importSvg", () => {
  it("rect と circle が色付き Region になる", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect x="0" y="0" width="40" height="40" fill="#ff0000"/>
      <circle cx="70" cy="70" r="20" fill="rgb(0,0,255)"/>
    </svg>`;
    const { regions } = importSvg(svg);
    expect(regions.length).toBe(2);
    expect(regions[0].color).toEqual({ r: 255, g: 0, b: 0 });
    expect(regions[1].color).toEqual({ r: 0, g: 0, b: 255 });
  });

  it("evenodd の入れ子サブパスが穴になる", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <path fill="black" d="M0 0 H100 V100 H0 Z M30 30 H70 V70 H30 Z"/>
    </svg>`;
    const { regions } = importSvg(svg);
    expect(regions.length).toBe(1);
    expect(regions[0].holes.length).toBe(1);
    expect(signedArea(regions[0].outer)).toBeGreaterThan(0);
    expect(signedArea(regions[0].holes[0])).toBeLessThan(0);
  });

  it("fill=none + stroke の形状は線がリボン領域として縫える", () => {
    const svg = `<svg><rect x="0" y="0" width="10" height="10" fill="none" stroke="black"/>
      <rect x="20" y="0" width="10" height="10" fill="black"/></svg>`;
    const { regions } = importSvg(svg);
    // 塗りの矩形 + ストローク(閉路)のリボン環 = 2領域
    expect(regions.length).toBe(2);
  });

  it("fill=none かつ stroke なしの形状は領域にならない", () => {
    const svg = `<svg><rect x="0" y="0" width="10" height="10" fill="none"/>
      <rect x="20" y="0" width="10" height="10" fill="black"/></svg>`;
    const { regions } = importSvg(svg);
    expect(regions.length).toBe(1);
  });

  it("開いた線 (stroke のみのパス) がリボン領域になる", () => {
    const svg = `<svg><path d="M0 0 L100 0 L100 80" fill="none" stroke="red" stroke-width="4"/></svg>`;
    const { regions } = importSvg(svg);
    expect(regions.length).toBe(1);
    expect(regions[0].color).toEqual({ r: 255, g: 0, b: 0 });
    expect(regions[0].holes).toHaveLength(0); // 開いた線は穴なしの1枚帯
    expect(regions[0].outer.length).toBeGreaterThanOrEqual(4);
  });

  it("stroke 由来のリボン領域が実際にステッチ化される (線が縫える)", () => {
    const svg = `<svg><path d="M0 0 L100 0" fill="none" stroke="black" stroke-width="6"/></svg>`;
    const { regions } = importSvg(svg);
    const { plan } = digitizeRegions(regions, "LINE");
    expect(countStitches(plan)).toBeGreaterThan(0);
  });

  it("100mm 枠に収まるよう中心配置でスケールされる", () => {
    const svg = `<svg><rect x="1000" y="1000" width="500" height="250" fill="black"/></svg>`;
    const { regions } = importSvg(svg);
    const b = pathBounds(regions[0].outer);
    // 長辺が 100mm にフィット
    expect(b.maxX - b.minX).toBeCloseTo(mm(100), 0);
    expect(b.maxY - b.minY).toBeCloseTo(mm(50), 0);
    // 中心配置
    expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 0);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(0, 0);
  });

  it("transform (translate/scale) と g の継承が適用される", () => {
    const svg = `<svg>
      <g transform="translate(100, 0)" fill="#00ff00">
        <rect x="0" y="0" width="10" height="10"/>
        <rect x="0" y="0" width="10" height="10" transform="scale(2)"/>
      </g>
    </svg>`;
    const { regions } = importSvg(svg);
    expect(regions.length).toBe(2);
    expect(regions[0].color).toEqual({ r: 0, g: 255, b: 0 });
    // scale(2) の矩形は面積が4倍
    const a0 = Math.abs(signedArea(regions[0].outer));
    const a1 = Math.abs(signedArea(regions[1].outer));
    const [small, large] = a0 < a1 ? [a0, a1] : [a1, a0];
    expect(large / small).toBeCloseTo(4, 1);
  });

  it("style 属性の fill も拾う", () => {
    const svg = `<svg><rect x="0" y="0" width="10" height="10" style="fill:#123456"/></svg>`;
    const { regions } = importSvg(svg);
    expect(regions[0].color).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
  });
});
