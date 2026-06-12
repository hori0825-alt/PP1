// 中間表現 (StitchPlan) の型定義。
//
// 設計原則 (前作の「面縫い途中で糸切りされる」問題の構造的排除):
//   - 糸切り・ジャンプは StitchRun 間の接続属性 (connection) としてのみ存在する。
//   - StitchRun の内部 (stitches 配列の途中) に糸切り/ジャンプを挿入する手段はない。
//   - 1つの面 (フィル領域) は必ず1本の連続した StitchRun として生成すること。
//   - エクスポーターは StitchPlan を忠実に変換するだけで、最適化判断をしない。

/** 内部座標 (0.1mm 単位の整数、原点はデザイン中心、+y 下) */
export interface Point {
  x: number;
  y: number;
}

/**
 * 前の Run からこの Run への接続方法。
 * - continuous: 糸を切らず通常ステッチで移動 (距離は最大ステッチ長以下であること)
 * - jump: 糸を切らずジャンプ (渡り糸) で移動
 * - trim: 糸を切ってからジャンプで移動
 *
 * ブロック先頭の Run の connection は無視される (色替えが暗黙の糸切りになるため、
 * 機械はジャンプで次の開始点へ移動する)。
 */
export type Connection = "continuous" | "jump" | "trim";

/** 連続したステッチの列。内部に糸切りは存在できない。 */
export interface StitchRun {
  stitches: Point[];
  connection: Connection;
}

/** 糸色。PES 出力時は Brother 標準64色パレットの最近色に割り当てる。 */
export interface ThreadColor {
  r: number;
  g: number;
  b: number;
  /** 表示名 (任意) */
  name?: string;
  /** メーカー色番号など (任意) */
  code?: string;
}

/** 同一糸色で連続して縫う単位。ブロック間は色替え (=糸切りを伴う)。 */
export interface ColorBlock {
  thread: ThreadColor;
  runs: StitchRun[];
}

/** デザイン全体のステッチ計画。全エクスポーターはこれだけを入力とする。 */
export interface StitchPlan {
  /** デザイン名 (ファイル内ラベルに使用、ASCII 8文字程度推奨) */
  name: string;
  blocks: ColorBlock[];
}
