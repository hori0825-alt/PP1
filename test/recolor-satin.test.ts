// PDF レポート対応: サテン誤適用 (リボン消失) と色のクリック修正

import { describe, expect, it } from "vitest";
import { digitize } from "../src/digitize/pipeline";

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
  maxColors: 4,
  autoBackground: false,
  outline: false,
  outlineSmoothing: 0,
};

describe("サテン判定の90パーセンタイル幅 (リボン消失対策)", () => {
  it("部分的に太いリボンはサテンにせずタタミで縫う (autoThin ON/OFF で針数がほぼ同じ)", () => {
    // 細い帯 (約3mm) の中央に太い膨らみ (約9mm) があるリボン状の形
    const w = 300;
    const h = 80;
    const data = blank(w, h);
    for (let x = 10; x < 290; x++) {
      // 基本幅 10px (3mm at 60mm/300px=0.2mm/px → 2mm)…中央で 45px (9mm)
      const bulge = Math.max(0, 1 - Math.abs(x - 150) / 60);
      const half = 5 + Math.round(20 * bulge);
      for (let y = 40 - half; y < 40 + half; y++) set(data, w, x, y, 220, 60, 60);
    }
    const on = digitize({ data, width: w, height: h }, { ...OPTS, autoThinDetect: true });
    const off = digitize({ data, width: w, height: h }, { ...OPTS, autoThinDetect: false });
    // どちらもタタミなので針数がほぼ同じ (サテン誤適用なら大きく減って隙間ができる)
    const ratio = on.stats.stitches / off.stats.stitches;
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
  });

  it("幅が均一な細い帯はこれまでどおりサテンになる", () => {
    const w = 300;
    const h = 40;
    const data = blank(w, h);
    for (let x = 10; x < 290; x++) {
      for (let y = 14; y < 26; y++) set(data, w, x, y, 220, 60, 60); // 幅12px ≈ 2.4mm
    }
    const on = digitize({ data, width: w, height: h }, { ...OPTS, autoThinDetect: true });
    expect(on.stats.stitches).toBeGreaterThan(50);
    expect(on.stats.trims).toBe(0);
  });
});

describe("クリックによる色の修正 (recolorPoints)", () => {
  it("指定した連結領域だけが指定色に塗り替わる", () => {
    const w = 150;
    const h = 100;
    const data = blank(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(data, w, x, y, 220, 60, 60); // 赤地
    // 青い島2つ
    for (let y = 30; y < 60; y++) for (let x = 20; x < 50; x++) set(data, w, x, y, 60, 60, 220);
    for (let y = 30; y < 60; y++) for (let x = 100; x < 130; x++) set(data, w, x, y, 60, 60, 220);

    const base = digitize({ data, width: w, height: h }, OPTS);
    expect(base.quant.palette.length).toBe(2);
    // パレット: 0=赤 (面積大), 1=青
    const redIdx = base.quant.palette[0].r > base.quant.palette[0].b ? 0 : 1;

    // 左の青い島を赤に変更
    const res = digitize(
      { data, width: w, height: h },
      { ...OPTS, recolorPoints: [{ x: 35, y: 45, color: redIdx }] },
    );
    const labelAt = (x: number, y: number) => res.quant.labels[y * w + x];
    expect(labelAt(35, 45)).toBe(redIdx); // 左の島は赤に
    expect(labelAt(115, 45)).not.toBe(redIdx); // 右の島は青のまま
  });
});
