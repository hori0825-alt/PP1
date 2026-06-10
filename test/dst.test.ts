import { describe, expect, it } from "vitest";
import { decodeDstRecord, encodeDstRecord, writeDst } from "../src/embroidery/dst";
import { COLOR_CHANGE, END, JUMP, Pattern, STITCH } from "../src/embroidery/pattern";
import { PEC_THREADS } from "../src/embroidery/pecThreads";

describe("encodeDstRecord", () => {
  it("全デルタ範囲 (-121..121) を往復できる", () => {
    for (let dx = -121; dx <= 121; dx += 7) {
      for (let dy = -121; dy <= 121; dy += 7) {
        const [b0, b1, b2] = encodeDstRecord(dx, dy, false, false);
        const d = decodeDstRecord(b0, b1, b2);
        expect([d.dx, d.dy]).toEqual([dx, dy]);
        expect(d.jump).toBe(false);
        expect(d.colorChange).toBe(false);
      }
    }
  });

  it("ジャンプと色替えフラグ", () => {
    const j = encodeDstRecord(5, -3, true, false);
    expect(decodeDstRecord(...j).jump).toBe(true);
    const c = encodeDstRecord(0, 0, false, true);
    expect(decodeDstRecord(...c).colorChange).toBe(true);
  });

  it("範囲外はエラー", () => {
    expect(() => encodeDstRecord(122, 0, false, false)).toThrow();
  });
});

describe("writeDst", () => {
  it("ヘッダ 512 バイト + レコード + 終端", () => {
    const p = new Pattern();
    p.threads.push(PEC_THREADS[19]);
    p.add(JUMP, 50, 50);
    p.add(STITCH, 50, 50);
    p.add(STITCH, 80, 50);
    p.add(STITCH, 80, 80);
    p.add(COLOR_CHANGE, 80, 80);
    p.add(STITCH, 50, 50);
    p.add(END, 50, 50);
    const data = writeDst(p);

    const header = String.fromCharCode(...data.slice(0, 512));
    expect(header.startsWith("LA:")).toBe(true);
    expect(header).toContain("ST:");
    expect(header).toContain("CO:  1");
    expect(data[512 - 1]).toBe(0x20);
    // 終端レコード
    expect(data[data.length - 1]).toBe(0xf3);

    // レコードをデコードして絶対座標を復元 (Y反転を戻す)
    let x = 0;
    let y = 0;
    const stitches: [number, number][] = [];
    for (let i = 512; i < data.length - 3; i += 3) {
      const d = decodeDstRecord(data[i], data[i + 1], data[i + 2]);
      x += d.dx;
      y += d.dy;
      if (!d.jump && !d.colorChange) stitches.push([x, -y]);
    }
    expect(stitches).toContainEqual([50, 50]);
    expect(stitches).toContainEqual([80, 80]);
  });

  it("長い移動は複数レコードに分割される", () => {
    const p = new Pattern();
    p.threads.push(PEC_THREADS[19]);
    p.add(JUMP, 400, 0);
    p.add(STITCH, 400, 0);
    p.add(STITCH, 405, 0);
    p.add(END, 405, 0);
    const data = writeDst(p);
    let x = 0;
    let y = 0;
    for (let i = 512; i < data.length - 3; i += 3) {
      const d = decodeDstRecord(data[i], data[i + 1], data[i + 2]);
      expect(Math.abs(d.dx)).toBeLessThanOrEqual(121);
      x += d.dx;
      y += d.dy;
    }
    expect(x).toBe(405);
    expect(y).toBe(0);
  });
});
