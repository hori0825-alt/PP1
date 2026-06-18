// PP1 Stitch Studio v3 — メイン UI。
// 左ツール / 中央キャンバス / 右プロパティ / 下シミュレーター・シーケンス。
// かんたんモード (ウィザード) とプロモード (全タブ) を切替。

import { HOOP_SIZE, UNIT_MM, mm } from "../core/constants";
import { angleDegFromVector, pointInPolygon, pointSegmentDistance, polygonCentroid } from "../core/geometry";
import { countStitches, countTrims, stitchedLengthByBlock } from "../core/plan";
import { deserializeProject, serializeProject } from "../core/project";
import { writeDst } from "../export/dst";
import { writePes } from "../export/pes";
import { setNodeType } from "../vector/path";
import type { NodeType } from "../vector/path";
import { BROTHER_PALETTE, nearestBrotherThread } from "../export/brotherPalette";
import {
  renderCanvas,
  createViewport,
  fitViewport,
  screenToDesign,
  designToScreen,
  directionHandleGeometry,
  DIR_HANDLE_RADIUS,
  pickBakedStitch,
  nearestBakedSegment,
} from "./canvas";
import type { Viewport } from "./canvas";
import { decodeImageFile } from "./loadImage";
import { renderSequence } from "./sequenceView";
import type { SeqFilter } from "./sequenceView";
import {
  applyApplique,
  applyAutoReduce,
  applyFabric,
  addRegionAngleLine,
  applyVectorEdit,
  bakeObject,
  cancelVectorEdit,
  addPenPoint,
  cancelPenDraw,
  clearRegionAngleLines,
  createState,
  deleteBakedStitch,
  enterStitchEdit,
  enterVectorEdit,
  exitStitchEdit,
  finishPenDraw,
  insertBakedStitch,
  liveApplyVectorEdit,
  moveBakedStitch,
  replaceRegions,
  restoreObjectsFromProject,
  setRegionColor,
  startPenDraw,
  stitchEditObject,
  unbakeObject,
  recomputePhoto,
  recomputeRegions,
  recomputeStitches,
  refreshDerived,
  restoreAllExcluded,
  restoreExcludedRegion,
  setPhotoMode,
  setRegionAngle,
  setRegionFill,
  setSourceImage,
  setSourceSvg,
  setTextRegions,
} from "./state";
import type { AppState, Tab, VectorTool, ViewMode } from "./state";
import { checkTextQuality } from "../text/metrics";
import { FABRIC_RECIPES, getRecipe } from "../fabric/recipes";
import { makeKaleidoscope, makeMirror, makeRadial } from "../decorate/arrange";
import { downloadPreview, downloadQr, openWorkOrder } from "./report";
import { bindLibraryTab, libraryTabContent } from "./library";
import { canRedo, canUndo, recordHistory, redo, resetHistory, undo } from "./history";
import { textToRegions } from "./textTool";
import type { LayoutMode } from "../text/layout";
import type { FillType } from "../stitch/digitize";
import type { SatinUnderlayMode } from "../core/types";
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
    case "text":
      return textTab();
    case "sequence":
      return `<div id="seq-controls">
        ${(["all", "trims", "warnings"] as SeqFilter[])
          .map((f) => `<button class="filter ${seqFilter === f ? "active" : ""}" data-filter="${f}">${f === "all" ? "すべて" : f === "trims" ? "糸切りのみ" : "警告のみ"}</button>`)
          .join("")}
      </div><div id="sequence-list"></div>`;
    case "fabric":
      return fabricTab();
    case "special":
      return specialTab();
    case "diagnostics":
      return diagnosticsTab();
    case "output":
      return outputTab();
    case "library":
      return libraryTab();
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
    ${state.project.source.kind === "image" ? photoSection() : ""}
    ${excludedPanel()}
  `;
}

function photoSection(): string {
  const p = state.photoSettings;
  return `
    <h2>写真刺繍 (PhotoStitch)</h2>
    <label><input type="checkbox" id="photo-mode" ${state.photoMode ? "checked" : ""}> 写真として明暗を刺繍化</label>
    ${state.photoMode ? `
      <label>色数 <input type="range" id="photo-colors" min="1" max="4" value="${p.colorCount}"><span>${p.colorCount}</span></label>
      <label>コントラスト <input type="range" id="photo-contrast" min="0.5" max="2.5" step="0.1" value="${p.contrast}"><span>${p.contrast.toFixed(1)}</span></label>
      <label>明るさ <input type="range" id="photo-bright" min="-0.4" max="0.4" step="0.05" value="${p.brightness}"><span>${p.brightness.toFixed(2)}</span></label>
      <label><input type="checkbox" id="photo-bg" ${p.removeBackground ? "checked" : ""}> 背景を除去</label>
      <p class="note">明暗をステッチ密度に変換します。針数が多い場合は自動で行間隔を広げます。</p>
    ` : ""}
  `;
}

function excludedPanel(): string {
  const n = state.excludedRegions.length;
  if (n === 0) return "";
  return `
    <div class="excluded-panel">
      <div class="excluded-title">除外された小領域: ${n} 個</div>
      <div class="excluded-list">
        ${state.excludedRegions
          .map(
            (ex, i) =>
              `<div class="excluded-item">
                <span class="swatch" style="background:rgb(${ex.color.r},${ex.color.g},${ex.color.b})"></span>
                <span class="excluded-area">${ex.areaMm2.toFixed(1)}mm²</span>
                <button class="excluded-restore" data-idx="${i}">復元</button>
              </div>`,
          )
          .join("")}
      </div>
      ${n > 1 ? '<button id="restore-all-excluded" class="secondary">すべて復元</button>' : ""}
      <p class="note">表示:ベクターでオレンジ破線の輪郭が見えます。復元すると刺繍パーツに含めます。</p>
    </div>`;
}

function colorTab(): string {
  const s = state.project.settings;
  const isImage = state.project.source.kind === "image";
  let table = "";
  if (state.plan) {
    const lengths = stitchedLengthByBlock(state.plan);
    const rows = state.plan.blocks
      .map((b, i) => {
        const stitches = b.runs.reduce((n, r) => n + r.stitches.length, 0);
        const meters = (lengths[i] * UNIT_MM) / 1000;
        return `<tr><td><span class="swatch" style="background:rgb(${b.thread.r},${b.thread.g},${b.thread.b})"></span></td>
          <td>${b.thread.name ?? `${b.thread.r},${b.thread.g},${b.thread.b}`}</td><td>${stitches}針</td><td>${meters.toFixed(2)}m</td></tr>`;
      })
      .join("");
    const totalM = (lengths.reduce((s2, v) => s2 + v, 0) * UNIT_MM) / 1000;
    table = `<table class="colors"><thead><tr><th>色</th><th>名称</th><th>針数</th><th>糸長</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="note">推定糸長 合計 約 ${totalM.toFixed(2)} m (縫い込み分の概算)</p>`;
  }
  return `
    <h2>色数削減</h2>
    ${isImage ? `<label>色数 <input type="range" id="colors" min="2" max="15" value="${s.colorCount}"><span>${s.colorCount}</span></label>
    <label><input type="checkbox" id="white" ${s.removeWhiteBackground ? "checked" : ""}> 白背景を除去</label>` : `<p class="note">SVG はベクター色をそのまま使用します。</p>`}
    <h2>使用色 (縫い順)</h2>
    ${table || '<p class="note">画像を読み込んでください。</p>'}
  `;
}

function fillTypeLabel(f: FillType): string {
  return f === "satin"
    ? "サテン縫い"
    : f === "tatami"
      ? "タタミ縫い"
      : f === "stroke"
        ? "線 (中心線)"
        : "自動 (細→サテン / 広→タタミ)";
}

function stitchEditPanel(): string {
  const obj = stitchEditObject(state);
  const total = obj?.baked?.reduce((n, r) => n + r.stitches.length, 0) ?? 0;
  const se = state.stitchEdit!;
  const tools: [typeof se.tool, string][] = [["move", "移動"], ["add", "追加"], ["delete", "削除"]];
  return `
    <h2>針の編集</h2>
    <div class="ve-tools">
      ${tools.map(([t, label]) => `<button class="se-tool ${se.tool === t ? "active" : ""}" data-setool="${t}">${label}</button>`).join("")}
    </div>
    <p class="note">
      ${se.tool === "move" ? "針をドラッグして動かします。" : se.tool === "add" ? "縫い目の線の上をクリックすると針を1つ足します。" : "針をクリックすると削除します。"}
    </p>
    <p class="note">このパーツの針数: ${total}${se.sel ? ` ／ 選択中: ${se.sel.idx + 1} 本目` : ""}</p>
    <button id="se-done">針の編集を終了</button>
    <p class="note">編集した針は固定 (マニュアル) され、自動再生成では変わりません。</p>
  `;
}

function stitchTab(): string {
  if (state.stitchEdit) return stitchEditPanel();
  const s = state.project.settings;
  const selIdx = state.selectedRegionIndex;
  const selRegion = selIdx !== null ? state.regions[selIdx] : null;

  const selObj = selIdx !== null ? state.objects[selIdx] : null;
  const isBaked = !!selObj?.baked;
  const colorThread = selRegion ? nearestBrotherThread(selRegion.color) : null;
  const threadGrid = colorThread
    ? BROTHER_PALETTE.map(
        (th) =>
          `<button class="thread-sw ${th.pecIndex === colorThread.pecIndex ? "active" : ""}" data-pec="${th.pecIndex}" title="${th.name}" style="background:rgb(${th.r},${th.g},${th.b})"></button>`,
      ).join("")
    : "";
  const turnCount = selRegion?.angleLines?.length ?? 0;
  const effAngle = selRegion ? (selRegion.angleDeg ?? s.angleDeg) : s.angleDeg;
  const angleOverridden = selRegion ? selRegion.angleDeg !== undefined : false;
  const selectedPanel = selRegion
    ? `<div class="region-panel">
        <div class="region-panel-title">
          <span class="swatch" style="background:rgb(${selRegion.color.r},${selRegion.color.g},${selRegion.color.b})"></span>
          パーツ ${selIdx! + 1} の設定${isBaked ? " 🔒" : ""}
        </div>
        <div class="region-color">
          <div class="note">糸色: ${colorThread?.name ?? ""}（縫うとこの色になります）</div>
          <div class="thread-grid">${threadGrid}</div>
        </div>
        ${isBaked ? `<p class="note">🔒 マニュアル固定中。針はそのまま保持され、下の縫い方・方向の変更は反映されません。固定を外すと自動生成に戻ります。</p>` : `
        <label>縫い方
          <select id="region-fill">
            <option value="" ${!selRegion.fillType ? "selected" : ""}>全体設定に従う (${fillTypeLabel(state.fillType)})</option>
            <option value="satin" ${selRegion.fillType === "satin" ? "selected" : ""}>サテン縫い (固定)</option>
            <option value="tatami" ${selRegion.fillType === "tatami" ? "selected" : ""}>タタミ縫い (固定)</option>
            <option value="stroke" ${selRegion.fillType === "stroke" ? "selected" : ""}>線 (中心線サテン/ランニング)</option>
            <option value="auto" ${selRegion.fillType === "auto" ? "selected" : ""}>自動 (固定)</option>
          </select>
        </label>
        <label>ステッチ方向 ${Math.round(effAngle)}°${angleOverridden ? "" : " <span class='note-inline'>(全体)</span>"}
          <input type="range" id="region-angle" min="0" max="175" step="5" value="${Math.round(effAngle)}">
        </label>
        <div class="ve-tools">
          ${[0, 45, 90, 135].map((a) => `<button class="region-angle-q" data-angle="${a}">${a}°</button>`).join("")}
          <button id="region-angle-clear" class="secondary">全体角度に戻す</button>
        </div>
        <div class="turning-box">
          <div class="region-panel-title">流れる方向 (ターニング) ${turnCount >= 2 ? "✓" : ""}</div>
          <div class="ve-tools">
            <button id="region-line-draw" class="${state.angleLineDraw ? "active" : ""}">${state.angleLineDraw ? "作図中… (ドラッグで線)" : "方向線を引く"}</button>
            <button id="region-line-clear" class="secondary">クリア</button>
          </div>
          <p class="note">方向線 ${turnCount} 本${turnCount >= 2 ? "（流れる向きが有効）" : "（2本以上で流れる向きになる）"}。葉・花弁などに。穴あき面は対象外。</p>
        </div>
        <button id="region-edit-outline">輪郭を編集 (形を直す)</button>
        <button id="region-edit-stitches">針を編集 (1針ずつ直す)</button>`}
        <label class="bake-toggle"><input type="checkbox" id="region-bake" ${isBaked ? "checked" : ""}> このパーツの針を固定 (マニュアル化)</label>
        <button id="region-deselect" class="secondary">選択解除</button>
        ${isBaked ? "" : `<p class="note">方向は面(タタミ)の縫い目向き。キャンバス(表示:ベクター)で青いつまみをドラッグしても向きを引けます。</p>`}
      </div>`
    : `<p class="note">「表示: ベクター」にしてパーツをクリックすると、縫い方と方向を個別に設定できます。</p>`;

  return `
    <h2>縫い方 (全体)</h2>
    <label>デフォルト縫い方
      <select id="global-fill">
        <option value="auto" ${state.fillType === "auto" ? "selected" : ""}>自動 (線→中心線 / 細→サテン / 広→タタミ)</option>
        <option value="satin" ${state.fillType === "satin" ? "selected" : ""}>すべてサテン縫い</option>
        <option value="tatami" ${state.fillType === "tatami" ? "selected" : ""}>すべてタタミ縫い</option>
      </select>
    </label>
    <div class="ve-tools">
      <button id="fill-all-satin">全パーツをサテンに</button>
      <button id="fill-all-tatami">全パーツをタタミに</button>
      <button id="fill-all-clear" class="secondary">個別設定をクリア</button>
    </div>
    <h2>パーツ個別設定</h2>
    ${selectedPanel}
    <h2>タタミ角度</h2>
    <label>角度
      <select id="angle">${[0, 45, 90, 135].map((v) => `<option value="${v}" ${v === s.angleDeg ? "selected" : ""}>${v}°</option>`).join("")}</select>
    </label>
    <h2>密度 (針数)</h2>
    <label>プリセット
      <select id="density">
        ${(
          [
            [0.9, "高密度 (しっかり / 針数増)"],
            [1.0, "標準"],
            [1.25, "省針数 (-20%目安)"],
            [1.5, "最省針数 (-33%目安)"],
          ] as [number, string][]
        )
          .map(
            ([v, label]) =>
              `<option value="${v}" ${Math.abs((s.densityScale ?? 1) - v) < 0.01 ? "selected" : ""}>${label}</option>`,
          )
          .join("")}
      </select>
    </label>
    <p class="note">フィルの行間隔・サテン間隔を調整します。粗くすると針数が減ります (線・細部は影響小)。</p>
    <label>目標針数 (自動調整)
      <select id="target-stitches">
        ${(
          [
            [0, "なし (上限なし)"],
            [8000, "8,000 針以内"],
            [6000, "6,000 針以内"],
            [4000, "4,000 針以内"],
          ] as [number, string][]
        )
          .map(
            ([v, label]) =>
              `<option value="${v}" ${(s.targetStitchCount ?? 0) === v ? "selected" : ""}>${label}</option>`,
          )
          .join("")}
      </select>
    </label>
    <p class="note">目標を超えたら密度を自動で粗くして収めます。結果は診断タブに表示されます。</p>
    <h2>下縫い</h2>
    ${(["edge", "tatami"] as const)
      .map((u) => `<label><input type="checkbox" class="underlay" value="${u}" ${s.underlay.includes(u) ? "checked" : ""}> ${u === "edge" ? "エッジ下縫い (面)" : "タタミ下縫い (面)"}</label>`)
      .join("")}
    <label>サテン列の下縫い
      <select id="satin-underlay">
        ${(
          [
            ["auto", "自動 (上の下縫い設定に従う)"],
            ["none", "なし"],
            ["center", "センター (中心線)"],
            ["center-zigzag", "センター + ジグザグ"],
          ] as [string, string][]
        )
          .map(([v, label]) => `<option value="${v}" ${(s.satinUnderlay ?? "auto") === v ? "selected" : ""}>${label}</option>`)
          .join("")}
      </select>
    </label>
    <p class="note">サテン列専用の土台。細い列はセンター、幅のある列はジグザグを足すと安定します (面の下縫いはエッジ/タタミが制御)。</p>
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

