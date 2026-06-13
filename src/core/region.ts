// ベクター領域 (Region) の型定義。
// 画像/SVG 読み込み (Phase 2) の出力であり、ステッチ生成 (Phase 3) の入力になる。
// 座標は内部単位 (0.1mm)、原点はデザイン中心。パスは閉路。

import type { FillType, Point, ThreadColor } from "./types";

export interface Region {
  /** 外周 (時計回り = signedArea 正) */
  outer: Point[];
  /** 穴 (内周)。埋めてはならない */
  holes: Point[][];
  color: ThreadColor;
  /** 自己交差が検出された場合 true (診断で警告に使う) */
  selfIntersecting?: boolean;
  /** このパーツ固有の縫い方。未設定時はデジタイズオプションの fillType を使う */
  fillType?: FillType;
}
