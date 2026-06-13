// PP1 Stitch Studio v2 — メイン UI (Phase 5)。
// 左ツール / 中央キャンバス / 右プロパティ / 下シミュレーター・シーケンス。
// かんたんモード (ウィザード) とプロモード (全タブ) を切替。

import { UNIT_MM } from "../core/constants";
import { countStitches, countTrims } from "../core/plan";
import { deserializeProject, serializeProject } from "../core/project";
import { writeDst } from "../export/dst";
import { writePes } from "../export/pes";
import { setNodeType } from "../vector/path";
import type { NodeType } from "../vector/path";
import { renderCanvas, createViewport, fitViewport, screenToDesign } from "./canvas";
import type { Viewport } from "./canvas";
import { decodeImageFile } from "./loadImage";
import { renderSequence } from "./sequenceView";
import type { SeqFilter } from "./sequenceView";
import {
  applyAutoReduce,
  applyVectorEdit,
  cancelVectorEdit,
  createState,
  enterVectorEdit,
  recomputeRegions,
  recomputeStitches,
  refreshDerived,
  setSourceImage,
  setSourceSvg,
} from "./state";
import type { AppState, Tab, VectorTool, ViewMode } from "./state";
import {
  attachVectorPointer,
  drawVectorEdit,
  vectorSetAllType,
  vectorTabContent,
} from "./vectorEdit";
import "./app.css";

declare const __APP_VERSION__: string;

const state: AppState = createState();
const viewport: Viewport = createViewport();
let seqFilter: SeqFilter = "all";
let simTimer: number | null = null;
let detachVectorPointer: (() => void) | null = null;

