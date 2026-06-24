// ステッチ生成の共通型。
// ジェネレーターはプラグイン構造 (registry.ts) で追加できる。

import type { Region } from "../core/region";
import type { StitchRun } from "../core/types";

export interface GeneratorResult {
  /** 生成された Run 群。1つの面は必ず1本の連続 Run になっていること */
  runs: StitchRun[];
  /** 品質警告 (幅超過・密度異常など)。診断パネルに表示する */
  warnings: string[];
  /**
   * サテンで分岐形状 (1行に複数区間) を検出したか。true のとき最も広い帯しか
   * 縫えずパーツが欠けるため、呼び出し側はタタミにフォールバックする。
   * 警告文字列のマッチではなくこのフラグで判定すること。
   */
  branched?: boolean;
}

/** タタミ (面縫い) のパラメータ */
export interface TatamiParams {
  /** ステッチ角度 (度)。0 = 水平 */
  angleDeg: number;
  /** 行間隔 (内部単位) */
  rowSpacing: number;
  /** ステッチ長 (内部単位) */
  stitchLength: number;
  /**
   * 針落ち位置のランダム化係数 (0〜0.5)。各行内の中間針を ±(stitchLength×係数)
   * だけ決定的に揺らし、針が縦に揃って出る格子模様 (モアレ) を崩す。
   * 0 で無効。未指定は既定値 (TATAMI_RANDOM_FACTOR)。端点は境界上に固定。
   */
  randomFactor?: number;
}

/** サテンのパラメータ */
export interface SatinParams {
  /** ジグザグの間隔 (内部単位) */
  spacing: number;
  /** 幅がこれを超えたら警告 (内部単位) */
  maxWidth: number;
  /**
   * 縫い角度の自動最適化。主軸直交を基準に角度を振り、1針 (レール間スパン) の
   * 最大長が最小になる向きを選ぶ。湾曲・歪んだ形でストロークを短くする。既定 true。
   */
  optimizeAngle?: boolean;
}

/** ランニングステッチのパラメータ */
export interface RunningParams {
  /** ステッチ長 (内部単位) */
  stitchLength: number;
  /** 二重走り (往復して開始点に戻る) */
  double: boolean;
}

/** ジグザグライン (簡易サテンライン) のパラメータ */
export interface ZigzagLineParams {
  /** 線幅 (内部単位) */
  width: number;
  /** ジグザグの間隔 (内部単位) */
  spacing: number;
}

/** 下縫いの種類 */
export type UnderlayType = "edge" | "center" | "zigzag" | "tatami";

export type StitchGenerator = (region: Region, params: unknown) => GeneratorResult;