function textTab(): string {
  const t = state.textSettings;
  const fonts = ["sans-serif", "serif", "'Hiragino Sans'", "'Noto Sans JP'", "'Yu Gothic'", "monospace"];
  const warnings = checkTextQuality({ fontSize: mm(t.fontSizeMm) });
  const warnHtml = warnings
    .map((w) => `<p class="${w.level === "critical" ? "error" : "warning"}">${w.level === "critical" ? "✗" : "⚠"} ${w.message}</p>`)
    .join("");
  return `
    <h2>テキスト</h2>
    <textarea id="txt-input" rows="2" placeholder="文字を入力 (改行可)">${t.text}</textarea>
    <label>フォント
      <select id="txt-font">${fonts.map((f) => `<option value="${f}" ${f === t.fontFamily ? "selected" : ""}>${f.replace(/'/g, "")}</option>`).join("")}</select>
    </label>
    <label>文字高 ${t.fontSizeMm}mm
      <input type="range" id="txt-size" min="3" max="50" value="${t.fontSizeMm}">
    </label>
    <label>字間 ${t.letterSpacingMm}mm
      <input type="range" id="txt-spacing" min="-2" max="10" value="${t.letterSpacingMm}">
    </label>
    <label>配置
      <select id="txt-mode">
        <option value="horizontal" ${t.mode === "horizontal" ? "selected" : ""}>横書き</option>
        <option value="vertical" ${t.mode === "vertical" ? "selected" : ""}>縦書き</option>
        <option value="arc" ${t.mode === "arc" ? "selected" : ""}>円弧</option>
      </select>
    </label>
    ${t.mode === "arc" ? `<label>円弧半径 ${t.arcRadiusMm}mm<input type="range" id="txt-arc" min="15" max="50" value="${t.arcRadiusMm}"></label>` : ""}
    <label>縫い方
      <select id="txt-fill">
        <option value="auto" ${t.fillType === "auto" ? "selected" : ""}>自動 (細→サテン/太→タタミ)</option>
        <option value="satin" ${t.fillType === "satin" ? "selected" : ""}>サテン文字</option>
        <option value="tatami" ${t.fillType === "tatami" ? "selected" : ""}>タタミ文字</option>
      </select>
    </label>
    ${warnHtml ? `<div class="diag-item notice">${warnHtml}</div>` : ""}
    <button id="txt-apply">文字を刺繍化</button>
    <p class="note">ブラウザのフォントを使用します。穴あき文字 (A/O/8 等) も正しく縫えます。</p>
  `;
}

function fabricTab(): string {
  const id = state.project.settings.fabricId;
  const recipe = getRecipe(id);
  return `
    <h2>布地レシピ</h2>
    <label>布地
      <select id="fabric">${FABRIC_RECIPES.map((r) => `<option value="${r.id}" ${r.id === id ? "selected" : ""}>${r.name}</option>`).join("")}</select>
    </label>
    <table class="colors">
      <tbody>
        <tr><td>タタミ密度</td><td>${recipe.tatamiSpacingMm}mm 間隔</td></tr>
        <tr><td>ステッチ長</td><td>${recipe.stitchLengthMm}mm</td></tr>
        <tr><td>下縫い</td><td>${recipe.underlay.length ? recipe.underlay.join(" + ") : "なし"}</td></tr>
        <tr><td>Pull 補正</td><td>${recipe.pullCompMm}mm</td></tr>
        <tr><td>Push 補正</td><td>${recipe.pushCompMm}mm</td></tr>
        <tr><td>最小オブジェクト</td><td>${recipe.minObjectMm}mm</td></tr>
        <tr><td>糸切り閾値</td><td>${recipe.trimDistanceMm}mm</td></tr>
        <tr><td>自動密度</td><td>${recipe.autoDensity ? "ON" : "OFF"}</td></tr>
        <tr><td>推奨糸</td><td>${recipe.recommendedThread}</td></tr>
        <tr><td>推奨針</td><td>${recipe.recommendedNeedle}</td></tr>
      </tbody>
    </table>
    <p class="note">布地を選ぶと密度・補正・下縫いが推奨値になります。角度や糸切りはステッチタブで微調整できます。</p>
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
    <h2>作業指示書・画像</h2>
    <button id="dl-report" ${state.plan ? "" : "disabled"}>作業指示書を表示 (PDF 印刷)</button>
    <button id="dl-qr" class="secondary">QR コードを保存 (.svg)</button>
    <button id="dl-preview" class="secondary" ${state.plan ? "" : "disabled"}>プレビュー画像を保存 (.svg)</button>
    <p class="note">プロジェクト ID: ${state.project.id}</p>
    <h2>プロジェクト</h2>
    <button id="save-proj" class="secondary">プロジェクトを保存 (.json)</button>
    <button id="load-proj" class="secondary">プロジェクトを開く</button>
    <input type="file" id="proj-file" accept=".json" hidden />
  `;
}

function libraryTab(): string {
  return libraryTabContent();
}

function penPanel(): string {
  const pd = state.penDraw;
  if (pd) {
    const need = pd.kind === "fill" ? 3 : 2;
    const ready = pd.points.length >= need;
    return `
      <h2>手動デジタイズ (作図中)</h2>
      <p class="note">${pd.kind === "fill" ? "面" : "線"}を作図中 — キャンバスをクリックで点を追加。${pd.points.length} 点。</p>
      <div class="ve-tools">
        <button id="pen-finish" ${ready ? "" : "disabled"}>確定 (ダブルクリックでも可)</button>
        <button id="pen-cancel" class="secondary">取消</button>
      </div>
      <p class="note">${pd.kind === "fill" ? "3点以上で面になります。始点へ自動で閉じます。" : "2点以上で走り縫いになります。"}</p>`;
  }
  return `
    <h2>手動デジタイズ (ペン)</h2>
    <div class="ve-tools">
      <button id="pen-fill">面を描く (フィル)</button>
      <button id="pen-line">線を描く (走り縫い)</button>
    </div>
    <p class="note">キャンバスをクリックして点を置き、ダブルクリックで確定。描いた面はサテン/タタミ・方向・編集がそのまま使えます。線は走り縫い (針編集で微調整可)。</p>`;
}

function specialTab(): string {
  const hasRegions = state.regions.length > 0;
  return `
    ${penPanel()}
    <h2>装飾配置</h2>
    ${hasRegions ? `
      <div class="ve-tools">
        <button id="arr-mx">左右ミラー</button>
        <button id="arr-my">上下ミラー</button>
      </div>
      <label>放射コピー個数 <input type="number" id="arr-count" min="2" max="16" value="6" style="width:56px"></label>
      <div class="ve-tools">
        <button id="arr-radial">放射状に配置</button>
        <button id="arr-kaleido">万華鏡</button>
      </div>
      <p class="note">中心はデザイン中心。適用後はベクター編集や縫い順で調整できます。</p>
    ` : '<p class="note">画像・SVG・文字を読み込むと装飾配置できます。</p>'}
    <h2>アップリケ</h2>
    ${hasRegions ? `
      <label>仕上げサテン幅 <input type="range" id="ap-width" min="1.5" max="5" step="0.5" value="2.5"><span id="ap-width-v">2.5</span>mm</label>
      <button id="ap-apply">アップリケ工程を生成</button>
      <p class="note">配置線→仮止め→仕上げサテンの3工程を生成します。工程の境目で色替え (実機停止) します。</p>
    ` : ""}
    <h2>3D パフィー</h2>
    <label><input type="checkbox" id="puffy" ${state.puffy ? "checked" : ""}> パフィー (サテンを詰めて立体に)</label>
    <p class="note">スポンジ併用を想定し、サテンを高密度で生成します。小さい/細い文字は文字タブの警告を確認してください。</p>
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

/** plan に下縫い (stitchType="underlay") の Run が1つでもあるか */
function planHasUnderlay(): boolean {
  if (!state.plan) return false;
  for (const b of state.plan.blocks) {
    for (const r of b.runs) if (r.stitchType === "underlay" && r.stitches.length > 0) return true;
  }
  return false;
}

// --- ステッチビューの表示コントロール (下縫い強調) ---
function stitchViewBar(): string {
  // ステッチビューで、下縫いを含むデザインのときだけ表示する
  if (state.view !== "stitch" || !planHasUnderlay()) return "";
  return `
    <div class="stitchview-bar">
      <label class="ul-toggle"><input type="checkbox" id="hl-underlay" ${state.highlightUnderlay ? "checked" : ""}> 下縫いを強調表示</label>
      ${state.highlightUnderlay ? `<span class="ul-legend"><span class="ul-dot"></span>下縫い<span class="ul-dot top"></span>本縫い (淡色)</span>` : ""}
    </div>`;
}

// --- 全体描画 ---
function render(): void {
  const app = document.getElementById("app");
  if (!app) return;
  // 設計が変わっていれば履歴に記録する (表示切替・選択だけの再描画では増えない)
  recordHistory(state);
  const tabs: [Tab, string][] =
    state.mode === "easy"
      ? [["design", "デザイン"], ["color", "色"], ["diagnostics", "診断"], ["output", "出力"], ["library", "ライブラリ"]]
      : [
          ["design", "デザイン"],
          ["color", "色"],
          ["stitch", "ステッチ"],
          ["vector", "ベクター"],
          ["text", "文字"],
          ["sequence", "縫い順"],
          ["fabric", "布地"],
          ["special", "特殊"],
          ["diagnostics", "診断"],
          ["output", "出力"],
          ["library", "ライブラリ"],
        ];
  if (!tabs.some(([t]) => t === state.tab)) state.tab = "design";

  app.innerHTML = `
    <header>
      <h1>PP1 Stitch Studio <span class="version">v${__APP_VERSION__}</span></h1>
      <div class="history">
        <button class="hist" id="undo" ${canUndo() ? "" : "disabled"} title="元に戻す (Ctrl+Z)">↶ 戻る</button>
        <button class="hist" id="redo" ${canRedo() ? "" : "disabled"} title="やり直す (Ctrl+Shift+Z)">↷ やり直し</button>
      </div>
      <div class="chips">${headerChips()}</div>
      <div class="modes">
        <button class="mode ${state.mode === "easy" ? "active" : ""}" data-mode="easy">かんたん</button>
        <button class="mode ${state.mode === "pro" ? "active" : ""}" data-mode="pro">プロ</button>
      </div>
    </header>
    <div class="workspace">
      <main class="canvas-area">
        <canvas id="preview" width="620" height="620"></canvas>
        <div class="zoom-ctl">
          <button id="zoom-in" title="拡大">＋</button>
          <button id="zoom-out" title="縮小">－</button>
          <button id="zoom-fit" title="全体表示">⤢</button>
        </div>
        ${stitchViewBar()}
        ${simulatorBar()}
      </main>
      <aside class="props">
        <nav class="tabs">${tabs.map(([t, label]) => `<button class="tab ${state.tab === t ? "active" : ""}" data-tab="${t}">${label}</button>`).join("")}</nav>
        <div class="tab-body">${tabContent()}</div>
      </aside>
    </div>
  `;

  const canvas = document.getElementById("preview") as HTMLCanvasElement;
  // ズーム/パンを保持: 毎回 fitViewport で初期化すると拡大が戻るため、
  // 初回 (scale===0) のみ renderCanvas 内で自動フィットさせる。明示的なフィットは
  // 新規読み込み・サイズ変更・「全体表示」ボタンで viewport.scale=0 にして行う。
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
  // 戻る / やり直し (履歴)
  document.getElementById("undo")?.addEventListener("click", () => {
    if (undo(state)) render();
  });
  document.getElementById("redo")?.addEventListener("click", () => {
    if (redo(state)) render();
  });

  // 下縫いの強調表示トグル (ステッチビュー)
  document.getElementById("hl-underlay")?.addEventListener("change", (e) => {
    state.highlightUnderlay = (e.target as HTMLInputElement).checked;
    render();
  });

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
      resetHistory(); // 新しいデザイン: それ以前には戻せない
      viewport.scale = 0; // 新規読み込みは全体表示にフィット
      state.view = "stitch";
      render();
    })();
  });

  // サイズプリセット
  document.querySelectorAll<HTMLElement>(".preset").forEach((b) =>
    b.addEventListener("click", () => {
      state.project.settings.targetSizeMm = Number(b.dataset.size);
      if (state.photoMode) recomputePhoto(state);
      else recomputeRegions(state);
      viewport.scale = 0; // サイズ変更後は全体表示にフィット
      render();
    }),
  );

  // 写真刺繍 (PhotoStitch)
  document.getElementById("photo-mode")?.addEventListener("change", (e) => {
    setPhotoMode(state, (e.target as HTMLInputElement).checked);
    state.view = "stitch";
    render();
  });
  const photoRecompute = (): void => {
    recomputePhoto(state);
    render();
  };
  document.getElementById("photo-colors")?.addEventListener("change", (e) => {
    state.photoSettings.colorCount = Number((e.target as HTMLInputElement).value);
    photoRecompute();
  });
  document.getElementById("photo-contrast")?.addEventListener("change", (e) => {
    state.photoSettings.contrast = Number((e.target as HTMLInputElement).value);
    photoRecompute();
  });
  document.getElementById("photo-bright")?.addEventListener("change", (e) => {
    state.photoSettings.brightness = Number((e.target as HTMLInputElement).value);
    photoRecompute();
  });
  document.getElementById("photo-bg")?.addEventListener("change", (e) => {
    state.photoSettings.removeBackground = (e.target as HTMLInputElement).checked;
    photoRecompute();
  });

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
  document.getElementById("density")?.addEventListener("change", (e) => {
    state.project.settings.densityScale = Number((e.target as HTMLSelectElement).value);
    recomputeStitches(state);
    render();
  });
  document.getElementById("target-stitches")?.addEventListener("change", (e) => {
    const v = Number((e.target as HTMLSelectElement).value);
    state.project.settings.targetStitchCount = v > 0 ? v : undefined;
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
  // サテン列の下縫い種別
  document.getElementById("satin-underlay")?.addEventListener("change", (e) => {
    state.project.settings.satinUnderlay = (e.target as HTMLSelectElement).value as SatinUnderlayMode;
    recomputeStitches(state);
    render();
  });
  // 縫い方: 全体設定
  document.getElementById("global-fill")?.addEventListener("change", (e) => {
    state.fillType = (e.target as HTMLSelectElement).value as FillType;
    recomputeStitches(state);
    render();
  });
  // 縫い方: 全パーツに一括適用
  document.getElementById("fill-all-satin")?.addEventListener("click", () => {
    state.regions.forEach((r) => { r.fillType = "satin"; });
    recomputeStitches(state);
    render();
  });
  document.getElementById("fill-all-tatami")?.addEventListener("click", () => {
    state.regions.forEach((r) => { r.fillType = "tatami"; });
    recomputeStitches(state);
    render();
  });
  document.getElementById("fill-all-clear")?.addEventListener("click", () => {
    state.regions.forEach((r) => { delete r.fillType; });
    recomputeStitches(state);
    render();
  });
  // 糸色: パレットのスウォッチで選択パーツの色を変更
  document.querySelectorAll<HTMLElement>(".thread-sw").forEach((b) =>
    b.addEventListener("click", () => {
      const idx = state.selectedRegionIndex;
      if (idx === null) return;
      const pec = Number(b.dataset.pec);
      const th = BROTHER_PALETTE.find((t) => t.pecIndex === pec);
      if (th) setRegionColor(state, idx, { r: th.r, g: th.g, b: th.b, name: th.name, code: th.code });
      render();
    }),
  );
  // 縫い方: 選択中パーツの個別設定
  document.getElementById("region-fill")?.addEventListener("change", (e) => {
    const idx = state.selectedRegionIndex;
    if (idx === null) return;
    const val = (e.target as HTMLSelectElement).value;
    setRegionFill(state, idx, val === "" ? null : (val as FillType));
    render();
  });
  // 方向: スライダー / クイックボタン / クリア
  document.getElementById("region-angle")?.addEventListener("input", (e) => {
    const idx = state.selectedRegionIndex;
    if (idx === null) return;
    setRegionAngle(state, idx, Number((e.target as HTMLInputElement).value));
    render();
  });
  document.querySelectorAll<HTMLElement>(".region-angle-q").forEach((b) =>
    b.addEventListener("click", () => {
      const idx = state.selectedRegionIndex;
      if (idx === null) return;
      setRegionAngle(state, idx, Number(b.dataset.angle));
      render();
    }),
  );
  document.getElementById("region-angle-clear")?.addEventListener("click", () => {
    const idx = state.selectedRegionIndex;
    if (idx === null) return;
    setRegionAngle(state, idx, null);
    render();
  });
  // マニュアル固定 (ベイク) の切替: 選択パーツの針を固定/解除する
  document.getElementById("region-bake")?.addEventListener("change", (e) => {
    const idx = state.selectedRegionIndex;
    if (idx === null) return;
    const obj = state.objects[idx];
    if (!obj) return;
    if ((e.target as HTMLInputElement).checked) bakeObject(state, obj.id);
    else unbakeObject(state, obj.id);
    render();
  });
  // 輪郭を編集: 選択パーツに絞ってベクター編集を開始 (ドラッグでライブ再生成)
  document.getElementById("region-edit-outline")?.addEventListener("click", () => {
    const idx = state.selectedRegionIndex;
    if (idx === null) return;
    state.angleLineDraw = false;
    state.stitchEdit = null;
    state.view = "stitch"; // 縫い目の変化を見ながらノードを動かせる
    state.tab = "vector";
    enterVectorEdit(state, idx);
    render();
  });
  // 針を編集: 選択パーツをベイクして針編集モードへ
  document.getElementById("region-edit-stitches")?.addEventListener("click", () => {
    const idx = state.selectedRegionIndex;
    if (idx === null) return;
    state.angleLineDraw = false;
    state.vectorEdit = null;
    state.view = "stitch";
    if (enterStitchEdit(state, idx)) state.tab = "stitch";
    render();
  });
  // 針編集: ツール切替 / 終了
  document.querySelectorAll<HTMLElement>(".se-tool").forEach((b) =>
    b.addEventListener("click", () => {
      if (state.stitchEdit) state.stitchEdit.tool = b.dataset.setool as "move" | "add" | "delete";
      render();
    }),
  );
  document.getElementById("se-done")?.addEventListener("click", () => {
    exitStitchEdit(state);
    render();
  });
  // ターニング: 方向線の作図モード切替 / クリア
  document.getElementById("region-line-draw")?.addEventListener("click", () => {
    state.angleLineDraw = !state.angleLineDraw;
    if (state.angleLineDraw) state.view = "vector"; // 作図はベクタービューで
    render();
  });
  document.getElementById("region-line-clear")?.addEventListener("click", () => {
    const idx = state.selectedRegionIndex;
    if (idx === null) return;
    clearRegionAngleLines(state, idx);
    render();
  });
  document.getElementById("region-deselect")?.addEventListener("click", () => {
    state.selectedRegionIndex = null;
    state.angleLineDraw = false;
    render();
  });

  // 除外領域の復元
  document.querySelectorAll<HTMLElement>(".excluded-restore").forEach((b) =>
    b.addEventListener("click", () => {
      restoreExcludedRegion(state, Number(b.dataset.idx));
      render();
    }),
  );
  document.getElementById("restore-all-excluded")?.addEventListener("click", () => {
    restoreAllExcluded(state);
    render();
  });

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
  document.getElementById("dl-report")?.addEventListener("click", () => {
    if (!state.plan) return;
    openWorkOrder({
      plan: state.plan,
      projectId: state.project.id,
      designName: state.project.name,
      fileName: state.project.source.fileName || designName(),
      createdAt: state.project.createdAt,
      fabricId: state.project.settings.fabricId,
    });
    state.project.exportHistory.push({ format: "PDF", at: new Date().toISOString() });
  });
  document.getElementById("dl-qr")?.addEventListener("click", () => {
    downloadQr(state.project.id);
  });
  document.getElementById("dl-preview")?.addEventListener("click", () => {
    if (state.plan) downloadPreview(state.plan, designName());
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
        restoreObjectsFromProject(state); // 固定針・手動オブジェクト・id を復元
        state.plan = state.project.plan;
        state.raster = null;
        if (state.plan) refreshDerived(state);
        else if (state.regions.length > 0) recomputeStitches(state);
        else recomputeRegions(state);
        resetHistory(); // 開いたプロジェクトより前には戻せない
        viewport.scale = 0; // 全体表示にフィット
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

  // 文字
  bindTextTab();

  // ライブラリ
  if (state.tab === "library") bindLibraryTab(state, render);

  // 布地レシピ
  document.getElementById("fabric")?.addEventListener("change", (e) => {
    applyFabric(state, (e.target as HTMLSelectElement).value);
    render();
  });

  // 特殊 (装飾配置・アップリケ・パフィー)
  bindSpecialTab();

  // キャンバス: クリックで選択 / ベクタービューでは方向つまみをドラッグして向きを引く
  const canvas = document.getElementById("preview") as HTMLCanvasElement | null;
  if (canvas) {
    bindCanvasPointer(canvas);
    bindCanvasNav(canvas); // ホイールズーム + 中/右ドラッグパン
  }

  // ズームコントロール (＋ / － / 全体表示)
  document.getElementById("zoom-in")?.addEventListener("click", () => {
    if (canvas) {
      zoomViewport(canvas, 1.3, canvas.width / 2, canvas.height / 2);
      redrawCanvas(canvas);
    }
  });
  document.getElementById("zoom-out")?.addEventListener("click", () => {
    if (canvas) {
      zoomViewport(canvas, 1 / 1.3, canvas.width / 2, canvas.height / 2);
      redrawCanvas(canvas);
    }
  });
  document.getElementById("zoom-fit")?.addEventListener("click", () => {
    if (canvas) {
      fitViewport(viewport, canvas);
      redrawCanvas(canvas);
    }
  });

  // ベクター編集中のノード操作ポインタを取り付け直す
  syncVectorPointer();
}

/** カーソルが選択パーツの方向つまみの上にあるか (画面距離で判定) */
function overDirectionKnob(canvas: HTMLCanvasElement, sx: number, sy: number): boolean {
  const geo = directionHandleGeometry(state);
  if (!geo) return false;
  const [kx, ky] = designToScreen(viewport, canvas, geo.knob.x, geo.knob.y);
  return Math.hypot(sx - kx, sy - ky) <= DIR_HANDLE_RADIUS + 4;
}

/**
 * キャンバスのポインタ操作: 選択 / 方向つまみのドラッグ。
 * ポインタキャプチャを使い、リスナーは canvas 要素に限定する
 * (canvas は再描画ごとに作り直されるためリークしない)。
 */
/** ポインタ位置をキャンバスのバッファ座標へ変換する (CSS 表示サイズと描画解像度の差を補正)。
 *  これにより、キャンバスが縮小表示されていても選択・ズームの当たり判定が正確になる。 */
function pointerToCanvas(canvas: HTMLCanvasElement, clientX: number, clientY: number): { sx: number; sy: number } {
  const rect = canvas.getBoundingClientRect();
  const fx = rect.width > 0 ? canvas.width / rect.width : 1;
  const fy = rect.height > 0 ? canvas.height / rect.height : 1;
  return { sx: (clientX - rect.left) * fx, sy: (clientY - rect.top) * fy };
}

/** カーソル位置 (バッファ座標) を固定したままスケールを factor 倍する (枠フィット〜60倍に制限) */
function zoomViewport(canvas: HTMLCanvasElement, factor: number, sx: number, sy: number): void {
  const fit = canvas.width / (HOOP_SIZE * 1.12);
  const next = Math.max(fit * 0.5, Math.min(fit * 60, viewport.scale * factor));
  const d = screenToDesign(viewport, canvas, sx, sy);
  viewport.scale = next;
  viewport.panX = sx - canvas.width / 2 - d.x * next;
  viewport.panY = sy - canvas.height / 2 - d.y * next;
}

/** キャンバスを再描画する (ベクター編集オーバーレイも維持) */
function redrawCanvas(canvas: HTMLCanvasElement): void {
  renderCanvas(canvas, viewport, state);
  if (state.vectorEdit) drawVectorEdit(canvas, viewport, state);
}

/** ホイールでズーム (カーソル中心)、中/右ドラッグでパン。左ボタンは選択・編集用に空ける。 */
function bindCanvasNav(canvas: HTMLCanvasElement): void {
  canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const { sx, sy } = pointerToCanvas(canvas, ev.clientX, ev.clientY);
      zoomViewport(canvas, ev.deltaY < 0 ? 1.15 : 1 / 1.15, sx, sy);
      redrawCanvas(canvas);
    },
    { passive: false },
  );
  let panning = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 1 && ev.button !== 2) return; // 中/右ボタンのみパン
    panning = true;
    const p = pointerToCanvas(canvas, ev.clientX, ev.clientY);
    lastX = p.sx;
    lastY = p.sy;
    canvas.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!panning) return;
    const p = pointerToCanvas(canvas, ev.clientX, ev.clientY);
    viewport.panX += p.sx - lastX;
    viewport.panY += p.sy - lastY;
    lastX = p.sx;
    lastY = p.sy;
    redrawCanvas(canvas);
  });
  const endPan = (ev: PointerEvent): void => {
    if (!panning) return;
    panning = false;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
  };
  canvas.addEventListener("pointerup", endPan);
  canvas.addEventListener("pointercancel", endPan);
  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault()); // 右ドラッグパン中のメニュー抑止
}

