// 刺繍データ診断: 出力前の品質チェック。
// 各項目を OK / 注意 / 修正必須 の3段階で評価し、自動修正のヒントを返す。

import { COLOR_CHANGE, JUMP, STITCH, TRIM } from "../embroidery/pattern";
import type { GlobalSettings } from "./object";
import type { Plan } from "./planner";

export type DiagLevel = "ok" | "warn" | "error";

export interface DiagItem {
  id: string;
  label: string;
  value: string;
  level: DiagLevel;
  detail?: string;
  /** 自動修正の種類 (UIがボタンに変換) */
  fix?: "reduceStitches" | "shrinkSize" | "mergeColors" | "raiseTrimDistance";
}

export function diagnose(plan: Plan, g: GlobalSettings): DiagItem[] {
  const { pattern, stats, segments } = plan;
  const items: DiagItem[] = [];
  const push = (i: DiagItem) => items.push(i);

  // 針数
  const overLimit = g.maxStitches > 0 && stats.stitches > g.maxStitches;
  push({
    id: "stitches",
    label: "総針数",
    value: `${stats.stitches.toLocaleString()} 針`,
    level: overLimit ? "error" : stats.stitches > g.maxStitches * 0.9 ? "warn" : "ok",
    detail: overLimit
      ? `PP1 の上限 ${g.maxStitches.toLocaleString()} 針を超えています。自動削減してください`
      : undefined,
    fix: overLimit ? "reduceStitches" : undefined,
  });

  // 枠サイズ
  const fits = stats.widthMm <= 100 && stats.heightMm <= 100;
  push({
    id: "hoop",
    label: "刺繍範囲",
    value: `${stats.widthMm.toFixed(1)} × ${stats.heightMm.toFixed(1)} mm`,
    level: fits ? "ok" : "error",
    detail: fits ? undefined : "PP1 の 100×100mm 枠を超えています",
    fix: fits ? undefined : "shrinkSize",
  });

  // 色数
  push({
    id: "colors",
    label: "色数",
    value: `${stats.colors} 色`,
    level: stats.colors > 10 ? "warn" : "ok",
    detail: stats.colors > 10 ? "色替えが多くなります。色の統合を検討してください" : undefined,
    fix: stats.colors > 10 ? "mergeColors" : undefined,
  });

  // 糸切り (色替えに伴う糸切りは必須なので除いて評価)
  const extraTrims = Math.max(0, stats.trims - stats.colorChanges);
  const trimPerObject = segments.length > 0 ? extraTrims / segments.length : 0;
  push({
    id: "trims",
    label: "糸切り回数",
    value: `${stats.trims} 回 (うち色替え分 ${Math.min(stats.trims, stats.colorChanges)})`,
    level: extraTrims > 30 ? "error" : trimPerObject > 0.6 ? "warn" : "ok",
    detail:
      extraTrims > 30
        ? "糸切りが多すぎます。接続距離を上げるか、色の統合・小領域の削除を検討してください"
        : undefined,
    fix: extraTrims > 30 ? "raiseTrimDistance" : undefined,
  });

  // 色替え
  push({
    id: "colorChanges",
    label: "色替え回数",
    value: `${stats.colorChanges} 回`,
    level:
      stats.colorChanges > stats.colors * 1.5 && stats.colorChanges > 6 ? "warn" : "ok",
    detail:
      stats.colorChanges > stats.colors * 1.5 && stats.colorChanges > 6
        ? "同じ色が分断されています。縫い順で同色をまとめてください"
        : undefined,
  });

  // 渡り距離
  push({
    id: "joins",
    label: "渡り距離 (平均 / 最大)",
    value: `${stats.avgJoinMm} / ${stats.maxJoinMm} mm`,
    level: stats.maxJoinMm > 60 ? "warn" : "ok",
  });

  // ステッチ長の分布
  let tooShort = 0;
  let tooLong = 0;
  let prev: { x: number; y: number } | null = null;
  for (const s of pattern.stitches) {
    if (s.cmd === STITCH) {
      if (prev) {
        const d = Math.hypot(s.x - prev.x, s.y - prev.y);
        if (d < 3) tooShort++; // < 0.3mm
        if (d > 120) tooLong++; // > 12mm
      }
      prev = { x: s.x, y: s.y };
    } else {
      prev = null;
    }
  }
  const shortRatio = stats.stitches > 0 ? tooShort / stats.stitches : 0;
  push({
    id: "shortStitches",
    label: "短すぎるステッチ (0.3mm未満)",
    value: `${tooShort} 針`,
    level: shortRatio > 0.1 ? "warn" : "ok",
    detail: shortRatio > 0.1 ? "糸切れ・目詰まりの原因になることがあります" : undefined,
  });
  push({
    id: "longStitches",
    label: "長すぎるステッチ (12mm超)",
    value: `${tooLong} 針`,
    level: tooLong > 0 ? "warn" : "ok",
  });

  // 面縫い途中の糸切り (構造上ゼロのはずだが実データを検証)
  let midObjectTrims = 0;
  for (const seg of segments) {
    for (let i = seg.from; i < seg.to; i++) {
      const cmd = pattern.stitches[i]?.cmd;
      if (cmd === TRIM || cmd === COLOR_CHANGE) midObjectTrims++;
    }
  }
  push({
    id: "midTrims",
    label: "面縫い途中の糸切り",
    value: midObjectTrims === 0 ? "なし" : `${midObjectTrims} 箇所`,
    level: midObjectTrims === 0 ? "ok" : "error",
  });

  // 糸切りなしジャンプ (Never Trim による渡り糸)
  let bareJumps = 0;
  for (let i = 1; i < pattern.stitches.length; i++) {
    if (
      pattern.stitches[i].cmd === JUMP &&
      pattern.stitches[i - 1].cmd !== TRIM &&
      pattern.stitches[i - 1].cmd !== COLOR_CHANGE &&
      i > 1
    ) {
      bareJumps++;
    }
  }
  push({
    id: "bareJumps",
    label: "糸切りなしの渡り糸",
    value: `${bareJumps} 本`,
    level: bareJumps > 5 ? "warn" : "ok",
    detail: bareJumps > 5 ? "縫い上がりに渡り糸が残ります (後でハサミ処理が必要)" : undefined,
  });

  // 推定時間
  push({
    id: "time",
    label: "推定縫製時間",
    value: `約 ${stats.estMinutes} 分`,
    level: "ok",
  });

  return items;
}

export function worstLevel(items: DiagItem[]): DiagLevel {
  if (items.some((i) => i.level === "error")) return "error";
  if (items.some((i) => i.level === "warn")) return "warn";
  return "ok";
}
