// 写真向け最適化: 縫い順 (断片化した色を先に) と細長い領域の自動角度

import { describe, expect, it } from "vitest";
import { digitize } from "../src/digitize/pipeline";
import { COLOR_CHANGE, STITCH } from "../src/embroidery/pattern";

function blank(w: number, h: number) {
  return new Uint8ClampedArray(w * h * 4);
}

function set(
  data: Uint8ClampedArray,
  w: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
) {
  const i = (y * w + x) * 4;
  data[i] = r;
  data[i + 1] = g;
  data[i + 2] = b;
  data[i + 3] = 255;
}

const OPTS = {
  sizeMm: 60,
  maxColors: 6,
  autoBackground: false,
  outline: false,
  outlineSmoothing: 0,
  autoThinDetect: false,
};

describe("縫い順: 断片化した色を先に縫う", () => {
  it("島の多い色が先に縫われ、渡りが後の色に覆われて糸切りが減る", () => {
    // 青の大きな土台の上に赤い島が4つ散らばる (赤=断片化)
    const w = 200;
    const h = 200;
    const data = blank(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(data, w, x, y, 40, 90, 220);
    const islands = [
      [30, 30],
      [140, 30],
      [30, 140],
      [140, 140],
    ];
    for (const [ix, iy] of islands) {
      for (let y = iy; y < iy + 30; y++) {
        for (let x = ix; x < ix + 30; x++) set(data, w, x, y, 220, 40, 40);
      }
    }
    const { pattern, stats } = digitize({ data, width: w, height: h }, OPTS);
    expect(stats.colors).toBe(2);
    // 赤 (4島) が先 → 赤の最初のステッチが青の最初のステッチより前
    let firstRed = -1;
    let colorIdx = 0;
    const threadOrder: string[] = [];
    for (const t of pattern.threads) {
      threadOrder.push(t.r > t.b ? "red" : "blue");
    }
    expect(threadOrder[0]).toBe("red"); // 断片化した赤が先
    expect(threadOrder[1]).toBe("blue");
    // 赤の島の間の渡りは青 (後で縫う) に覆われる → 糸切りは色替え分のみ
    expect(stats.trims).toBeLessThanOrEqual(2);
    void firstRed;
    void colorIdx;
  });

  it("線画系の色は断片化していても最後に縫われる", () => {
    // 黒の細い線 (断片化・thin) + 青の塊2つ
    const w = 200;
    const h = 200;
    const data = blank(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(data, w, x, y, 245, 245, 245);
    // 青い塊2つ
    for (let y = 20; y < 80; y++) for (let x = 20; x < 80; x++) set(data, w, x, y, 40, 90, 220);
    for (let y = 120; y < 180; y++) for (let x = 120; x < 180; x++) set(data, w, x, y, 40, 90, 220);
    // 黒い細線3本 (それぞれ独立 = 断片化している)
    for (let x = 20; x < 80; x++) for (let y = 100; y < 103; y++) set(data, w, x, y, 20, 20, 20);
    for (let x = 100; x < 160; x++) for (let y = 30; y < 33; y++) set(data, w, x, y, 20, 20, 20);
    for (let x = 100; x < 160; x++) for (let y = 60; y < 63; y++) set(data, w, x, y, 20, 20, 20);

    const { pattern } = digitize(
      { data, width: w, height: h },
      { ...OPTS, autoThinDetect: true, centerlineMaxWidthMm: 1.5 },
    );
    // 黒 (線画) が最後のスレッド
    const last = pattern.threads[pattern.threads.length - 1];
    expect(last.r).toBeLessThan(100); // 黒
  });
});

describe("細長い領域の縫い角度の自動調整", () => {
  it("横長リボンはステッチが縦方向 (長軸に直交) になる", () => {
    // 幅 8mm 相当の横長リボン (サテン上限6mmを超える → タタミ)
    const w = 300;
    const h = 60;
    const data = blank(w, h);
    for (let y = 16; y < 44; y++) {
      for (let x = 10; x < 290; x++) set(data, w, x, y, 220, 40, 40);
    }
    const run = (adaptive: boolean) =>
      digitize(
        { data, width: w, height: h },
        { ...OPTS, sizeMm: 84, angleDeg: 0, adaptiveAngle: adaptive },
      );

    const verticalShare = (pattern: { stitches: { x: number; y: number; cmd: number }[] }) => {
      let vertical = 0;
      let total = 0;
      let prev: { x: number; y: number } | null = null;
      for (const s of pattern.stitches) {
        if (s.cmd === STITCH) {
          if (prev) {
            const dx = Math.abs(s.x - prev.x);
            const dy = Math.abs(s.y - prev.y);
            if (dx + dy > 10) {
              total++;
              if (dy > dx) vertical++;
            }
          }
          prev = { x: s.x, y: s.y };
        } else {
          prev = null;
        }
      }
      return total > 0 ? vertical / total : 0;
    };

    const withAdaptive = verticalShare(run(true).pattern);
    const without = verticalShare(run(false).pattern);
    // 自動調整ありなら縦ステッチが支配的、なし (角度0=横) なら横が支配的
    expect(withAdaptive).toBeGreaterThan(0.6);
    expect(without).toBeLessThan(0.4);
  });

  it("正方形に近い塊はユーザー指定の角度のまま", () => {
    const w = 100;
    const h = 100;
    const data = blank(w, h);
    for (let y = 20; y < 80; y++) for (let x = 20; x < 80; x++) set(data, w, x, y, 220, 40, 40);
    const { pattern } = digitize(
      { data, width: w, height: h },
      { ...OPTS, sizeMm: 50, angleDeg: 0, adaptiveAngle: true },
    );
    // angle 0 = 横ステッチが支配的のはず
    let horizontal = 0;
    let total = 0;
    let prev: { x: number; y: number } | null = null;
    for (const s of pattern.stitches) {
      if (s.cmd === STITCH) {
        if (prev) {
          const dx = Math.abs(s.x - prev.x);
          const dy = Math.abs(s.y - prev.y);
          if (dx + dy > 10) {
            total++;
            if (dx > dy) horizontal++;
          }
        }
        prev = { x: s.x, y: s.y };
      } else {
        prev = null;
      }
    }
    expect(horizontal / total).toBeGreaterThan(0.6);
  });
});

describe("写真風の細かいまだら模様", () => {
  it("ランダムノイズ的な2色のまだらでも糸切りが抑えられる", () => {
    // 决定的な疑似ランダムで2色のまだらを作る (写真の縮図)
    const w = 150;
    const h = 150;
    const data = blank(w, h);
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    // ベースは茶色、ところどころに 6-14px の暗い斑点
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(data, w, x, y, 180, 140, 100);
    for (let k = 0; k < 25; k++) {
      const cx = 10 + rnd() * 130;
      const cy = 10 + rnd() * 130;
      const r = 4 + rnd() * 6;
      for (let y = Math.max(0, cy - r) | 0; y < Math.min(h, cy + r); y++) {
        for (let x = Math.max(0, cx - r) | 0; x < Math.min(w, cx + r); x++) {
          if (Math.hypot(x - cx, y - cy) <= r) set(data, w, x, y, 90, 60, 40);
        }
      }
    }
    const { stats } = digitize({ data, width: w, height: h }, { ...OPTS, sizeMm: 70 });
    expect(stats.colors).toBe(2);
    // 斑点色が先に縫われ、渡りはベース色に覆われる → 糸切りは島数よりはるかに少ない
    expect(stats.trims).toBeLessThanOrEqual(4);
  });
});