function bindCanvasPointer(canvas: HTMLCanvasElement): void {
  let draggingAngle = false;
  let drawingLine = false;
  let lineStart: { x: number; y: number } | null = null;
  let lineEnd: { x: number; y: number } | null = null;
  let didDrag = false;
  let draggingStitch: { run: number; idx: number } | null = null;

  const localXY = (ev: PointerEvent): { sx: number; sy: number } =>
    pointerToCanvas(canvas, ev.clientX, ev.clientY);

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return; // 左ボタンのみ選択・編集 (中/右はパン)
    if (state.penDraw) return; // ペン作図はクリックで点を置く (ドラッグ操作を抑止)
    // --- 針編集モード (フェーズ7) ---
    if (state.stitchEdit && state.view === "stitch") {
      const { sx, sy } = localXY(ev);
      const se = state.stitchEdit;
      if (se.tool === "move") {
        const hit = pickBakedStitch(viewport, canvas, state, sx, sy);
        se.sel = hit;
        if (hit) {
          draggingStitch = hit;
          canvas.setPointerCapture(ev.pointerId);
          ev.preventDefault();
        }
        render();
      } else if (se.tool === "delete") {
        const hit = pickBakedStitch(viewport, canvas, state, sx, sy);
        if (hit) {
          deleteBakedStitch(state, hit.run, hit.idx);
          se.sel = null;
          render();
        }
      } else if (se.tool === "add") {
        const p = screenToDesign(viewport, canvas, sx, sy);
        const seg = nearestBakedSegment(state, p);
        if (seg) {
          insertBakedStitch(state, seg.run, seg.afterIdx, p);
          se.sel = { run: seg.run, idx: seg.afterIdx + 1 };
          render();
        }
      }
      return;
    }
    if (state.vectorEdit || state.view !== "vector" || state.selectedRegionIndex === null) return;
    const { sx, sy } = localXY(ev);
    if (state.angleLineDraw) {
      // 方向線の作図: ドラッグの始点を記録
      drawingLine = true;
      didDrag = false;
      lineStart = screenToDesign(viewport, canvas, sx, sy);
      lineEnd = lineStart;
      canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    } else if (overDirectionKnob(canvas, sx, sy)) {
      draggingAngle = true;
      didDrag = false;
      canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }
  });

  canvas.addEventListener("pointermove", (ev) => {
    const { sx, sy } = localXY(ev);
    if (draggingStitch && state.stitchEdit) {
      const p = screenToDesign(viewport, canvas, sx, sy);
      moveBakedStitch(state, draggingStitch.run, draggingStitch.idx, p, { skipDerived: true });
      renderCanvas(canvas, viewport, state);
      return;
    }
    if (drawingLine) {
      lineEnd = screenToDesign(viewport, canvas, sx, sy);
      didDrag = true;
      // プレビュー線を重ねて描く
      renderCanvas(canvas, viewport, state);
      if (lineStart && lineEnd) drawPreviewLine(canvas, lineStart, lineEnd);
      return;
    }
    if (!draggingAngle || state.selectedRegionIndex === null) return;
    const idx = state.selectedRegionIndex;
    const region = state.regions[idx];
    if (!region) return;
    const p = screenToDesign(viewport, canvas, sx, sy);
    const c = polygonCentroid(region.outer);
    // ドラッグ中は差分再生成 + 診断スキップで軽量に縫い直し、キャンバスだけ更新
    setRegionAngle(state, idx, angleDegFromVector(p.x - c.x, p.y - c.y), { skipDerived: true });
    didDrag = true;
    renderCanvas(canvas, viewport, state);
  });

  const endDrag = (ev: PointerEvent): void => {
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    if (draggingStitch && state.stitchEdit) {
      const { sx, sy } = localXY(ev);
      const p = screenToDesign(viewport, canvas, sx, sy);
      moveBakedStitch(state, draggingStitch.run, draggingStitch.idx, p); // 確定 (診断も更新)
      draggingStitch = null;
      render();
      return;
    }
    if (drawingLine) {
      drawingLine = false;
      const idx = state.selectedRegionIndex;
      // 一定以上の長さがあれば方向線として確定
      if (idx !== null && lineStart && lineEnd && Math.hypot(lineEnd.x - lineStart.x, lineEnd.y - lineStart.y) > mm(2)) {
        addRegionAngleLine(state, idx, { a: lineStart, b: lineEnd });
      }
      lineStart = null;
      lineEnd = null;
      render();
      return;
    }
    if (draggingAngle) {
      draggingAngle = false;
      // ドラッグ終了時に診断・シーケンス等を最新化し、パネルの角度表示も更新
      recomputeStitches(state);
      render();
    }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // ペン作図: ダブルクリックで確定
  canvas.addEventListener("dblclick", () => {
    if (state.penDraw) {
      finishPenDraw(state);
      render();
    }
  });

  canvas.addEventListener("click", (ev) => {
    const { sx, sy } = pointerToCanvas(canvas, ev.clientX, ev.clientY);
    const p = screenToDesign(viewport, canvas, sx, sy);
    if (state.penDraw) {
      // 手動デジタイズ: クリックで点を追加
      addPenPoint(state, p);
      render();
      return;
    }
    if (state.vectorEdit || state.stitchEdit) return; // 針編集中は選択を無効化
    if (didDrag) {
      didDrag = false;
      return; // ドラッグ (方向つまみ/方向線) の直後はクリック選択を抑制
    }
    if (state.view === "vector") {
      state.selectedRegionIndex = pickRegion(p);
      if (state.selectedRegionIndex !== null) state.tab = "stitch";
    } else if (state.view === "stitch" && state.plan) {
      state.selectedObjectId = pickObject(p);
    }
    render();
  });
}

