// Brother 標準64色パレット (PEC フォーマットの色番号 1〜64)。
// PES/PEC ではこのパレットのインデックスで糸色が保持されるため、
// 任意の RGB を最近色に割り当てて出力する。

import type { ThreadColor } from "../core/types";

export interface BrotherThread extends ThreadColor {
  /** PEC 色番号 (1始まり) */
  pecIndex: number;
}

function t(pecIndex: number, r: number, g: number, b: number, name: string): BrotherThread {
  return { pecIndex, r, g, b, name, code: String(pecIndex) };
}

export const BROTHER_PALETTE: readonly BrotherThread[] = [
  t(1, 14, 31, 124, "Prussian Blue"),
  t(2, 10, 85, 163, "Blue"),
  t(3, 0, 135, 119, "Teal Green"),
  t(4, 75, 107, 175, "Cornflower Blue"),
  t(5, 237, 23, 31, "Red"),
  t(6, 209, 92, 0, "Reddish Brown"),
  t(7, 145, 54, 151, "Magenta"),
  t(8, 228, 154, 203, "Light Lilac"),
  t(9, 145, 95, 172, "Lilac"),
  t(10, 158, 214, 125, "Mint Green"),
  t(11, 232, 169, 0, "Deep Gold"),
  t(12, 254, 186, 53, "Orange"),
  t(13, 255, 255, 0, "Yellow"),
  t(14, 112, 188, 31, "Lime Green"),
  t(15, 186, 152, 0, "Brass"),
  t(16, 168, 168, 168, "Silver"),
  t(17, 125, 111, 0, "Russet Brown"),
  t(18, 255, 255, 179, "Cream Brown"),
  t(19, 79, 85, 86, "Pewter"),
  t(20, 0, 0, 0, "Black"),
  t(21, 11, 61, 145, "Ultramarine"),
  t(22, 119, 1, 118, "Royal Purple"),
  t(23, 41, 49, 51, "Dark Gray"),
  t(24, 42, 19, 1, "Dark Brown"),
  t(25, 246, 74, 138, "Deep Rose"),
  t(26, 178, 118, 36, "Light Brown"),
  t(27, 252, 187, 197, "Salmon Pink"),
  t(28, 254, 55, 15, "Vermilion"),
  t(29, 240, 240, 240, "White"),
  t(30, 106, 28, 138, "Violet"),
  t(31, 168, 221, 196, "Seacrest"),
  t(32, 37, 132, 187, "Sky Blue"),
  t(33, 254, 179, 67, "Pumpkin"),
  t(34, 255, 243, 107, "Cream Yellow"),
  t(35, 208, 166, 96, "Khaki"),
  t(36, 209, 84, 0, "Clay Brown"),
  t(37, 102, 186, 73, "Leaf Green"),
  t(38, 19, 74, 70, "Peacock Blue"),
  t(39, 135, 135, 135, "Gray"),
  t(40, 216, 204, 198, "Warm Gray"),
  t(41, 67, 86, 7, "Dark Olive"),
  t(42, 253, 217, 222, "Flesh Pink"),
  t(43, 249, 147, 188, "Pink"),
  t(44, 0, 56, 34, "Deep Green"),
  t(45, 178, 175, 212, "Lavender"),
  t(46, 104, 106, 176, "Wisteria Violet"),
  t(47, 239, 227, 185, "Beige"),
  t(48, 247, 56, 102, "Carmine"),
  t(49, 181, 75, 100, "Amber Red"),
  t(50, 19, 43, 26, "Olive Green"),
  t(51, 199, 1, 86, "Dark Fuchsia"),
  t(52, 254, 158, 50, "Tangerine"),
  t(53, 168, 222, 235, "Light Blue"),
  t(54, 0, 103, 62, "Emerald Green"),
  t(55, 78, 41, 144, "Purple"),
  t(56, 47, 126, 32, "Moss Green"),
  t(57, 255, 204, 204, "Flesh Pink"),
  t(58, 255, 217, 17, "Harvest Gold"),
  t(59, 9, 91, 166, "Electric Blue"),
  t(60, 240, 249, 112, "Lemon Yellow"),
  t(61, 227, 243, 91, "Fresh Green"),
  t(62, 255, 153, 0, "Orange"),
  t(63, 255, 240, 141, "Cream Yellow"),
  t(64, 255, 200, 200, "Applique"),
];

/** RGB に最も近い Brother パレット色を返す */
export function nearestBrotherThread(color: ThreadColor): BrotherThread {
  let best = BROTHER_PALETTE[0];
  let bestD = Infinity;
  for (const th of BROTHER_PALETTE) {
    const dr = color.r - th.r;
    const dg = color.g - th.g;
    const db = color.b - th.b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = th;
    }
  }
  return best;
}
