// シーケンスビューの描画とインタラクション。
// 実際の縫製順でオブジェクト/Run を一覧し、色・タイプ・針数・糸切り・
// 渡り距離を表示する。色別/オブジェクト別/糸切りのみ/警告のみで絞り込み、
// ドラッグ&ドロップで色ブロック順を変更できる。

import { UNIT_MM } from "../core/constants";
import { reorderBlocks } from "../plan/sequence";
import type { SequenceEntry } from "../plan/sequence";
import { refreshDerived } from "./state";
import type { AppState } from "./state";

export type SeqFilter = "all" | "color" | "object" | "trims" | "warnings";

const typeLabels: Record<string, string> = {
  tatami: "タタミ",
  satin: "サテン",
  running: "ランニング",
  underlay: "下縫い",
};

function entryRow(e: SequenceEntry, state: AppState): string {
  const c = e.thread;
  const hidden = e.objectId !== null && state.hiddenObjectIds.has(e.objectId);
  const selected = e.objectId !== null && e.objectId === state.selectedObjectId;
  const badges: string[] = [];
  if (e.colorChange) badges.push('<span class="badge color">色替え</span>');
  if (e.trim) badges.push('<span class="badge trim">糸切り</span>');
  if (e.travel > 0) {
    const farClass = e.travel > 100 ? "far" : "";
    badges.push(`<span class="badge travel ${farClass}">移動 ${(e.travel * UNIT_MM).toFixed(1)}mm</span>`);
  }
  return `
    <div class="seq-row ${selected ? "selected" : ""} ${hidden ? "hidden" : ""}" data-block="${e.blockIndex}" data-object="${e.objectId ?? ""}" draggable="true">
      <span class="seq-num">${e.order + 1}</span>
      <span class="swatch" style="background:rgb(${c.r},${c.g},${c.b})"></span>
      <span class="seq-type">${typeLabels[e.stitchType] ?? e.stitchType}</span>
      <span class="seq-count">${e.stitchCount}針</span>
      <span class="seq-badges">${badges.join("")}</span>
      <button class="seq-eye" data-object="${e.objectId ?? ""}" title="表示/非表示">${hidden ? "○" : "●"}</button>
    </div>`;
}

export function renderSequence(container: HTMLElement, state: AppState, filter: SeqFilter): void {
  if (!state.sequence) {
    container.innerHTML = '<p class="note">ステッチがありません。</p>';
    return;
  }
  let entries = state.sequence.entries;
  if (filter === "trims") entries = entries.filter((e) => e.trim);
  if (filter === "warnings") entries = entries.filter((e) => e.travel > 100 || e.trim);

  const summary = `
    <div class="seq-summary">
      計 ${state.sequence.entries.length} オブジェクト /
      糸切り ${state.sequence.entries.filter((e) => e.trim).length} 回 /
      色替え ${state.sequence.entries.filter((e) => e.colorChange).length} 回
    </div>`;
  container.innerHTML = summary + entries.map((e) => entryRow(e, state)).join("");

  // クリックで選択
  container.querySelectorAll<HTMLElement>(".seq-row").forEach((row) => {
    row.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).classList.contains("seq-eye")) return;
      const obj = row.dataset.object;
      state.selectedObjectId = obj ? Number(obj) : null;
      state.onChange?.();
    });
  });
  // 目アイコンで表示/非表示
  container.querySelectorAll<HTMLElement>(".seq-eye").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const obj = btn.dataset.object;
      if (!obj) return;
      const id = Number(obj);
      if (state.hiddenObjectIds.has(id)) state.hiddenObjectIds.delete(id);
      else state.hiddenObjectIds.add(id);
      state.onChange?.();
    });
  });
  // D&D で色ブロック順を変更
  enableDragReorder(container, state);
}

function enableDragReorder(container: HTMLElement, state: AppState): void {
  let dragBlock: number | null = null;
  container.querySelectorAll<HTMLElement>(".seq-row").forEach((row) => {
    row.addEventListener("dragstart", () => {
      dragBlock = Number(row.dataset.block);
    });
    row.addEventListener("dragover", (e) => e.preventDefault());
    row.addEventListener("drop", () => {
      const target = Number(row.dataset.block);
      if (dragBlock !== null && state.plan && dragBlock !== target) {
        state.plan = reorderBlocks(state.plan, dragBlock, target);
        state.project.plan = state.plan;
        refreshDerived(state);
        state.onChange?.();
      }
    });
  });
}
