// 実機テスト用サンプルデザインの定義 (決定的、画像不要)。
// 生成スクリプト (scripts/build-samples.ts) とラウンドトリップテストで共用する。
//
// 各サンプルは「確認したい挙動」と「期待される統計値」を持ち、
// 実機で縫った結果がこの期待値どおりかを照合できるようにする。

import { mm } from "../core/constants";
import type { Region } from "../core/region";
import type { Point, ThreadColor } from "../core/types";
import type { DigitizeOptions } from "../stitch/digitize";

export interface SampleDef {
  id: string;
  name: string;
  /** 確認したい挙動 */
  purpose: string;
  regions: Region[];
  options: DigitizeOptions;
  /** 期待される統計 (実機テストの照合用。許容幅つき) */
  expect: {
    colorChanges: number;
    /** 糸切り回数の許容上限 (これ以下なら合格) */
    maxTrims: number;
  };
}

function circle(cx: number, cy: number, r: number, n = 72): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    pts.push({ x: Math.round(cx + r * Math.cos(t)), y: Math.round(cy + r * Math.sin(t)) });
  }
  return pts;
}

function ring(cx: number, cy: number, r: number, n = 72): Point[] {
  // 穴用に反時計回り (負の符号付き面積)
  return circle(cx, cy, r, n).reverse();
}

const RED: ThreadColor = { r: 220, g: 30, b: 30, name: "Red" };
const BLUE: ThreadColor = { r: 30, g: 60, b: 200, name: "Blue" };
const GREEN: ThreadColor = { r: 30, g: 150, b: 70, name: "Green" };
const YELLOW: ThreadColor = { r: 240, g: 200, b: 40, name: "Yellow" };

/** (a) 単色の円: タタミの連続性 (面の途中で糸切りしない) を確認 */
export function sampleSolidCircle(): SampleDef {
  return {
    id: "a-solid-circle",
    name: "CIRCLE",
    purpose: "単色タタミの連続性。面の途中で糸切りが起きない (糸切り0回)",
    regions: [{ outer: circle(0, 0, mm(30)), holes: [], color: RED }],
    options: { angleDeg: 45 },
    expect: { colorChanges: 0, maxTrims: 0 },
  };
}

/** (b) 2色・穴あきドーナツ + 中心ドット: 穴の処理と色替えを確認 */
export function sampleDonut(): SampleDef {
  return {
    id: "b-donut",
    name: "DONUT",
    purpose: "穴あき形状 (穴を埋めない) と色替え。穴の内部に着地しない",
    regions: [
      { outer: circle(0, 0, mm(32)), holes: [ring(0, 0, mm(15))], color: BLUE },
      { outer: circle(0, 0, mm(9)), holes: [], color: YELLOW },
    ],
    options: { angleDeg: 0 },
    expect: { colorChanges: 1, maxTrims: 1 },
  };
}

/** (c) 3色・同色分散配置: 縫い順最適化と糸切り最小化を確認 */
export function sampleScatter(): SampleDef {
  const regions: Region[] = [];
  // 赤い花びら5枚 (分散)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * 2 * Math.PI;
    regions.push({
      outer: circle(Math.round(mm(28) * Math.cos(a)), Math.round(mm(28) * Math.sin(a)), mm(8)),
      holes: [],
      color: RED,
    });
  }
  // 中心の黄色
  regions.push({ outer: circle(0, 0, mm(10)), holes: [], color: YELLOW });
  // 緑の葉3枚 (下部に分散)
  for (let i = 0; i < 3; i++) {
    regions.push({ outer: circle(mm(-30 + 30 * i), mm(40), mm(5)), holes: [], color: GREEN });
  }
  return {
    id: "c-scatter",
    name: "FLOWER",
    purpose: "同色分散の縫い順最適化。糸切りは遠隔ジャンプのみ (色数+α)",
    regions,
    options: { angleDeg: 45 },
    // 3色 → 色替え2回。同色内の糸切りは遠隔分のみ (各色で数回まで)
    expect: { colorChanges: 2, maxTrims: 8 },
  };
}

export function allSamples(): SampleDef[] {
  return [sampleSolidCircle(), sampleDonut(), sampleScatter()];
}
