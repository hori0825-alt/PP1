// 出力前診断。validatePlan の結果と planStats を統合し、
// OK / 注意 (warning) / 修正必須 (error) の3段階で項目化する。
// 各項目には自動修正の種別 (autofix) を付け、UI がボタンを出せるようにする。

import { MAX_STITCH_COUNT } from "../core/constants";
import type { StitchPlan } from "../core/types";
import { validatePlan } from "../export/validate";
import { planStats } from "./stats";

export type DiagnosticLevel = "ok" | "notice" | "critical";

/** 自動修正の種別。UI がこれを見て修正ボタンの動作を決める */
export type AutoFix = "reduce-stitches" | null;

export interface DiagnosticItem {
  level: DiagnosticLevel;
  /** 項目名 (短い見出し) */
  title: string;
  /** 詳細メッセージ */
  detail: string;
  autofix: AutoFix;
}

export interface DiagnosticReport {
  /** 全体判定: critical があれば critical、notice があれば notice、なければ ok */
  overall: DiagnosticLevel;
  items: DiagnosticItem[];
  stats: ReturnType<typeof planStats>;
}

export function diagnose(plan: StitchPlan): DiagnosticReport {
  const v = validatePlan(plan);
  const stats = planStats(plan);
  const items: DiagnosticItem[] = [];

  // validate の issue を診断項目へ変換
  for (const issue of v.issues) {
    items.push({
      level: issue.severity === "error" ? "critical" : "notice",
      title: issueTitle(issue.code),
      detail: issue.message,
      autofix: issue.code === "stitch-count-exceeded" ? "reduce-stitches" : null,
    });
  }

  // 針数が上限の 90% を超えていれば注意喚起 (まだ error ではない)
  if (stats.stitchCount <= MAX_STITCH_COUNT && stats.stitchCount > MAX_STITCH_COUNT * 0.9) {
    items.push({
      level: "notice",
      title: "針数が上限に近い",
      detail: `針数 ${stats.stitchCount} は上限 ${MAX_STITCH_COUNT} の90%を超えています`,
      autofix: "reduce-stitches",
    });
  }

  // 渡り糸の最大距離が長い (枠の半分超)
  if (stats.travel.max > 500) {
    items.push({
      level: "notice",
      title: "長い渡り糸",
      detail: `最大渡り距離が ${(stats.travel.max / 10).toFixed(1)}mm あります`,
      autofix: null,
    });
  }

  // 問題がなければ OK 項目を1つ出す
  const hasCritical = items.some((i) => i.level === "critical");
  const hasNotice = items.some((i) => i.level === "notice");
  if (!hasCritical && !hasNotice) {
    items.push({
      level: "ok",
      title: "問題なし",
      detail: `針数 ${stats.stitchCount} / 色数 ${stats.colorCount} / 糸切り ${stats.trims} 回。PP1 で安全に縫えます。`,
      autofix: null,
    });
  }

  // critical → notice → ok の順に並べる
  const rank: Record<DiagnosticLevel, number> = { critical: 0, notice: 1, ok: 2 };
  items.sort((a, b) => rank[a.level] - rank[b.level]);

  return {
    overall: hasCritical ? "critical" : hasNotice ? "notice" : "ok",
    items,
    stats,
  };
}

function issueTitle(code: string): string {
  switch (code) {
    case "out-of-hoop":
      return "枠外ステッチ";
    case "stitch-count-exceeded":
      return "針数オーバー";
    case "long-stitch-in-run":
      return "長すぎるステッチ";
    case "continuous-too-far":
      return "連続移動が長い";
    case "short-stitches":
      return "短すぎるステッチ";
    case "too-many-colors":
      return "色数が多い";
    case "too-many-trims":
      return "糸切りが多い";
    case "empty-plan":
      return "ステッチなし";
    default:
      return "注意";
  }
}
