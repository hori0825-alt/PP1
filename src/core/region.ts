// ベクター領域 (Region) の型定義。
// 画像/SVG 読み込み (Phase 2) の出力であり、ステッチ生成 (Phase 3) の入力になる。
// 座標は内部単位 (0.1mm)、原点はデザイン中心。パスは閉路。

import type { FillType, Point, ThreadColor } from "./types";

/**
 * ステッチ方向を示す方向線 (ターニングステッチ用)。線分の向きが局所的な
 * 縫い目方向を表す。1領域に2本以上引くと、その間を補間して向きが流れる。
 */
export interface DirectionLine {
  a: Point;
  b: Point;
}

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
  /**
   * このパーツ固有のステッチ角度 (度)。未設定時は全体角度 (settings.angleDeg) を使う。
   * タタミ(面)の縫い目方向を決める。サテンは形状に沿うため影響しない。
   */
  angleDeg?: number;
  /**
   * 方向線 (ターニングステッチ)。2本以上あると角度を空間補間して
   * 縫い目が流れる。タタミ(面)のみ対象。1本以下なら angleDeg を使う。
   */
  angleLines?: DirectionLine[];
}
