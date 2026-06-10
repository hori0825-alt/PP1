import { describe, expect, it } from "vitest";
import { COLOR_CHANGE, END, JUMP, Pattern, STITCH } from "../src/embroidery/pattern";
import { PEC_THREADS } from "../src/embroidery/pecThreads";
import { writePes } from "../src/embroidery/pes";

/** 2色の四角形を縫う小さなテストパターン */
function makePattern(): Pattern {
  const p = new Pattern();
  p.name = "TEST";
  p.threads.push(PEC_THREADS[19]); // Black #20
  p.threads.push(PEC_THREADS[4]); // Red #5
  p.add(JUMP, -100, -100);
  p.add(STITCH, -100, -100);
  p.add(STITCH, 0, -100);
  p.add(STITCH, 0, 0);
  p.add(STITCH, -100, 0);
  p.add(STITCH, -100, -100);
  p.add(COLOR_CHANGE, -100, -100);
  p.add(JUMP, 20, 20);
  p.add(STITCH, 20, 20);
  p.add(STITCH, 100, 20);
  p.add(STITCH, 100, 100);
  p.add(STITCH, 20, 100);
  p.add(STITCH, 20, 20);
  p.add(END, 20, 20);
  return p;
}

function ascii(data: Uint8Array, start: number, len: number): string {
  return String.fromCharCode(...data.slice(start, start + len));
}

function u32le(data: Uint8Array, at: number): number {
  return data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24);
}

function u24le(data: Uint8Array, at: number): number {
  return data[at] | (data[at + 1] << 8) | (data[at + 2] << 16);
}

/** PEC ステッチデータのデコード (検証用) */
function decodePecStitches(data: Uint8Array, at: number) {
  const out: { dx: number; dy: number; kind: string }[] = [];
  let i = at;
  const readValue = (): { v: number; flag: number } => {
    const b0 = data[i++];
    if (b0 & 0x80) {
      const b1 = data[i++];
      let v = ((b0 & 0x0f) << 8) | b1;
      if (v & 0x800) v -= 0x1000;
      return { v, flag: b0 & 0x70 };
    }
    let v = b0 & 0x7f;
    if (v > 63) v -= 128;
    return { v, flag: 0 };
  };
  for (;;) {
    if (data[i] === 0xff) {
      out.push({ dx: 0, dy: 0, kind: "end" });
      break;
    }
    if (data[i] === 0xfe && data[i + 1] === 0xb0) {
      i += 3;
      out.push({ dx: 0, dy: 0, kind: "colorchange" });
      continue;
    }
    const x = readValue();
    const y = readValue();
    const kind = x.flag & 0x20 ? "trim" : x.flag & 0x10 ? "jump" : "stitch";
    out.push({ dx: x.v, dy: y.v, kind });
  }
  return out;
}

describe("writePes", () => {
  it("PES v1 のシグネチャと PEC オフセットが正しい", () => {
    const data = writePes(makePattern());
    expect(ascii(data, 0, 8)).toBe("#PES0001");
    const pecAt = u32le(data, 8);
    expect(pecAt).toBeGreaterThan(8);
    expect(ascii(data, pecAt, 3)).toBe("LA:");
  });

  it("CEmbOne / CSewSeg ブロックを含む", () => {
    const data = writePes(makePattern());
    const text = Array.from(data)
      .map((b) => String.fromCharCode(b))
      .join("");
    expect(text).toContain("CEmbOne");
    expect(text).toContain("CSewSeg");
  });

  it("PEC ヘッダが 512 バイトで色数・色番号が正しい", () => {
    const data = writePes(makePattern());
    const pecAt = u32le(data, 8);
    expect(ascii(data, pecAt, 8)).toBe("LA:TEST ");
    // 色数-1 は LA ヘッダ + 48 バイト目
    const colorCountAt = pecAt + 20 + 14 + 2 + 12;
    expect(data[colorCountAt]).toBe(1); // 2色 - 1
    expect(data[colorCountAt + 1]).toBe(20); // Black
    expect(data[colorCountAt + 2]).toBe(5); // Red
  });

  it("PEC ブロック長とステッチデータが往復で一致する", () => {
    const p = makePattern();
    const data = writePes(p);
    const pecAt = u32le(data, 8);
    const blockAt = pecAt + 512;
    const blockLen = u24le(data, blockAt + 2);
    // グラフィック: 全体1枚 + 色ごと2枚 = 3 x 228 バイトで終端
    expect(blockAt + blockLen + 3 * 228).toBe(data.length);

    const decoded = decodePecStitches(data, blockAt + 16);
    expect(decoded[decoded.length - 1].kind).toBe("end");
    expect(decoded.filter((d) => d.kind === "colorchange").length).toBe(1);

    // デルタを積算して絶対座標が一致するか確認
    let x = 0;
    let y = 0;
    const absolute: [number, number][] = [];
    for (const d of decoded) {
      if (d.kind === "end" || d.kind === "colorchange") continue;
      x += d.dx;
      y += d.dy;
      if (d.kind === "stitch") absolute.push([x, y]);
    }
    const expected = p.stitches
      .filter((s) => s.cmd === STITCH)
      .map((s) => [s.x, s.y]);
    // 先頭にジャンプ直後の0,0ステッチは生成されない (dx,dy 両方非ゼロのときのみ)
    expect(absolute).toEqual(expect.arrayContaining(expected));
  });

  it("空パターンでも書ける", () => {
    const p = new Pattern();
    p.add(END, 0, 0);
    const data = writePes(p);
    expect(ascii(data, 0, 8)).toBe("#PES0001");
  });
});
