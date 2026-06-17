// 全フェーズ共通の数値パラメータ。マジックナンバーをコードに散らさず、ここに集約する。
// 内部座標系: 0.1mm 単位の整数。原点はデザイン中心。+x 右、+y 下。

/** 内部座標の単位 (mm) */
export const UNIT_MM = 0.1;

/** mm → 内部単位 */
export function mm(v: number): number {
  return Math.round(v / UNIT_MM);
}

/** 刺繍枠の最大サイズ (100mm × 100mm)。中心原点なので ±500 単位 */
export const HOOP_SIZE = mm(100);
export const HOOP_HALF = HOOP_SIZE / 2;

/** PP1 の針数上限 */
export const MAX_STITCH_COUNT = 12000;

/** 最小ステッチ長 (0.5mm)。これ未満は削除/統合の対象 */
export const MIN_STITCH_LEN = mm(0.5);

/** 最大ステッチ長 (12.1mm)。DST の1レコード上限でもある */
export const MAX_STITCH_LEN = mm(12.1);

/** 糸切り閾値 (デフォルト値。ユーザー変更可) */
export const TRIM_THRESHOLDS = {
  /** これ未満の渡りは絶対に糸切りしない (3mm) */
  neverTrimBelow: mm(3),
  /** これ未満は原則つなぐ (5mm) */
  preferJoinBelow: mm(5),
  /** これ以上は糸切り候補 (10mm) */
  trimAbove: mm(10),
} as const;

/** タタミのデフォルト: 行間隔 0.4mm / ステッチ長 3.0mm */
export const TATAMI_DEFAULT = {
  rowSpacing: mm(0.4),
  stitchLength: mm(3.0),
} as const;

/**
 * タタミの針落ちランダム化の既定係数 (ステッチ長に対する片振り比)。
 * 0.2 = ±20%。針が縦に整列して生じる格子状のモアレを崩す控えめな値。
 */
export const TATAMI_RANDOM_FACTOR = 0.2;

/** サテンのデフォルト: 密度 0.4mm 間隔 / 最大幅 7mm */
export const SATIN_DEFAULT = {
  spacing: mm(0.4),
  maxWidth: mm(7),
} as const;

/** ランニングのデフォルトステッチ長 (2.5mm) */
export const RUNNING_DEFAULT_LEN = mm(2.5);

/** 推定縫製時間の概算速度 (針/分) */
export const STITCHES_PER_MINUTE = 400;

/** 診断: 糸切り回数が「色数 × この倍率」を超えたら警告 */
export const TRIM_WARN_FACTOR = 3;

/** 診断: 色数がこれを超えたら警告 (PP1 での糸替え負担) */
export const COLOR_WARN_COUNT = 12;
