// 実機向け: 糸切り削減・縫い順最適化・つなぎ縫い・平滑化のテスト

import { describe, expect, it } from "vitest";
import { digitize, orderRunsNearest } from "../src/digitize/pipeline";
import { smoothLoop, type Pt } from "../src/digitize/contour";
import { COLOR_CHANGE, JUMP, STITCH, TRIM, Pattern } from "../src/embroidery/pattern";
import { PEC_THREADS } from "../src/embroidery/pecThreads";
import { writePes } from "../src/embroidery/pes";
import { writeDst, decodeDstRecord } from "../src/embroidery/dst";

/** 単色の塗り領域を複数持つテスト画像を作る */
function makeImage(
  w: number,
  h: number,
  rects: { x: number; y: number; w: number; h: number }[],
) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * w + x) * 4;
        data[i] = 200;
        data[i + 1] = 40;
        data[i + 2] = 40;
        data[i + 3] = 255;
      }
    }
  }
  return { data, width: w, height: h };
}

const BASE_OPTS = {
  sizeMm: 50,
  maxColors: 2,
  autoBackground: false,
  autoThinDetect: false,
  outline: false,
  fill: true,
  minRegionMm2: 0.5,
  outlineSmoothing: 0,
};

describe("糸切り削減 (reduceTrims)", () => {
  it("単一の塗り領域は糸切り0回・ジャンプは開始時の1回だけで縫い切る", () => {
    const img = makeImage(100, 100, [{ x: 10, y: 10, w: 80, h: 80 }]);
    const { pattern, stats } = digitize(img, { ...BASE_OPTS });
    expect(stats.trims).toBe(0);
    expect(stats.jumps).toBe(1); // 開始位置への移動のみ
    expect(stats.colorChanges).toBe(0);
    // 最初のジャンプ以降に JUMP/TRIM が現れない (= 面を一筆で縫い切る)
    const cmds = pattern.stitches.map((s) => s.cmd);
    const firstStitch = cmds.indexOf(STITCH);
    for (let i = firstStitch; i < cmds.length - 1; i++) {
      expect(cmds[i]).toBe(STITCH);
    }
  });

  it("接続距離内の同色領域は糸切りせずつなぎ縫いで接続する", () => {
    // しきい値は「runの終点から次のrunの始点までの実移動距離」で判定される
    const img = makeImage(100, 100, [
      { x: 10, y: 40, w: 30, h: 20 },
      { x: 46, y: 40, w: 30, h: 20 },
    ]);
    const { pattern, stats } = digitize(img, {
      ...BASE_OPTS,
      angleDeg: 0,
      maxConnectMm: 30,
    });
    expect(stats.trims).toBe(0);
    expect(stats.jumps).toBe(1);
    // つなぎ縫いのステッチ長が最大ステッチ長以下
    let prev: { x: number; y: number } | null = null;
    for (const s of pattern.stitches) {
      if (s.cmd === STITCH) {
        if (prev) {
          expect(Math.hypot(s.x - prev.x, s.y - prev.y)).toBeLessThanOrEqual(32);
        }
        prev = { x: s.x, y: s.y };
      } else {
        prev = null;
      }
    }
  });

  it("遠い同色領域 (約30mm) は糸切り+ジャンプになる", () => {
    const img = makeImage(100, 100, [
      { x: 0, y: 40, w: 20, h: 20 },
      { x: 80, y: 40, w: 20, h: 20 },
    ]);
    const { stats } = digitize(img, { ...BASE_OPTS, maxConnectMm: 7 });
    expect(stats.trims).toBe(1);
    expect(stats.jumps).toBe(2); // 開始 + 領域間
  });

  it("maxConnectMm を小さくすると同じ移動でも糸切りになる", () => {
    const img = makeImage(100, 100, [
      { x: 10, y: 40, w: 30, h: 20 },
      { x: 46, y: 40, w: 30, h: 20 },
    ]);
    const { stats } = digitize(img, { ...BASE_OPTS, angleDeg: 0, maxConnectMm: 2 });
    expect(stats.trims).toBe(1);
    expect(stats.jumps).toBe(2);
  });

  it("reduceTrims=false なら従来どおり領域ごとに糸切りする", () => {
    const img = makeImage(100, 100, [
      { x: 10, y: 40, w: 30, h: 20 },
      { x: 46, y: 40, w: 30, h: 20 },
    ]);
    const { stats } = digitize(img, { ...BASE_OPTS, reduceTrims: false });
    expect(stats.trims).toBeGreaterThanOrEqual(1);
  });

  it("色替えの前には糸切りが入り、色替え回数は色数-1", () => {
    const w = 100;
    const h = 100;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 10; y < 90; y++) {
      for (let x = 10; x < 90; x++) {
        const i = (y * w + x) * 4;
        data[i] = x < 50 ? 200 : 30;
        data[i + 1] = 40;
        data[i + 2] = x < 50 ? 40 : 200;
        data[i + 3] = 255;
      }
    }
    const { pattern, stats } = digitize({ data, width: w, height: h }, { ...BASE_OPTS });
    expect(stats.colorChanges).toBe(1);
    // COLOR_CHANGE の直前は TRIM
    const cmds = pattern.stitches.map((s) => s.cmd);
    const cc = cmds.indexOf(COLOR_CHANGE);
    expect(cmds[cc - 1]).toBe(TRIM);
    // 同一色内には糸切りがない
    expect(stats.trims).toBe(1); // 色替え前の1回のみ
  });
});

