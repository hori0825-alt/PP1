// 独自プロジェクト形式 (JSON) の保存・読み込み。
// 再編集できるよう、ソース (画像/SVG)・サイズ・生成設定・縫い順・
// 糸切り設定を保持する。StitchPlan 自体も保存し、読み込み直後に
// 再生成せずプレビューできるようにする。

import type { Region } from "./region";
import type { StitchPlan } from "./types";

export const PROJECT_VERSION = 2;

export type SourceKind = "image" | "svg" | "none";

export interface ProjectSettings {
  colorCount: number;
  removeWhiteBackground: boolean;
  targetSizeMm: number;
  angleDeg: number;
  trimMode: "auto" | "never" | "always";
  underlay: string[];
}

export interface Project {
  version: number;
  /** プロジェクト ID (作業指示書・QR 用。Phase 6.5 で発行) */
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  source: {
    kind: SourceKind;
    /** SVG はテキスト、画像は dataURL。none は null */
    data: string | null;
    fileName: string;
  };
  settings: ProjectSettings;
  /** 抽出済みの領域 (再ステッチ生成用) */
  regions: Region[];
  /** 生成済みステッチ計画 (読み込み直後のプレビュー用) */
  plan: StitchPlan | null;
  /** 出力履歴 (形式と日時) */
  exportHistory: { format: string; at: string }[];
  /** ライブラリ用メタデータ */
  meta: {
    tags: string[];
    favorite: boolean;
    note: string;
  };
}

export function createEmptyProject(name = "untitled"): Project {
  const now = new Date().toISOString();
  return {
    version: PROJECT_VERSION,
    id: generateId(),
    name,
    createdAt: now,
    updatedAt: now,
    source: { kind: "none", data: null, fileName: "" },
    settings: {
      colorCount: 6,
      removeWhiteBackground: true,
      targetSizeMm: 100,
      angleDeg: 45,
      trimMode: "auto",
      underlay: [],
    },
    regions: [],
    plan: null,
    exportHistory: [],
    meta: { tags: [], favorite: false, note: "" },
  };
}

/** 衝突しにくい短い ID を生成 (タイムスタンプ + ランダム) */
export function generateId(): string {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0x10000).toString(36);
  return `PP1-${t}-${r}`.toUpperCase();
}

export function serializeProject(project: Project): string {
  return JSON.stringify({ ...project, updatedAt: new Date().toISOString() });
}

export function deserializeProject(text: string): Project {
  const obj = JSON.parse(text) as Partial<Project>;
  if (typeof obj.version !== "number") {
    throw new Error("プロジェクトファイルの形式が不正です");
  }
  if (obj.version > PROJECT_VERSION) {
    throw new Error(`新しいバージョン (v${obj.version}) のプロジェクトです。アプリを更新してください`);
  }
  // 欠損フィールドを空プロジェクトで補完 (前方互換)
  const base = createEmptyProject();
  return {
    ...base,
    ...obj,
    settings: { ...base.settings, ...obj.settings },
    meta: { ...base.meta, ...obj.meta },
    source: { ...base.source, ...obj.source },
    regions: obj.regions ?? [],
    plan: obj.plan ?? null,
    exportHistory: obj.exportHistory ?? [],
  } as Project;
}
