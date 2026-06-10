import { describe, expect, it } from "vitest";
import { fillLoops } from "../src/digitize/fill";
import { traceContours, simplifyLoop, loopArea, type Pt } from "../src/digitize/contour";
import { quantize } from "../src/digitize/quantize";
import { digitize } from "../src/digitize/pipeline";
import { COLOR_CHANGE, STITCH } from "../src/embroidery/pattern";

describe("fillLoops", () => {
  it("長方形を行間隔どおりに埋める", () => {
    const rect: Pt[][] = [
      [
        [0, 0],
        [200, 0],
        [200, 100],
        [0, 100],
      ],
    ];
    const runs = fillLoops(rect, { spacing: 4, stitchLen: 30, angle: 0 });
    expect(runs.length).toBe(1); // 単純な長方形は1チェーン
    const run = runs[0];
    expect(run.length).toBeGreaterThan(100);
    for (const [x, y] of run) {
      expect(x).toBeGreaterThanOrEqual(-0.5);
      expect(x).toBeLessThanOrEqual(200.5);
      expect(y).toBeGreaterThanOrEqual(-0.5);
      expect(y).toBeLessThanOrEqual(100.5);
    }
    // 行数 ≒ 高さ / 間隔
    const rows = new Set(run.map(([, y]) => Math.round(y * 10)));
    expect(rows.size).toBeGreaterThanOrEqual(23);
    expect(rows.size).toBeLessThanOrEqual(26);
  });

  it("穴 (ドーナツ形) を避けて埋める", () => {
    const donut: Pt[][] = [
      [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ],
      [
        [30, 30],
        [70, 30],
        [70, 70],
        [30, 70],
      ],
    ];
    const runs = fillLoops(donut, { spacing: 4, stitchLen: 30, angle: 0 });
    for (const run of runs) {
      for (const [x, y] of run) {
        const inHole = x > 30.5 && x < 69.5 && y > 30.5 && y < 69.5;
        expect(inHole).toBe(false);
      }
    }
  });
});

describe("traceContours", () => {
  it("矩形領域の輪郭を抽出する", () => {
    const w = 10;
    const h = 8;
    const labels = new Int32Array(w * h).fill(-1);
    for (let y = 2; y < 6; y++) for (let x = 3; x < 8; x++) labels[y * w + x] = 0;
    const loops = traceContours(labels, w, h, 0);
    expect(loops.length).toBe(1);
    expect(Math.abs(loopArea(loops[0]))).toBe(20); // 5x4 px
    const simplified = simplifyLoop(loops[0], 0.75);
    expect(simplified.length).toBe(4);
  });

  it("穴のある領域は2ループになる", () => {
    const w = 12;
    const h = 12;
    const labels = new Int32Array(w * h).fill(-1);
    for (let y = 1; y < 11; y++) for (let x = 1; x < 11; x++) labels[y * w + x] = 0;
    for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) labels[y * w + x] = 1;
    const loops = traceContours(labels, w, h, 0);
    expect(loops.length).toBe(2);
  });
});

describe("quantize", () => {
  function makeImage(w: number, h: number, painter: (x: number, y: number) => [number, number, number, number]) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b, a] = painter(x, y);
        const i = (y * w + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = a;
      }
    }
    return { data, width: w, height: h };
  }

  it("2色画像を2色に減色し透明部を背景にする", () => {
    const img = makeImage(40, 40, (x, y) => {
      if (x < 5 || x > 34) return [0, 0, 0, 0]; // 透明
      return x < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255];
    });
    const q = quantize(img, {
      maxColors: 4,
      alphaThreshold: 128,
      autoBackground: false,
      bgTolerance: 40,
      minRegionPx: 4,
    });
    expect(q.palette.length).toBe(2);
    expect(q.labels[0]).toBe(-1); // 透明部
    expect(q.labels[20 * 40 + 10]).not.toBe(-1);
  });

  it("白背景を自動除去する", () => {
    const img = makeImage(40, 40, (x, y) => {
      const inside = x > 10 && x < 30 && y > 10 && y < 30;
      return inside ? [200, 30, 30, 255] : [255, 255, 255, 255];
    });
    const q = quantize(img, {
      maxColors: 4,
      alphaThreshold: 128,
      autoBackground: true,
      bgTolerance: 40,
      minRegionPx: 4,
    });
    expect(q.labels[0]).toBe(-1); // 角は背景
    expect(q.palette.length).toBe(1); // 赤のみ
  });
});

describe("digitize (パイプライン全体)", () => {
  it("2色画像から有効な刺しゅうパターンを生成する", () => {
    const w = 100;
    const h = 100;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const dx = x - 50;
        const dy = y - 50;
        const inCircle = dx * dx + dy * dy < 40 * 40;
        const inCore = dx * dx + dy * dy < 18 * 18;
        if (!inCircle) {
          data[i + 3] = 0;
        } else {
          data[i] = inCore ? 250 : 30;
          data[i + 1] = inCore ? 210 : 90;
          data[i + 2] = inCore ? 60 : 180;
          data[i + 3] = 255;
        }
      }
    }
    const result = digitize(
      { data, width: w, height: h },
      { sizeMm: 60, maxColors: 4, autoBackground: false },
    );
    const { pattern, stats } = result;

    expect(stats.colors).toBe(2);
    expect(stats.stitches).toBeGreaterThan(500);
    expect(pattern.stitches.filter((s) => s.cmd === COLOR_CHANGE).length).toBe(1);

    // サイズが指定どおり (60mm 長辺、誤差1mm)
    expect(Math.max(stats.widthMm, stats.heightMm)).toBeGreaterThan(58);
    expect(Math.max(stats.widthMm, stats.heightMm)).toBeLessThanOrEqual(61);

    // 全ステッチが枠内 & 中心原点
    const b = pattern.bounds();
    expect(Math.abs(b.minX + b.maxX)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.minY + b.maxY)).toBeLessThanOrEqual(1);

    // 連続ステッチの長さが最大ステッチ長以下 (丸め誤差 +1)
    let prev: { x: number; y: number } | null = null;
    for (const s of pattern.stitches) {
      if (s.cmd === STITCH) {
        if (prev) {
          const d = Math.hypot(s.x - prev.x, s.y - prev.y);
          expect(d).toBeLessThanOrEqual(32); // 最大30 + 整数丸め誤差
        }
        prev = { x: s.x, y: s.y };
      } else {
        prev = null;
      }
    }
  });
});