describe("縫い順の nearest-neighbor 最適化", () => {
  it("orderRunsNearest: 現在位置から近い順に並び、終点が近ければ反転する", () => {
    const runA: Pt[] = [[0, 0], [10, 0]];
    const runFar: Pt[] = [[100, 0], [110, 0]];
    const runB: Pt[] = [[30, 0], [20, 0]]; // 終点 20 が runA 終点 10 に近い
    const ordered = orderRunsNearest([runFar, runB, runA], [0, 0]);
    // 開始 [0,0] → runA → runB (反転して 20 から) → runFar
    expect(ordered[0][0]).toEqual([0, 0]);
    expect(ordered[1][0]).toEqual([20, 0]); // 反転済み
    expect(ordered[2][0]).toEqual([100, 0]);
  });

  it("横並び3領域は中央を経由して端から端へ縫われる (ジグザグしない)", () => {
    const img = makeImage(120, 40, [
      { x: 0, y: 10, w: 20, h: 20 },
      { x: 50, y: 10, w: 20, h: 20 },
      { x: 100, y: 10, w: 20, h: 20 },
    ]);
    const { pattern } = digitize(img, {
      ...BASE_OPTS,
      sizeMm: 60,
      angleDeg: 0,
      maxConnectMm: 40,
    });
    // 出力 60mm / 120px → 1px=5units。中心原点なので領域中心 x は約 -250, 0, +250
    const firstIdxIn = (lo: number, hi: number): number => {
      for (let i = 0; i < pattern.stitches.length; i++) {
        const s = pattern.stitches[i];
        if (s.cmd === STITCH && s.x >= lo && s.x <= hi) return i;
      }
      return -1;
    };
    const iLeft = firstIdxIn(-310, -190);
    const iMid = firstIdxIn(-60, 60);
    const iRight = firstIdxIn(190, 310);
    expect(iLeft).toBeGreaterThanOrEqual(0);
    expect(iMid).toBeGreaterThanOrEqual(0);
    expect(iRight).toBeGreaterThanOrEqual(0);
    // 中央領域は両端の領域の間に縫われる (= 往復しない)
    const between =
      (iLeft < iMid && iMid < iRight) || (iRight < iMid && iMid < iLeft);
    expect(between).toBe(true);
  });
});

describe("smoothLoop (アウトライン平滑化)", () => {
  it("直角の角は保持される", () => {
    const square: Pt[] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    const smoothed = smoothLoop(square, 2);
    // 4つの角の座標がそのまま残る
    for (const corner of square) {
      const found = smoothed.some(
        ([x, y]) => Math.abs(x - corner[0]) < 1e-9 && Math.abs(y - corner[1]) < 1e-9,
      );
      expect(found).toBe(true);
    }
  });

  it("階段状のガタガタは滑らかになる (方向転換の回数が減る)", () => {
    // ピクセル境界そのままのギザギザ斜め線を模したループ
    const staircase: Pt[] = [];
    for (let i = 0; i < 10; i++) {
      staircase.push([i * 2, i * 2]);
      staircase.push([i * 2 + 2, i * 2]);
    }
    staircase.push([20, 30]);
    staircase.push([0, 30]);
    // 80°以上の急な曲がり角の個数を数える
    const sharpTurns = (pts: Pt[]) => {
      let count = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[(i + pts.length - 1) % pts.length];
        const b = pts[i];
        const c = pts[(i + 1) % pts.length];
        const v1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const v2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
        let d = Math.abs(v2 - v1);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d >= (Math.PI * 80) / 180) count++;
      }
      return count;
    };
    const smoothed = smoothLoop(staircase, 2);
    // 階段は約19個の直角を持つ。平滑化後は底辺の本物の角 (長辺同士) 以外消える
    expect(sharpTurns(staircase)).toBeGreaterThan(15);
    expect(sharpTurns(smoothed)).toBeLessThanOrEqual(4);
    expect(smoothed.length).toBeGreaterThan(staircase.length);
  });

  it("iterations=0 は何もしない", () => {
    const loop: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(smoothLoop(loop, 0)).toEqual(loop);
  });
});