/** 方向線の作図プレビューをキャンバスに重ねて描く */
function drawPreviewLine(canvas: HTMLCanvasElement, a: { x: number; y: number }, b: { x: number; y: number }): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const [ax, ay] = designToScreen(viewport, canvas, a.x, a.y);
  const [bx, by] = designToScreen(viewport, canvas, b.x, b.y);
  ctx.strokeStyle = "#13a35b";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
}

function bindTextTab(): void {
  const t = state.textSettings;
  const reSize = (): void => render(); // ラベル更新のため再描画
  document.getElementById("txt-input")?.addEventListener("input", (e) => {
    t.text = (e.target as HTMLTextAreaElement).value;
  });
  document.getElementById("txt-font")?.addEventListener("change", (e) => {
    t.fontFamily = (e.target as HTMLSelectElement).value;
  });
  document.getElementById("txt-size")?.addEventListener("input", (e) => {
    t.fontSizeMm = Number((e.target as HTMLInputElement).value);
    reSize();
  });
  document.getElementById("txt-spacing")?.addEventListener("input", (e) => {
    t.letterSpacingMm = Number((e.target as HTMLInputElement).value);
    reSize();
  });
  document.getElementById("txt-mode")?.addEventListener("change", (e) => {
    t.mode = (e.target as HTMLSelectElement).value as LayoutMode;
    render();
  });
  document.getElementById("txt-arc")?.addEventListener("input", (e) => {
    t.arcRadiusMm = Number((e.target as HTMLInputElement).value);
    reSize();
  });
  document.getElementById("txt-fill")?.addEventListener("change", (e) => {
    t.fillType = (e.target as HTMLSelectElement).value as FillType;
  });
  document.getElementById("txt-apply")?.addEventListener("click", () => {
    if (t.text.trim() === "") {
      alert("文字を入力してください");
      return;
    }
    const regions = textToRegions({
      text: t.text,
      fontFamily: t.fontFamily,
      fontSizeMm: t.fontSizeMm,
      letterSpacingMm: t.letterSpacingMm,
      mode: t.mode,
      color: { r: 0, g: 0, b: 0, name: "Black" },
      arcRadiusMm: t.arcRadiusMm,
    });
    if (regions.length === 0) {
      alert("文字を刺繍化できませんでした (フォントを変えてお試しください)");
      return;
    }
    setTextRegions(state, regions, t.fillType);
    state.view = "stitch";
    render();
  });
}

