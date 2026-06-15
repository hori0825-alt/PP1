// デザインライブラリ UI (ブラウザ層)。
// localStorage を KeyValueStore として注入し、保存・検索・お気に入り・
// 読み込みを行う。サムネイルは StitchPlan の SVG プレビュー。

import { UNIT_MM } from "../core/constants";
import { planBounds } from "../core/plan";
import { deserializeProject, serializeProject } from "../core/project";
import { planToSvg } from "../export/svgPreview";
import { DesignLibrary } from "../library/store";
import type { KeyValueStore, LibraryEntry } from "../library/store";
import { planStats } from "../plan/stats";
import { refreshDerived, restoreObjectsFromProject } from "./state";
import type { AppState } from "./state";

const localStorageAdapter: KeyValueStore = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // 容量超過等は無視
    }
  },
};

export const library = new DesignLibrary(localStorageAdapter);

let libQuery = "";
let libFavOnly = false;

/** 現在のデザインをライブラリに保存する */
export function saveCurrentToLibrary(state: AppState): boolean {
  if (!state.plan) return false;
  const bounds = planBounds(state.plan);
  const stats = planStats(state.plan);
  const entry: LibraryEntry = {
    id: state.project.id,
    name: state.project.name || "untitled",
    thumbnail: planToSvg(state.plan, { size: 120, showTravel: false }),
    sizeMm: {
      w: bounds ? (bounds.maxX - bounds.minX) * UNIT_MM : 0,
      h: bounds ? (bounds.maxY - bounds.minY) * UNIT_MM : 0,
    },
    colorCount: stats.colorCount,
    stitchCount: stats.stitchCount,
    createdAt: state.project.createdAt,
    updatedAt: new Date().toISOString(),
    threads: state.plan.blocks.map((b) => b.thread.name ?? `${b.thread.r},${b.thread.g},${b.thread.b}`),
    tags: state.project.meta.tags,
    favorite: state.project.meta.favorite,
    note: state.project.meta.note,
    projectJson: serializeProject(state.project),
  };
  library.save(entry);
  library.markRecent(entry.id);
  return true;
}

export function libraryTabContent(): string {
  const entries = library.list({ query: libQuery || undefined, favoriteOnly: libFavOnly });
  const cards = entries
    .map(
      (e) => `<div class="lib-card" data-id="${e.id}">
        <div class="lib-thumb">${e.thumbnail ?? ""}</div>
        <div class="lib-meta">
          <div class="lib-name">${e.favorite ? "★ " : ""}${e.name}</div>
          <div class="lib-sub">${e.sizeMm.w.toFixed(0)}×${e.sizeMm.h.toFixed(0)}mm · ${e.colorCount}色 · ${e.stitchCount.toLocaleString()}針</div>
          ${e.tags.length ? `<div class="lib-tags">${e.tags.map((t) => `<span class="badge">${t}</span>`).join("")}</div>` : ""}
        </div>
        <div class="lib-actions">
          <button class="lib-load" data-id="${e.id}">開く</button>
          <button class="lib-fav" data-id="${e.id}">${e.favorite ? "解除" : "★"}</button>
          <button class="lib-del" data-id="${e.id}">削除</button>
        </div>
      </div>`,
    )
    .join("");
  return `
    <h2>デザインライブラリ</h2>
    <input type="text" id="lib-search" placeholder="名前・タグ・メモで検索" value="${libQuery}" />
    <label><input type="checkbox" id="lib-fav-only" ${libFavOnly ? "checked" : ""}> お気に入りのみ</label>
    <button id="lib-save">現在のデザインを保存</button>
    <div class="lib-list">${cards || '<p class="note">保存済みデザインはありません。</p>'}</div>
  `;
}

/** ライブラリタブのイベントを束ねる。loadProject は選択時に呼ばれる */
export function bindLibraryTab(state: AppState, rerender: () => void): void {
  document.getElementById("lib-save")?.addEventListener("click", () => {
    if (saveCurrentToLibrary(state)) rerender();
    else alert("保存できるデザインがありません");
  });
  document.getElementById("lib-search")?.addEventListener("input", (e) => {
    libQuery = (e.target as HTMLInputElement).value;
    rerender();
  });
  document.getElementById("lib-fav-only")?.addEventListener("change", (e) => {
    libFavOnly = (e.target as HTMLInputElement).checked;
    rerender();
  });
  document.querySelectorAll<HTMLElement>(".lib-fav").forEach((b) =>
    b.addEventListener("click", () => {
      library.toggleFavorite(b.dataset.id as string);
      rerender();
    }),
  );
  document.querySelectorAll<HTMLElement>(".lib-del").forEach((b) =>
    b.addEventListener("click", () => {
      if (confirm("このデザインを削除しますか?")) {
        library.remove(b.dataset.id as string);
        rerender();
      }
    }),
  );
  document.querySelectorAll<HTMLElement>(".lib-load").forEach((b) =>
    b.addEventListener("click", () => {
      const e = library.get(b.dataset.id as string);
      if (!e) return;
      try {
        state.project = deserializeProject(e.projectJson);
        state.regions = state.project.regions;
        restoreObjectsFromProject(state); // 固定針・手動オブジェクト・id を復元
        state.plan = state.project.plan;
        state.raster = null;
        state.photoMode = false;
        library.markRecent(e.id);
        if (state.plan) refreshDerived(state);
        rerender();
      } catch (err) {
        alert(`読み込みに失敗しました: ${(err as Error).message}`);
      }
    }),
  );
}
