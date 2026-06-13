// 文字刺繍の品質警告。小さすぎる・細すぎる文字は実機で潰れるため、
// フォントサイズから推定して警告と対処提案を出す。

import { UNIT_MM } from "../core/constants";

export interface TextWarning {
  level: "notice" | "critical";
  message: string;
}

export interface TextQualityInput {
  /** 文字の高さ (内部単位) */
  fontSize: number;
  /** パフィー (3D 立体) 文字か */
  puffy?: boolean;
}

/** 文字高 (mm) 別の推奨。一般にサテン文字は 5mm 未満で潰れやすい */
const MIN_HEIGHT_MM = 5;
const MIN_PUFFY_HEIGHT_MM = 8;
/** ステム幅の概算 = 文字高の約 12%。これが細すぎると縫えない */
const STEM_RATIO = 0.12;
const MIN_STEM_MM = 1.0;

export function checkTextQuality(input: TextQualityInput): TextWarning[] {
  const warnings: TextWarning[] = [];
  const heightMm = input.fontSize * UNIT_MM;
  const minHeight = input.puffy ? MIN_PUFFY_HEIGHT_MM : MIN_HEIGHT_MM;

  if (heightMm < minHeight) {
    warnings.push({
      level: "critical",
      message: `文字高 ${heightMm.toFixed(1)}mm は小さすぎます (推奨 ${minHeight}mm 以上)。潰れる場合はランニングへの変換を検討してください`,
    });
  }

  const stemMm = heightMm * STEM_RATIO;
  if (stemMm < MIN_STEM_MM) {
    warnings.push({
      level: "notice",
      message: `線幅が約 ${stemMm.toFixed(1)}mm と細く、目が詰まる恐れがあります。太めのフォントを推奨します`,
    });
  }

  if (input.puffy && heightMm < MIN_PUFFY_HEIGHT_MM + 2) {
    warnings.push({
      level: "notice",
      message: "パフィー (立体) 文字はスポンジ厚のぶん大きめが安全です",
    });
  }

  return warnings;
}
