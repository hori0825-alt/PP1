// 出力前バリデーション。StitchPlan が PP1 で安全に縫えるかを検査する。
// エクスポーターを呼ぶ前に必ず実行し、error がある場合は出力をブロックする。

import {
  COLOR_WARN_COUNT,
  HOOP_HALF,
  MAX_STITCH_COUNT,
  MAX_STITCH_LEN,
  MIN_STITCH_LEN,
  TRIM_THRESHOLDS,
  TRIM_WARN_FACTOR,
} from "../core/constants";
import { countColorChanges, countStitches, countTrims, distance, planBounds } from "../core/plan";
import type { StitchPlan } from "../core/types";

export type Severity = "error" | "warning";

export interface ValidationIssue {
  severity: Severity;
  code:
    | "out-of-hoop"
    | "stitch-count-exceeded"
    | "long-stitch-in-run"
    | "continuous-too-far"
    | "short-stitches"
    | "too-many-colors"
    | "too-many-trims"
    | "trim-in-object"
    | "long-jump"
    | "empty-plan";
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  stats: {
    stitchCount: number;
    colorCount: number;
    colorChanges: number;
    trims: number;
    width: number;
    height: number;
    shortStitches: number;
  };
}

export function validatePlan(plan: StitchPlan): ValidationResult {
  const issues: ValidationIssue[] = [];
  const stitchCount = countStitches(plan);
  const colorCount = plan.blocks.filter((b) => b.runs.some((r) => r.stitches.length > 0)).length;
  const trims = countTrims(plan);
  const colorChanges = countColorChanges(plan);
  const bounds = planBounds(plan);

  if (stitchCount === 0 || bounds === null) {
    issues.push({ severity: "error", code: "empty-plan", message: "ステッチがありません" });
    return {
      ok: false,
      issues,
      stats: {
        stitchCount: 0,
        colorCount: 0,
        colorChanges: 0,
        trims: 0,
        width: 0,
        height: 0,
        shortStitches: 0,
      },
    };
  }

  // 枠 (100mm × 100mm、中心原点) 内か
  if (
    bounds.minX < -HOOP_HALF ||
    bounds.maxX > HOOP_HALF ||
    bounds.minY < -HOOP_HALF ||
    bounds.maxY > HOOP_HALF
  ) {
    issues.push({
      severity: "error",
      code: "out-of-hoop",
      message: `ステッチが100mm枠の外にあります (範囲 ${((bounds.maxX - bounds.minX) / 10).toFixed(1)}×${((bounds.maxY - bounds.minY) / 10).toFixed(1)}mm)`,
    });
  }

  // 針数上限
  if (stitchCount > MAX_STITCH_COUNT) {
    issues.push({
      severity: "error",
      code: "stitch-count-exceeded",
      message: `針数 ${stitchCount} が上限 ${MAX_STITCH_COUNT} を超えています`,
    });
  }

  // Run 内の連続性と短すぎるステッチ
  let shortStitches = 0;
  let longInRun = 0;
  let continuousTooFar = 0;
  let trimInObject = 0;
  let longJumps = 0;
  for (const block of plan.blocks) {
    for (let ri = 0; ri < block.runs.length; ri++) {
      const run = block.runs[ri];
      for (let i = 1; i < run.stitches.length; i++) {
        const d = distance(run.stitches[i - 1], run.stitches[i]);
        if (d > MAX_STITCH_LEN) longInRun++;
        else if (d > 0 && d < MIN_STITCH_LEN) shortStitches++;
      }
      if (ri > 0 && run.stitches.length > 0) {
        const prev = block.runs[ri - 1];
        if (prev.stitches.length > 0) {
          const gap = distance(prev.stitches[prev.stitches.length - 1], run.stitches[0]);
          // continuous 接続は通常ステッチで移動するため距離制限がある
          if (run.connection === "continuous" && gap > MAX_STITCH_LEN) continuousTooFar++;
          // 糸を切らない渡り (jump) が長いと渡り糸が表に出て引っかかる
          if (run.connection === "jump" && gap > TRIM_THRESHOLDS.trimAbove) longJumps++;
        }
        // 面内糸切り: 同一オブジェクトの連続 Run 間に trim があってはならない。
        // 糸切り根絶設計 (1領域=1連続Run) が崩れた時に出力前で必ず止める安全網。
        if (
          run.connection === "trim" &&
          run.objectId !== undefined &&
          run.objectId === prev.objectId
        ) {
          trimInObject++;
        }
      }
    }
  }
  if (longInRun > 0) {
    issues.push({
      severity: "warning",
      code: "long-stitch-in-run",
      message: `${MAX_STITCH_LEN / 10}mm を超えるステッチが ${longInRun} 針あります (出力時に自動分割されます)`,
    });
  }
  if (continuousTooFar > 0) {
    issues.push({
      severity: "warning",
      code: "continuous-too-far",
      message: `continuous 接続で ${MAX_STITCH_LEN / 10}mm を超える移動が ${continuousTooFar} 箇所あります (jump への変更を推奨)`,
    });
  }
  if (shortStitches > 0) {
    issues.push({
      severity: "warning",
      code: "short-stitches",
      message: `${MIN_STITCH_LEN / 10}mm 未満の短いステッチが ${shortStitches} 針あります`,
    });
  }
  if (trimInObject > 0) {
    issues.push({
      severity: "error",
      code: "trim-in-object",
      message: `同一オブジェクト内に糸切りが ${trimInObject} 箇所あります (面の途中で糸が切れます)`,
    });
  }
  if (longJumps > 0) {
    issues.push({
      severity: "warning",
      code: "long-jump",
      message: `${TRIM_THRESHOLDS.trimAbove / 10}mm を超える渡り (糸切りなし) が ${longJumps} 箇所あります (渡り糸が引っかかる恐れ)`,
    });
  }

  // 色数・糸切り回数
  if (colorCount > COLOR_WARN_COUNT) {
    issues.push({
      severity: "warning",
      code: "too-many-colors",
      message: `色数が ${colorCount} 色あります (糸替え負担が大きくなります)`,
    });
  }
  if (trims > Math.max(1, colorCount) * TRIM_WARN_FACTOR) {
    issues.push({
      severity: "warning",
      code: "too-many-trims",
      message: `糸切りが ${trims} 回あります (色数 ${colorCount} に対して多すぎます)`,
    });
  }

  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues,
    stats: {
      stitchCount,
      colorCount,
      colorChanges,
      trims,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
      shortStitches,
    },
  };
}