describe("PES/DST 出力の糸切り表現", () => {
  function makeTrimPattern(): Pattern {
    const p = new Pattern();
    p.threads.push(PEC_THREADS[19]);
    p.add(JUMP, 0, 0);
    p.add(STITCH, 0, 0);
    p.add(STITCH, 30, 0);
    p.add(TRIM, 30, 0);
    p.add(JUMP, 200, 0);
    p.add(STITCH, 200, 0);
    p.add(STITCH, 230, 0);
    p.add(4 /* END */, 230, 0);
    return p;
  }

  it("PEC: TRIM 直後の JUMP だけが糸切りフラグ (0x20) になる", () => {
    const data = writePes(makeTrimPattern());
    const pecAt = data[8] | (data[9] << 8) | (data[10] << 16) | (data[11] << 24);
    const stitchData = data.slice(pecAt + 512 + 16);
    // デコードして各ジャンプのフラグを集める
    const flags: number[] = [];
    let i = 0;
    while (i < stitchData.length) {
      const b0 = stitchData[i];
      if (b0 === 0xff) break;
      if (b0 === 0xfe && stitchData[i + 1] === 0xb0) {
        i += 3;
        continue;
      }
      if (b0 & 0x80) {
        flags.push(b0 & 0x30);
        i += 2;
        // y側
        if (stitchData[i] & 0x80) i += 2;
        else i += 1;
      } else {
        i += 1;
      }
    }
    // 最初のジャンプ = 0x10 (糸切りなし)、TRIM 後のジャンプ = 0x20 (糸切り)
    expect(flags[0]).toBe(0x10);
    expect(flags).toContain(0x20);
  });

  it("PEC: TRIM なしの JUMP は糸切りなし (0x10) で出力される", () => {
    const p = new Pattern();
    p.threads.push(PEC_THREADS[19]);
    p.add(JUMP, 0, 0);
    p.add(STITCH, 0, 0);
    p.add(STITCH, 30, 0);
    p.add(JUMP, 200, 0); // TRIM なし = 渡り糸
    p.add(STITCH, 200, 0);
    p.add(STITCH, 230, 0);
    p.add(4, 230, 0);
    const data = writePes(p);
    const pecAt = data[8] | (data[9] << 8) | (data[10] << 16) | (data[11] << 24);
    const stitchData = data.slice(pecAt + 512 + 16);
    let i = 0;
    const flags: number[] = [];
    while (i < stitchData.length) {
      const b0 = stitchData[i];
      if (b0 === 0xff) break;
      if (b0 === 0xfe && stitchData[i + 1] === 0xb0) {
        i += 3;
        continue;
      }
      if (b0 & 0x80) {
        flags.push(b0 & 0x30);
        i += 2;
        if (stitchData[i] & 0x80) i += 2;
        else i += 1;
      } else {
        i += 1;
      }
    }
    for (const f of flags) expect(f).toBe(0x10);
  });

  it("DST: TRIM は3連続の微小ジャンプ (正味移動ゼロ) になる", () => {
    const data = writeDst(makeTrimPattern());
    let x = 0;
    let y = 0;
    let jumpStreak = 0;
    let maxStreak = 0;
    for (let i = 512; i < data.length - 3; i += 3) {
      const d = decodeDstRecord(data[i], data[i + 1], data[i + 2]);
      x += d.dx;
      y += d.dy;
      if (d.jump) {
        jumpStreak++;
        maxStreak = Math.max(maxStreak, jumpStreak);
      } else {
        jumpStreak = 0;
      }
    }
    expect(maxStreak).toBeGreaterThanOrEqual(3); // trim 表現の3連ジャンプ + 移動
    expect(x).toBe(230);
    expect(y).toBe(0);
  });
});
