// シーケンスビューの描画とインタラクション。
// 実際の縫製順でオブジェクト/Run を一覧し、色・タイプ・針数・糸切り・
// 渡り距離を表示する。色別/オブジェクト別/糸切りのみ/警告のみで絞り込み、
// ドラッグ&ドロップで色ブロック順を変更できる。

import { UNIT_MM } from "../core/constants";
import type { SequenceEntry } from "../plan/sequence";
import { moveColorBlock } from "./state";
import type { AppState } from "./state";

export type SeqFilter = "all" | "color" | "object" | "trims" | "warnings";

const typeLabels: Record<string, string> = {
  tatami: "タタミ",
  satin: "サテン",
  running: "ランニング",
  underlay: "下縫い",
};

function entryRow(e: SequenceEntry, state: AppState, isBlockStart: boolean, blockCount: number): string {
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
  // 色ブロックの先頭行に、色の縫い順を上下に動かすボタンを出す
  const reorder = isBlockStart
    ? `<span class="seq-reorder">
         <button class="seq-up" data-block="${e.blockIndex}" title="この色を先に縫う" ${e.blockIndex === 0 ? "disabled" : ""}>▲</button>
         <button class="seq-down" data-block="${e.blockIndex}" title="この色を後に縫う" ${e.blockIndex >= blockCount - 1 ? "disabled" : ""}>▼</button>
       </span>`
    : '<span class="seq-reorder"></span>';
  return `
    <div class="seq-row ${selected ? "selected" : ""} ${hidden ? "hidden" : ""}" data-block="${e.blockIndex}" data-object="${e.objectId ?? ""}" draggable="true">
      <span class="seq-num">${e.order + 1}</span>
      ${reorder}
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

  const blockCount = state.plan ? state.plan.blocks.length : 0;
  const summary = `
    <div class="seq-summary">
      計 ${state.sequence.entries.length} オブジェクト /
      糸切り ${state.sequence.entries.filter((e) => e.trim).length} 回 /
      色替え ${state.sequence.entries.filter((e) => e.colorChange).length} 回
      <div class="note">▲▼ または行のドラッグで色の縫い順を変えられます (保存されます)。</div>
    </div>`;
  // フィルタ後の並びで「各色ブロックの先頭行」を判定する
  let prevBlock = -1;
  const rowsHtml = entries
    .map((e) => {
      const isStart = e.blockIndex !== prevBlock;
      prevBlock = e.blockIndex;
      return entryRow(e, state, isStart, blockCount);
    })
    .join("");
  container.innerHTML = summary + rowsHtml;

  // 色順 上下ボタン
  container.querySelectorAll<HTMLElement>(".seq-up").forEach((b) =>
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const bi = Number(b.dataset.block);
      moveColorBlock(state, bi, bi - 1);
      state.onChange?.();
    }),
  );
  container.querySelectorAll<HTMLElement>(".seq-down").forEach((b) =>
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const bi = Number(b.dataset.block);
      moveColorBlock(state, bi, bi + 1);
      state.onChange?.();
    }),
  );

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
      if (dragBlock !== null && dragBlock !== target) {
        moveColorBlock(state, dragBlock, target); // settings.colorOrder に保存され再生成後も残る
        state.onChange?.();
      }
    });
  });
}