function download(filename: string, data: Uint8Array | string, mime = "application/octet-stream"): void {
  const blob = typeof data === "string" ? new Blob([data], { type: mime }) : new Blob([data.buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

// --- ヘッダー (統計チップ) ---
function headerChips(): string {
  if (!state.diagnostics) return "";
  const d = state.diagnostics;
  const overLimit = d.items.some((i) => i.autofix === "reduce-stitches" && i.level === "critical");
  return `
    <span class="chip ${overLimit ? "danger" : ""}">${d.stats.stitchCount} 針</span>
    <span class="chip">${d.stats.colorCount} 色</span>
    <span class="chip">糸切り ${d.stats.trims}</span>
    <span class="chip ${d.overall === "critical" ? "danger" : d.overall === "notice" ? "warn" : "ok"}">
      ${d.overall === "critical" ? "要修正" : d.overall === "notice" ? "注意" : "OK"}
    </span>`;
}

// --- 右パネル: タブ内容 ---
function tabContent(): string {
  switch (state.tab) {
    case "design":
      return designTab();
    case "color":
      return colorTab();
    case "stitch":
      return stitchTab();
    case "vector":
      return vectorTabContent(state);
    case "sequence":
      return `<div id="seq-controls">
        ${(["all", "trims", "warnings"] as SeqFilter[])
          .map((f) => `<button class="filter ${seqFilter === f ? "active" : ""}" data-filter="${f}">${f === "all" ? "すべて" : f === "trims" ? "糸切りのみ" : "警告のみ"}</button>`)
          .join("")}
      </div><div id="sequence-list"></div>`;
    case "fabric":
      return `<p class="note">布地レシピは Phase 5.5 で実装します。</p>`;
    case "diagnostics":
      return diagnosticsTab();
    case "output":
      return outputTab();
    default:
      return "";
  }
}

function designTab(): string {
  const s = state.project.settings;
  const loaded = state.project.source.kind !== "none";
  return `
    <h2>1. 読み込み</h2>
    <input type="file" id="file" accept=".png,.jpg,.jpeg,.bmp,.svg" />
    <h2>2. サイズ</h2>
    <div class="size-presets">
      ${[100, 70, 50, 30, 20]
        .map((v) => `<button class="preset ${v === s.targetSizeMm ? "active" : ""}" data-size="${v}">${v / 10}cm</button>`)
        .join("")}
    </div>
    ${loaded ? `<h2>表示</h2>
    <div class="view-tabs">
      ${(["original", "quantized", "vector", "stitch"] as ViewMode[])
        .map((vm) => `<button class="vtab ${state.view === vm ? "active" : ""}" data-view="${vm}">${{ original: "元画像", quantized: "減色", vector: "ベクター", stitch: "ステッチ" }[vm]}</button>`)
        .join("")}
    </div>` : `<p class="note">PNG / JPG / SVG を読み込むと自動で刺繍化されます。</p>`}
  `;
}

function colorTab(): string {
  const s = state.project.settings;
  const isImage = state.project.source.kind === "image";
  let table = "";
  if (state.plan) {
    const rows = state.plan.blocks
      .map((b) => {
        const stitches = b.runs.reduce((n, r) => n + r.stitches.length, 0);
        return `<tr><td><span class="swatch" style="background:rgb(${b.thread.r},${b.thread.g},${b.thread.b})"></span></td>
          <td>${b.thread.name ?? `${b.thread.r},${b.thread.g},${b.thread.b}`}</td><td>${stitches}針</td></tr>`;
      })
      .join("");
    table = `<table class="colors"><thead><tr><th>色</th><th>名称</th><th>針数</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  return `
    <h2>色数削減</h2>
    ${isImage ? `<label>色数 <input type="range" id="colors" min="2" max="15" value="${s.colorCount}"><span>${s.colorCount}</span></label>
    <label><input type="checkbox" id="white" ${s.removeWhiteBackground ? "checked" : ""}> 白背景を除去</label>` : `<p class="note">SVG はベクター色をそのまま使用します。</p>`}
    <h2>使用色 (縫い順)</h2>
    ${table || '<p class="note">画像を読み込んでください。</p>'}
  `;
}

function stitchTab(): string {
  const s = state.project.settings;
  return `
    <h2>タタミ設定</h2>
    <label>角度
      <select id="angle">${[0, 45, 90, 135].map((v) => `<option value="${v}" ${v === s.angleDeg ? "selected" : ""}>${v}°</option>`).join("")}</select>
    </label>
    <h2>下縫い</h2>
    ${(["edge", "tatami"] as const)
      .map((u) => `<label><input type="checkbox" class="underlay" value="${u}" ${s.underlay.includes(u) ? "checked" : ""}> ${u === "edge" ? "エッジ下縫い" : "タタミ下縫い"}</label>`)
      .join("")}
    <h2>糸切り</h2>
    <label>モード
      <select id="trim">
        <option value="auto" ${s.trimMode === "auto" ? "selected" : ""}>自動 (距離判定)</option>
        <option value="never" ${s.trimMode === "never" ? "selected" : ""}>切らない</option>
        <option value="always" ${s.trimMode === "always" ? "selected" : ""}>常に切る</option>
      </select>
    </label>
  `;
}

function diagnosticsTab(): string {
  if (!state.diagnostics) return '<p class="note">画像を読み込んでください。</p>';
  const d = state.diagnostics;
  const icon: Record<string, string> = { critical: "✗", notice: "⚠", ok: "✓" };
  const items = d.items
    .map(
      (i) => `<div class="diag-item ${i.level}">
        <div class="diag-head">${icon[i.level]} ${i.title}</div>
        <div class="diag-detail">${i.detail}</div>
        ${i.autofix === "reduce-stitches" ? '<button class="diag-fix" data-fix="reduce">自動針数削減</button>' : ""}
      </div>`,
    )
    .join("");
  const reduced =
    state.reduceApplied.length > 0
      ? `<div class="reduced">${state.reduceApplied.map((s) => `<p>✓ ${s}</p>`).join("")}</div>`
      : "";
  return `<div class="diag-list">${items}</div>${reduced}`;
}

function outputTab(): string {
  const canExport = state.plan !== null && state.diagnostics?.overall !== "critical";
  return `
    <h2>刺繍データ出力</h2>
    <button id="dl-pes" ${canExport ? "" : "disabled"}>PES をダウンロード</button>
    <button id="dl-dst" ${canExport ? "" : "disabled"}>DST をダウンロード</button>
    ${state.diagnostics?.overall === "critical" ? '<p class="error">⚠ 修正必須の項目があります。診断タブで確認してください。</p>' : ""}
    <h2>プロジェクト</h2>
    <button id="save-proj" class="secondary">プロジェクトを保存 (.json)</button>
    <button id="load-proj" class="secondary">プロジェクトを開く</button>
    <input type="file" id="proj-file" accept=".json" hidden />
    <p class="note">作業指示書 PDF・QR コードは Phase 6.5 で実装します。</p>
  `;
}

// --- 下部: シミュレーター ---
function simulatorBar(): string {
  if (!state.simulation) return "";
  const sim = state.simulation;
  const cur = state.simFrame;
  const frame = sim.frames[Math.min(cur, sim.frames.length) - 1];
  return `
    <div class="sim-bar">
      <button id="sim-play">${state.simPlaying ? "⏸" : "▶"}</button>
      <button id="sim-reset">⏮</button>
      <button id="sim-prevtrim" title="前の糸切りへ">✂◀</button>
      <button id="sim-nexttrim" title="次の糸切りへ">▶✂</button>
      <input type="range" id="sim-slider" min="0" max="${sim.frames.length}" value="${cur}" />
      <span class="sim-info">${frame ? frame.stitchNumber : 0} / ${sim.totalStitches} 針 · 色 ${(frame?.colorIndex ?? 0) + 1}/${sim.threads.length}</span>
    </div>`;
}

// --- 全体描画 ---
function render(): void {
  const app = document.getElementById("app");
  if (!app) return;
  const tabs: [Tab, string][] =
    state.mode === "easy"
      ? [["design", "デザイン"], ["color", "色"], ["diagnostics", "診断"], ["output", "出力"]]
      : [
          ["design", "デザイン"],
          ["color", "色"],
          ["stitch", "ステッチ"],
          ["vector", "ベクター"],
          ["sequence", "縫い順"],
          ["fabric", "布地"],
          ["diagnostics", "診断"],
          ["output", "出力"],
        ];
  if (!tabs.some(([t]) => t === state.tab)) state.tab = "design";

  app.innerHTML = `
    <header>
      <h1>PP1 Stitch Studio <span class="version">v${__APP_VERSION__}</span></h1>
      <div class="chips">${headerChips()}</div>
      <div class="modes">
        <button class="mode ${state.mode === "easy" ? "active" : ""}" data-mode="easy">かんたん</button>
        <button class="mode ${state.mode === "pro" ? "active" : ""}" data-mode="pro">プロ</button>
      </div>
    </header>
    <div class="workspace">
      <main class="canvas-area">
        <canvas id="preview" width="620" height="620"></canvas>
        ${simulatorBar()}
      </main>
      <aside class="props">
        <nav class="tabs">${tabs.map(([t, label]) => `<button class="tab ${state.tab === t ? "active" : ""}" data-tab="${t}">${label}</button>`).join("")}</nav>
        <div class="tab-body">${tabContent()}</div>
      </aside>
    </div>
  `;

  const canvas = document.getElementById("preview") as HTMLCanvasElement;
  fitViewport(viewport, canvas);
  renderCanvas(canvas, viewport, state);
  if (state.vectorEdit) drawVectorEdit(canvas, viewport, state);
  if (state.tab === "sequence") {
    const list = document.getElementById("sequence-list");
    if (list) renderSequence(list, state, seqFilter);
  }
  bindEvents();
}

/** ベクター編集中だけ、キャンバスにノード操作用のポインタを取り付ける */
function syncVectorPointer(): void {
  detachVectorPointer?.();
  detachVectorPointer = null;
  if (!state.vectorEdit) return;
  const canvas = document.getElementById("preview") as HTMLCanvasElement | null;
  if (!canvas) return;
  detachVectorPointer = attachVectorPointer(canvas, viewport, state, () => {
    renderCanvas(canvas, viewport, state);
    drawVectorEdit(canvas, viewport, state);
  });
}

state.onChange = render;

function bindEvents(): void {
  // モード・タブ
  document.querySelectorAll<HTMLElement>(".mode").forEach((b) =>
    b.addEventListener("click", () => {
      state.mode = b.dataset.mode as AppState["mode"];
      render();
    }),
  );
  document.querySelectorAll<HTMLElement>(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab as Tab;
      render();
    }),
  );
  document.querySelectorAll<HTMLElement>(".vtab").forEach((b) =>
    b.addEventListener("click", () => {
      state.view = b.dataset.view as ViewMode;
      render();
    }),
  );

  // ファイル読み込み
  document.getElementById("file")?.addEventListener("change", (e) => {
    void (async (): Promise<void> => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (file.name.toLowerCase().endsWith(".svg")) {
        setSourceSvg(state, await file.text(), file.name);
      } else {
        const raster = await decodeImageFile(file);
        const dataUrl = await fileToDataUrl(file);
        setSourceImage(state, raster, dataUrl, file.name);
      }
      state.view = "stitch";
      render();
    })();
  });

  // サイズプリセット
  document.querySelectorAll<HTMLElement>(".preset").forEach((b) =>
    b.addEventListener("click", () => {
      state.project.settings.targetSizeMm = Number(b.dataset.size);
      recomputeRegions(state);
      render();
    }),
  );

  // 色
  document.getElementById("colors")?.addEventListener("change", (e) => {
    state.project.settings.colorCount = Number((e.target as HTMLInputElement).value);
    recomputeRegions(state);
    render();
  });
  document.getElementById("white")?.addEventListener("change", (e) => {
    state.project.settings.removeWhiteBackground = (e.target as HTMLInputElement).checked;
    recomputeRegions(state);
    render();
  });

  // ステッチ
  document.getElementById("angle")?.addEventListener("change", (e) => {
    state.project.settings.angleDeg = Number((e.target as HTMLSelectElement).value);
    recomputeStitches(state);
    render();
  });
  document.getElementById("trim")?.addEventListener("change", (e) => {
    state.project.settings.trimMode = (e.target as HTMLSelectElement).value as AppState["project"]["settings"]["trimMode"];
    recomputeStitches(state);
    render();
  });
  document.querySelectorAll<HTMLInputElement>(".underlay").forEach((cb) =>
    cb.addEventListener("change", () => {
      const selected = [...document.querySelectorAll<HTMLInputElement>(".underlay:checked")].map((c) => c.value);
      state.project.settings.underlay = selected;
      recomputeStitches(state);
      render();
    }),
  );

  // シーケンスフィルター
  document.querySelectorAll<HTMLElement>(".filter").forEach((b) =>
    b.addEventListener("click", () => {
      seqFilter = b.dataset.filter as SeqFilter;
      render();
    }),
  );

  // 診断: 自動修正
  document.querySelectorAll<HTMLElement>(".diag-fix").forEach((b) =>
    b.addEventListener("click", () => {
      applyAutoReduce(state);
      render();
    }),
  );

  // 出力
  document.getElementById("dl-pes")?.addEventListener("click", () => {
    if (state.plan) {
      download(`${designName()}.pes`, writePes(state.plan).data);
      state.project.exportHistory.push({ format: "PES", at: new Date().toISOString() });
    }
  });
  document.getElementById("dl-dst")?.addEventListener("click", () => {
    if (state.plan) {
      download(`${designName()}.dst`, writeDst(state.plan));
      state.project.exportHistory.push({ format: "DST", at: new Date().toISOString() });
    }
  });
  document.getElementById("save-proj")?.addEventListener("click", () => {
    download(`${designName()}.json`, serializeProject(state.project), "application/json");
  });
  document.getElementById("load-proj")?.addEventListener("click", () => {
    document.getElementById("proj-file")?.click();
  });
  document.getElementById("proj-file")?.addEventListener("change", (e) => {
    void (async (): Promise<void> => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        state.project = deserializeProject(await file.text());
        state.regions = state.project.regions;
        state.plan = state.project.plan;
        state.raster = null;
        if (state.plan) refreshDerived(state);
        else recomputeRegions(state);
        render();
      } catch (err) {
        alert(`読み込みに失敗しました: ${(err as Error).message}`);
      }
    })();
  });

  // シミュレーター
  bindSimulator();

  // ベクター編集
  bindVectorTab();

  // キャンバス: クリックでオブジェクト選択 (ステッチ表示時。編集中は無効)
  const canvas = document.getElementById("preview") as HTMLCanvasElement | null;
  canvas?.addEventListener("click", (ev) => {
    if (state.vectorEdit || state.view !== "stitch" || !state.plan) return;
    const rect = canvas.getBoundingClientRect();
    const p = screenToDesign(viewport, canvas, ev.clientX - rect.left, ev.clientY - rect.top);
    state.selectedObjectId = pickObject(p);
    render();
  });

  // ベクター編集中のノード操作ポインタを取り付け直す
  syncVectorPointer();
}

function bindVectorTab(): void {
  const ve = state.vectorEdit;
  document.getElementById("ve-enter")?.addEventListener("click", () => {
    enterVectorEdit(state);
    render();
  });
  if (!ve) return;

  document.getElementById("ve-shape")?.addEventListener("change", (e) => {
    ve.activeShape = Number((e.target as HTMLSelectElement).value);
    ve.activePath = "outer";
    ve.selectedNode = null;
    render();
  });
  document.getElementById("ve-path")?.addEventListener("change", (e) => {
    const val = (e.target as HTMLSelectElement).value;
    ve.activePath = val === "outer" ? "outer" : Number(val);
    ve.selectedNode = null;
    render();
  });
  document.querySelectorAll<HTMLElement>(".ve-tool").forEach((b) =>
    b.addEventListener("click", () => {
      ve.tool = b.dataset.tool as VectorTool;
      render();
    }),
  );
  document.getElementById("ve-snap")?.addEventListener("change", (e) => {
    ve.snapEnabled = (e.target as HTMLInputElement).checked;
  });
  document.getElementById("ve-toggle-type")?.addEventListener("click", () => {
    if (ve.selectedNode === null) return;
    const shape = ve.shapes[ve.activeShape];
    const path = ve.activePath === "outer" ? shape.outer : shape.holes[ve.activePath];
    const next: NodeType = path.nodes[ve.selectedNode].type === "corner" ? "smooth" : "corner";
    const newPath = setNodeType(path, ve.selectedNode, next);
    if (ve.activePath === "outer") shape.outer = newPath;
    else shape.holes[ve.activePath] = newPath;
    render();
  });
  document.getElementById("ve-all-smooth")?.addEventListener("click", () => {
    vectorSetAllType(state, "smooth");
    render();
  });
  document.getElementById("ve-all-corner")?.addEventListener("click", () => {
    vectorSetAllType(state, "corner");
    render();
  });
  document.getElementById("ve-apply")?.addEventListener("click", () => {
    applyVectorEdit(state);
    state.view = "stitch";
    render();
  });
  document.getElementById("ve-cancel")?.addEventListener("click", () => {
    cancelVectorEdit(state);
    render();
  });
}

function designName(): string {
  const base = state.project.source.fileName.replace(/\.[^.]+$/, "") || state.project.name;
  return (base || "design").slice(0, 16);
}

/** クリック位置に最も近いオブジェクトの始点/ステッチを探す */
function pickObject(p: { x: number; y: number }): number | null {
  if (!state.plan) return null;
  let best: number | null = null;
  let bestD = 60; // 6mm 以内
  for (const block of state.plan.blocks) {
    for (const run of block.runs) {
      if (run.objectId === undefined) continue;
      for (const s of run.stitches) {
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d < bestD) {
          bestD = d;
          best = run.objectId;
        }
      }
    }
  }
  return best;
}

function bindSimulator(): void {
  const stop = (): void => {
    if (simTimer !== null) {
      clearInterval(simTimer);
      simTimer = null;
    }
    state.simPlaying = false;
  };
  document.getElementById("sim-play")?.addEventListener("click", () => {
    if (!state.simulation) return;
    if (state.simPlaying) {
      stop();
      render();
      return;
    }
    state.simPlaying = true;
    if (state.simFrame >= state.simulation.frames.length) state.simFrame = 0;
    simTimer = window.setInterval(() => {
      if (!state.simulation) return;
      state.simFrame = Math.min(state.simFrame + Math.max(1, Math.floor(state.simulation.frames.length / 200)), state.simulation.frames.length);
      const canvas = document.getElementById("preview") as HTMLCanvasElement;
      renderCanvas(canvas, viewport, state);
      const slider = document.getElementById("sim-slider") as HTMLInputElement | null;
      if (slider) slider.value = String(state.simFrame);
      if (state.simFrame >= state.simulation.frames.length) {
        stop();
        render();
      }
    }, 30);
    render();
  });
  document.getElementById("sim-reset")?.addEventListener("click", () => {
    stop();
    state.simFrame = 0;
    render();
  });
  document.getElementById("sim-slider")?.addEventListener("input", (e) => {
    stop();
    state.simFrame = Number((e.target as HTMLInputElement).value);
    const canvas = document.getElementById("preview") as HTMLCanvasElement;
    renderCanvas(canvas, viewport, state);
    const info = document.querySelector(".sim-info");
    if (info && state.simulation) {
      const f = state.simulation.frames[Math.min(state.simFrame, state.simulation.frames.length) - 1];
      info.textContent = `${f ? f.stitchNumber : 0} / ${state.simulation.totalStitches} 針 · 色 ${(f?.colorIndex ?? 0) + 1}/${state.simulation.threads.length}`;
    }
  });
  document.getElementById("sim-nexttrim")?.addEventListener("click", () => {
    stop();
    if (!state.simulation) return;
    const next = state.simulation.trimFrames.find((f) => f > state.simFrame);
    state.simFrame = next ?? state.simulation.frames.length;
    render();
  });
  document.getElementById("sim-prevtrim")?.addEventListener("click", () => {
    stop();
    if (!state.simulation) return;
    const prev = [...state.simulation.trimFrames].reverse().find((f) => f < state.simFrame);
    state.simFrame = prev ?? 0;
    render();
  });
}

render();
