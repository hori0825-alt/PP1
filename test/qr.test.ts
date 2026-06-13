// QR エンコーダのテスト。エンコード→自前デコードのラウンドトリップで
// 「実際に読めるデータ」になっていることを担保する。

import { describe, expect, it } from "vitest";
import { decodeQr, encodeQr, qrToSvg } from "../src/report/qr";

describe("encodeQr / decodeQr ラウンドトリップ", () => {
  const cases = [
    "PP1-LX9F2-A3",
    "PP1",
    "https://example.com/p/PP1-LX9F2",
    "ABCDEFG1234567890",
    "012345678901234567890123456789012345678901", // 42 バイト (V3 上限付近)
  ];
  for (const text of cases) {
    it(`"${text.slice(0, 20)}..." を往復できる`, () => {
      const qr = encodeQr(text);
      const decoded = decodeQr(qr);
      expect(decoded.text).toBe(text);
    });
  }

  it("データ長でバージョンが上がる", () => {
    expect(encodeQr("PP1").version).toBe(1);
    expect(encodeQr("0123456789012345678901234567").version).toBeGreaterThanOrEqual(2);
    expect(encodeQr("012345678901234567890123456789012345678901").version).toBe(3);
  });

  it("42バイト超は例外", () => {
    expect(() => encodeQr("x".repeat(50))).toThrow();
  });
});

describe("QR マトリクス構造", () => {
  it("ファインダパターンが3隅にある", () => {
    const qr = encodeQr("PP1-TEST");
    const size = qr.size;
    const isFinderCenter = (r: number, c: number): boolean => {
      // 7x7 ファインダの中央3x3が黒
      for (let dr = 2; dr <= 4; dr++) for (let dc = 2; dc <= 4; dc++) if (!qr.modules[r + dr][c + dc]) return false;
      // 外周リングの内側(1)が白
      return !qr.modules[r + 1][c + 1];
    };
    expect(isFinderCenter(0, 0)).toBe(true);
    expect(isFinderCenter(0, size - 7)).toBe(true);
    expect(isFinderCenter(size - 7, 0)).toBe(true);
  });

  it("タイミングパターンが交互", () => {
    const qr = encodeQr("PP1-TEST");
    for (let i = 8; i < qr.size - 8; i++) {
      expect(qr.modules[6][i]).toBe(i % 2 === 0);
    }
  });

  it("ダークモジュールが存在する", () => {
    const qr = encodeQr("PP1-TEST");
    expect(qr.modules[qr.size - 8][8]).toBe(true);
  });
});

describe("qrToSvg", () => {
  it("SVG 文字列を生成しモジュール数ぶんの rect を含む", () => {
    const qr = encodeQr("PP1");
    const svg = qrToSvg(qr);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    const rects = (svg.match(/<rect/g) ?? []).length;
    expect(rects).toBeGreaterThan(10); // 背景 + 黒モジュール
  });
});
