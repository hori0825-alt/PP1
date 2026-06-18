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
  /** 修正方法のヒント */
  hint: string;
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
      hint: issueHint(issue.code),
      autofix: issue.code === "stitch-count-exceeded" ? "reduce-stitches" : null,
    });
  }

  // 針数が上限の 90% を超えていれば注意喚起 (まだ error ではない)
  if (stats.stitchCount <= MAX_STITCH_COUNT && stats.stitchCount > MAX_STITCH_COUNT * 0.9) {
    items.push({
      level: "notice",
      title: "針数が上限に近い",
      detail: `針数 ${stats.stitchCount} は上限 ${MAX_STITCH_COUNT} の90%を超えています`,
      hint: "ステッチタブで「密度」を省針数に変更するか、「目標針数」を設定してください。下の自動削減ボタンも使えます。",
      autofix: "reduce-stitches",
    });
  }

  // 渡り糸の最大距離が長い (枠の半分超)
  if (stats.travel.max > 500) {
    items.push({
      level: "notice",
      title: "長い渡り糸",
      detail: `最大渡り距離が ${(stats.travel.max / 10).toFixed(1)}mm あります`,
      hint: "縫い順タブでオブジェクトの順序を確認してください。離れたパーツが連続していると渡り糸が長くなります。糸切りモードを「常に切る」にすると布裏の見た目が改善します。",
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
      hint: "",
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

function issueHint(code: string): string {
  switch (code) {
    case "out-of-hoop":
      return "デザインタブでサイズを小さくしてください (100mm 枠に収まるように)。ベクター編集で輪郭をドラッグして位置を調整することもできます。";
    case "stitch-count-exceeded":
      return "ステッチタブで「密度」を省針数に変更するか、「目標針数」を設定してください。デザインのサイズを小さくしたり、色数を減らすのも効果的です。下の自動削減ボタンで自動調整もできます。";
    case "long-stitch-in-run":
      return "通常は出力時に自動分割されるため、そのまま書き出して問題ありません。気になる場合はベクター編集で該当パーツの形状を滑らかにしてください。";
    case "continuous-too-far":
      return "ステッチタブで糸切りモードを「自動」にしてください。自動では距離に応じてジャンプや糸切りに切り替わります。";
    case "short-stitches":
      return "非常に小さいパーツや細い隙間が原因です。ベクター編集で極小の輪郭を削除するか、デザインタブの除外パネルで小領域を除外してください。";
    case "too-many-colors":
      return "色タブで色数を減らしてください。色替えのたびにミシンが停止するため、PP1 では 6〜8 色以内を推奨します。";
    case "too-many-trims":
      return "ステッチタブで糸切りモードを「切らない」に変更すると糸切りが減ります。ただし布裏に渡り糸が残ります。パーツの配置を近づけて渡り距離を短くするのも有効です。";
    case "empty-plan":
      return "デザインタブで画像や SVG を読み込んでください。文字タブからテキストを刺繍化することもできます。";
    default:
      return "";
  }
}
