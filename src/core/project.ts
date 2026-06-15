// 独自プロジェクト形式 (JSON) の保存・読み込み。
// 再編集できるよう、ソース (画像/SVG)・サイズ・生成設定・縫い順・
// 糸切り設定を保持する。StitchPlan 自体も保存し、読み込み直後に
// 再生成せずプレビューできるようにする。

import type { Region } from "./region";
import type { StitchPlan, StitchRun } from "./types";

export const PROJECT_VERSION = 3;

export type SourceKind = "image" | "svg" | "none";

export interface ProjectSettings {
  colorCount: number;
  removeWhiteBackground: boolean;
  targetSizeMm: number;
  angleDeg: number;
  trimMode: "auto" | "never" | "always";
  underlay: string[];
  /** 布地レシピ ID (src/fabric/recipes.ts) */
  fabricId: string;
  /**
   * 密度スケール (針数プリセット)。フィル行間隔・サテン間隔に掛ける倍率。
   * 1.0 = 標準 (レシピ既定)、>1 で粗く (省針数)、<1 で密に。未指定は 1.0。
   */
  densityScale?: number;
  /**
   * 目標針数。設定すると、超過時に密度を自動で粗くして目標内に収める
   * (先回り autoReduce)。未指定/0 = 上限なし。
   */
  targetStitchCount?: number;
  /**
   * 色 (糸) の縫い順の手動指定。"r,g,b" キーの並び。
   * 指定があれば digitize はこの順で色ブロックを縫う (なければ面積順=背景が先)。
   */
  colorOrder?: string[];
  /**
   * 同色内のオブジェクト縫い順の手動指定 (オブジェクト id の並び)。
   * 指定があれば digitize は同色グループ内をこの順で縫う (なければ Closest Join 最適化)。
   * 色をまたぐ順序は colorOrder が優先し、本配列は各色グループ内の相対順だけ使う。
   */
  objectOrder?: number[];
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
  /**
   * 永続オブジェクト層 (regions と添字で対応)。安定 id とマニュアル編集針列 (baked) を
   * 保存し、再読込後も固定針・手動の線・選択の同一性を保つ。
   */
  objects?: { id: number; baked?: StitchRun[]; name?: string }[];
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
      underlay: ["edge"],
      fabricId: "standard",
      densityScale: 1.0,
    },
    regions: [],
    objects: [],
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
    objects: obj.objects ?? [],
    plan: obj.plan ?? null,
    exportHistory: obj.exportHistory ?? [],
  } as Project;
}