function bindSpecialTab(): void {
  const count = (): number => {
    const el = document.getElementById("arr-count") as HTMLInputElement | null;
    return el ? Math.max(2, Math.min(16, Number(el.value))) : 6;
  };
  // 手動デジタイズ (ペン)
  document.getElementById("pen-fill")?.addEventListener("click", () => {
    startPenDraw(state, "fill");
    state.view = "vector";
    render();
  });
  document.getElementById("pen-line")?.addEventListener("click", () => {
    startPenDraw(state, "line");
    state.view = "vector";
    render();
  });
  document.getElementById("pen-finish")?.addEventListener("click", () => {
    finishPenDraw(state);
    state.view = "stitch";
    render();
  });
  document.getElementById("pen-cancel")?.addEventListener("click", () => {
    cancelPenDraw(state);
    render();
  });
  document.getElementById("arr-mx")?.addEventListener("click", () => {
    replaceRegions(state, makeMirror(state.regions, "x", 0));
    state.view = "stitch";
    render();
  });
  document.getElementById("arr-my")?.addEventListener("click", () => {
    replaceRegions(state, makeMirror(state.regions, "y", 0));
    state.view = "stitch";
    render();
  });
  document.getElementById("arr-radial")?.addEventListener("click", () => {
    replaceRegions(state, makeRadial(state.regions, { count: count() }));
    state.view = "stitch";
    render();
  });
  document.getElementById("arr-kaleido")?.addEventListener("click", () => {
    replaceRegions(state, makeKaleidoscope(state.regions, { segments: count() }));
    state.view = "stitch";
    render();
  });
  document.getElementById("ap-width")?.addEventListener("input", (e) => {
    const v = document.getElementById("ap-width-v");
    if (v) v.textContent = (e.target as HTMLInputElement).value;
  });
  document.getElementById("ap-apply")?.addEventListener("click", () => {
    const w = Number((document.getElementById("ap-width") as HTMLInputElement)?.value ?? 2.5);
    applyApplique(state, w);
    state.view = "stitch";
    render();
  });
  document.getElementById("puffy")?.addEventListener("change", (e) => {
    state.puffy = (e.target as HTMLInputElement).checked;
    recomputeStitches(state);
    render();
  });
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
    liveApplyVectorEdit(state);
    render();
  });
  document.getElementById("ve-all-smooth")?.addEventListener("click", () => {
    vectorSetAllType(state, "smooth");
    liveApplyVectorEdit(state);
    render();
  });
  document.getElementById("ve-all-corner")?.addEventListener("click", () => {
    vectorSetAllType(state, "corner");
    liveApplyVectorEdit(state);
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

/** クリック位置の領域インデックスを返す (ベクタービュー用) */
function pickRegion(p: { x: number; y: number }): number | null {
  for (let i = state.regions.length - 1; i >= 0; i--) {
    const r = state.regions[i];
    if (pointInPolygon(p, r.outer)) {
      const inHole = r.holes.some((h) => pointInPolygon(p, h));
      if (!inHole) return i;
    }
  }
  // 面に当たらなければ、輪郭線の近く (手動の線オブジェクト等) を拾う
  let best: number | null = null;
  let bestD = mm(2);
  for (let i = state.regions.length - 1; i >= 0; i--) {
    const outer = state.regions[i].outer;
    for (let j = 0; j + 1 < outer.length; j++) {
      const d = pointSegmentDistance(p, outer[j], outer[j + 1]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  return best;
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

// キーボードショートカット: Ctrl/Cmd+Z で戻る、Ctrl/Cmd+Shift+Z または Ctrl/Cmd+Y でやり直し。
// 入力欄 (テキスト/数値) のフォーカス中はブラウザ既定の取り消しを優先して邪魔しない。
window.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === "z" && !e.shiftKey) {
    if (undo(state)) {
      e.preventDefault();
      render();
    }
  } else if ((key === "z" && e.shiftKey) || key === "y") {
    if (redo(state)) {
      e.preventDefault();
      render();
    }
  }
});

render();
