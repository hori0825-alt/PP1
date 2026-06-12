// PP1 Stitch Studio v2 — オブジェクトベースの刺繍デジタイザ UI。
// 画像 → 刺繍オブジェクト (objectizer) → 縫い計画 (planner) → 診断 → PES/DST

import "./app.css";
import { DEFAULT_GLOBAL, type EmbObject, type GlobalSettings } from "./core/object";
import { objectize, type ObjectizeResult } from "./core/objectizer";
import { compileWithLimit, type Plan } from "./core/planner";
import { diagnose, worstLevel, type DiagItem } from "./core/diagnostics";
import { serializeProject, deserializeObjects, newProjectId, type ProjectJson } from "./core/project";
import { COLOR_CHANGE, JUMP, STITCH, TRIM } from "./embroidery/pattern";
import { writePes } from "./embroidery/pes";
import { writeDst } from "./embroidery/dst";

declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
const HOOP_MM = 100;
const PROCESS_MAX_PX = 1000;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
$("version").textContent = `v${APP_VERSION}`;

// ------------------------------------------------------------------ 状態
let g: GlobalSettings = { ...DEFAULT_GLOBAL, maxStitches: 12000 };
let sourceImage: ImageData | null = null;
let imageDataUrl: string | null = null;
let imageBitmap: HTMLCanvasElement | null = null;
let designName = "PP1";
let projectId = newProjectId();
let oz: ObjectizeResult | null = null;
let order: string[] = [];
let plan: Plan | null = null;
let adjustedG: GlobalSettings | null = null;
let overLimit = false;
let diag: DiagItem[] = [];
let selectedId: string | null = null;
// プレイヤー
let playerPos = 0; // pattern.stitches のコマンド位置
let playing = false;
let stitchPrefix: Int32Array = new Int32Array(0);

const canvas = $<HTMLCanvasElement>("canvas");
const ctx2d = canvas.getContext("2d")!;

// ------------------------------------------------------------------ 入力
function readSettings(): void {
  const num = (id: string, lo: number, hi: number, dflt: number) =>
    Math.min(hi, Math.max(lo, Number($<HTMLInputElement>(id).value) || dflt));
  g = {
    ...g,
    sizeMm: num("sizeMm", 10, 100, 90),
    maxColors: num("maxColors", 2, 15, 6),
    colorMergeLevel: Number($<HTMLSelectElement>("colorMerge").value) || 2,
    autoBackground: $<HTMLInputElement>("autoBg").checked,
    rowSpacingMm: num("rowSpacing", 0.25, 1.2, 0.4),
    satinSpacingMm: num("satinSpacing", 0.15, 0.6, 0.3),
    stitchLenMm: num("stitchLen", 1.5, 6, 3),
    angleDeg: num("angleDeg", 0, 180, 45),
    outline: $<HTMLInputElement>("outlineOn").checked,
    autoThinDetect: $<HTMLInputElement>("autoThin").checked,
    trimMode: ($<HTMLSelectElement>("trimMode").value as GlobalSettings["trimMode"]) || "auto",
    trimDistanceMm: num("trimDistance", 3, 100, 50),
    maxStitches: num("maxStitches", 0, 30000, 12000),
  };
}

// 画像/色に関わる設定 → 再オブジェクト化。それ以外 → 再コンパイルのみ
const REOBJECTIZE_IDS = ["sizeMm", "maxColors", "colorMerge", "autoBg", "autoThin"];
for (const id of [
  "sizeMm", "maxColors", "colorMerge", "autoBg",
  "rowSpacing", "satinSpacing", "stitchLen", "angleDeg", "outlineOn", "autoThin",
  "trimMode", "trimDistance", "maxStitches",
]) {
  $(id).addEventListener("change", () => {
    readSettings();
    if (REOBJECTIZE_IDS.includes(id)) reobjectize();
    else recompile();
  });
}

$("sizePresets").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button[data-mm]") as HTMLButtonElement | null;
  if (!btn) return;
  $<HTMLInputElement>("sizeMm").value = btn.dataset.mm!;
  for (const b of $("sizePresets").querySelectorAll("button")) b.classList.remove("active");
  btn.classList.add("active");
  readSettings();
  reobjectize();
});

// モード切替
$("modeEasy").addEventListener("click", () => setMode(true));
$("modePro").addEventListener("click", () => setMode(false));
function setMode(easy: boolean): void {
  document.body.classList.toggle("mode-easy", easy);
  $("modeEasy").classList.toggle("active", easy);
  $("modePro").classList.toggle("active", !easy);
}

// ------------------------------------------------------------------ 画像読み込み
function loadImageFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    imageDataUrl = String(reader.result);
    const img = new Image();
    img.onload = () => {
      setSourceImage(img);
      designName =
        file.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "PP1";
      projectId = newProjectId();
      reobjectize();
    };
    img.src = imageDataUrl;
  };
  reader.readAsDataURL(file);
}

function setSourceImage(img: CanvasImageSource & { width: number; height: number }): void {
  const sc = Math.min(1, PROCESS_MAX_PX / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * sc));
  const h = Math.max(1, Math.round(img.height * sc));
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const c = off.getContext("2d", { willReadFrequently: true })!;
  c.drawImage(img, 0, 0, w, h);
  sourceImage = c.getImageData(0, 0, w, h);
  imageBitmap = off;
  $("emptyHint").hidden = true;
}

const dropzone = $("dropzone");
const fileInput = $<HTMLInputElement>("fileInput");
dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files?.[0]) loadImageFile(fileInput.files[0]);
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer?.files?.[0]) loadImageFile(e.dataTransfer.files[0]);
});

$("sampleBtn").addEventListener("click", () => {
  const off = document.createElement("canvas");
  off.width = 420;
  off.height = 420;
  const c = off.getContext("2d")!;
  c.fillStyle = "#2f7ec2";
  c.beginPath();
  c.arc(210, 210, 175, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#f7c948";
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 135 : 58;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    c[i === 0 ? "moveTo" : "lineTo"](210 + r * Math.cos(a), 210 + r * Math.sin(a));
  }
  c.closePath();
  c.fill();
  c.strokeStyle = "#23303c";
  c.lineWidth = 7;
  c.beginPath();
  c.arc(210, 210, 175, 0, Math.PI * 2);
  c.stroke();
  imageDataUrl = off.toDataURL("image/png");
  setSourceImage(off);
  designName = "SAMPLE";
  projectId = newProjectId();
  reobjectize();
});

// ------------------------------------------------------------------ 変換
function reobjectize(): void {
  if (!sourceImage) return;
  oz = objectize(sourceImage, g);
  order = oz.order;
  selectedId = null;
  recompile();
}

function recompile(): void {
  if (!oz) return;
  const r = compileWithLimit(oz.objects, order, g, oz.quant, oz.transform, oz.mmPerPx);
  plan = r.plan;
  adjustedG = r.adjusted;
  overLimit = r.overLimit;
  diag = diagnose(plan, g);
  // ステッチ数の累積 (プレイヤー表示用)
  stitchPrefix = new Int32Array(plan.pattern.stitches.length + 1);
  for (let i = 0; i < plan.pattern.stitches.length; i++) {
    stitchPrefix[i + 1] = stitchPrefix[i] + (plan.pattern.stitches[i].cmd === STITCH ? 1 : 0);
  }
  playerPos = plan.pattern.stitches.length;
  $<HTMLInputElement>("seek").max = String(plan.pattern.stitches.length);
  $<HTMLInputElement>("seek").value = String(playerPos);
  renderAll();
}

// ------------------------------------------------------------------ 表示
function renderAll(): void {
  renderChips();
  renderDiag();
  renderSequence();
  renderProps();
  renderCanvas();
  const ok = !!plan && plan.stats.stitches > 0;
  $<HTMLButtonElement>("exportPes").disabled = !ok;
  $<HTMLButtonElement>("exportDst").disabled = !ok;
  $<HTMLButtonElement>("saveProject").disabled = !oz;
}

function renderChips(): void {
  const chips = $("chips");
  if (!plan) {
    chips.innerHTML = "";
    return;
  }
  const s = plan.stats;
  const overCls = overLimit ? ' class="over"' : "";
  chips.innerHTML =
    `<span${overCls}>針数 <b>${s.stitches.toLocaleString()}</b></span>` +
    `<span>糸切り <b>${s.trims}</b></span>` +
    `<span>色 <b>${s.colors}</b></span>` +
    `<span>サイズ <b>${s.widthMm.toFixed(0)}×${s.heightMm.toFixed(0)}mm</b></span>` +
    `<span>約 <b>${s.estMinutes}</b> 分</span>` +
    (adjustedG ? `<span>密度自動調整 <b>行${adjustedG.rowSpacingMm.toFixed(2)}mm</b></span>` : "");
}

function renderDiag(): void {
  const list = $("diagList");
  list.innerHTML = "";
  const badge = $("diagBadge");
  if (!plan) {
    badge.textContent = "";
    return;
  }
  const lv = worstLevel(diag);
  badge.className = `badge ${lv}`;
  badge.textContent = lv === "ok" ? "OK" : lv === "warn" ? "注意" : "修正必須";
  const sorted = [...diag].sort((a, b) => rank(b.level) - rank(a.level));
  for (const item of sorted) {
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="lv ${item.level}"></span>` +
      `<span class="lb">${item.label}</span><span class="vl">${item.value}</span>` +
      (item.detail ? `<span class="detail">${item.detail}</span>` : "");
    if (item.fix) {
      const btn = document.createElement("button");
      btn.className = "fix";
      btn.textContent = "自動修正";
      btn.addEventListener("click", () => applyFix(item.fix!));
      li.appendChild(btn);
    }
    list.appendChild(li);
  }
}
function rank(l: string): number {
  return l === "error" ? 2 : l === "warn" ? 1 : 0;
}

function applyFix(fix: NonNullable<DiagItem["fix"]>): void {
  if (fix === "reduceStitches") {
    // compileWithLimit が自動で密度を緩めるため、上限を再適用して再計算
    recompile();
    if (overLimit) {
      g = { ...g, sizeMm: Math.max(10, Math.round(g.sizeMm * 0.9)) };
      $<HTMLInputElement>("sizeMm").value = String(g.sizeMm);
      reobjectize();
    }
  } else if (fix === "shrinkSize") {
    g = { ...g, sizeMm: Math.max(10, Math.round(g.sizeMm * 0.9)) };
    $<HTMLInputElement>("sizeMm").value = String(g.sizeMm);
    reobjectize();
  } else if (fix === "mergeColors") {
    g = { ...g, colorMergeLevel: 3 };
    $<HTMLSelectElement>("colorMerge").value = "3";
    reobjectize();
  } else if (fix === "raiseTrimDistance") {
    g = { ...g, trimDistanceMm: Math.min(100, Math.round(g.trimDistanceMm * 1.5)) };
    $<HTMLInputElement>("trimDistance").value = String(g.trimDistanceMm);
    recompile();
  }
}

function renderSequence(): void {
  const list = $("seqList");
  list.innerHTML = "";
  if (!oz || !plan) return;
  const byId = new Map(oz.objects.map((o) => [o.id, o]));
  const segById = new Map(plan.segments.map((s) => [s.objectId, s]));
  order.forEach((id, idx) => {
    const obj = byId.get(id);
    if (!obj) return;
    const seg = segById.get(id);
    const pal = oz!.quant.palette[obj.paletteIndex];
    const li = document.createElement("li");
    if (id === selectedId) li.classList.add("selected");
    if (!obj.settings.visible) li.classList.add("hidden-obj");
    const joinLabel =
      seg?.joinType === "walk"
        ? `つなぎ ${seg.joinDistMm}mm`
        : seg?.joinType === "trim"
          ? `✂ ${seg.joinDistMm}mm`
          : seg?.joinType === "jump"
            ? `渡り ${seg.joinDistMm}mm`
            : seg?.joinType === "color"
              ? "色替え"
              : "開始";
    li.innerHTML =
      `<span class="ord">${idx + 1}</span>` +
      `<span class="sw" style="background:rgb(${pal?.r ?? 0},${pal?.g ?? 0},${pal?.b ?? 0})"></span>` +
      `<span class="nm">${obj.name}</span>` +
      `<span class="kind">${kindLabel(obj.settings.kind)}</span>` +
      `<span class="st">${seg ? seg.stitches.toLocaleString() : "—"}針</span>` +
      `<span class="join ${seg?.joinType ?? ""}">${joinLabel}</span>`;
    const eye = document.createElement("button");
    eye.className = "mini";
    eye.textContent = obj.settings.visible ? "👁" : "—";
    eye.title = "表示/非表示";
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      obj.settings.visible = !obj.settings.visible;
      recompile();
    });
    const up = document.createElement("button");
    up.className = "mini";
    up.textContent = "↑";
    up.addEventListener("click", (e) => {
      e.stopPropagation();
      moveOrder(id, -1);
    });
    const down = document.createElement("button");
    down.className = "mini";
    down.textContent = "↓";
    down.addEventListener("click", (e) => {
      e.stopPropagation();
      moveOrder(id, 1);
    });
    li.append(eye, up, down);
    li.addEventListener("click", () => {
      selectedId = selectedId === id ? null : id;
      renderSequence();
      renderProps();
      renderCanvas();
    });
    list.appendChild(li);
  });
}
function kindLabel(k: string): string {
  return k === "tatami" ? "タタミ" : k === "satin" ? "サテン" : "中心線";
}
function moveOrder(id: string, delta: number): void {
  const i = order.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  recompile();
}

function selectedObject(): EmbObject | null {
  if (!oz || !selectedId) return null;
  return oz.objects.find((o) => o.id === selectedId) ?? null;
}

function renderProps(): void {
  const panel = $("propPanel");
  const obj = selectedObject();
  if (!obj || !oz) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $("propName").textContent = obj.name;
  $<HTMLSelectElement>("propKind").value = obj.settings.kind;
  $<HTMLSelectElement>("propAngle").value =
    obj.settings.angleDeg === null ? "" : String(obj.settings.angleDeg);
  $<HTMLSelectElement>("propTrim").value = obj.settings.trimMode;
  $<HTMLInputElement>("propOutline").checked = obj.settings.outline ?? g.outline;
  const colorSel = $<HTMLSelectElement>("propColor");
  colorSel.innerHTML = "";
  oz.quant.palette.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `色${i + 1} rgb(${p.r},${p.g},${p.b})`;
    colorSel.appendChild(opt);
  });
  colorSel.value = String(obj.paletteIndex);
}

for (const [id, apply] of [
  ["propKind", (o: EmbObject, v: string) => (o.settings.kind = v as EmbObject["settings"]["kind"])],
  ["propAngle", (o: EmbObject, v: string) => (o.settings.angleDeg = v === "" ? null : Number(v))],
  ["propTrim", (o: EmbObject, v: string) => (o.settings.trimMode = v as EmbObject["settings"]["trimMode"])],
  ["propColor", (o: EmbObject, v: string) => (o.paletteIndex = Number(v))],
] as const) {
  $(id).addEventListener("change", () => {
    const obj = selectedObject();
    if (!obj) return;
    apply(obj, ($(id) as HTMLSelectElement).value);
    recompile();
  });
}
$("propOutline").addEventListener("change", () => {
  const obj = selectedObject();
  if (!obj) return;
  obj.settings.outline = $<HTMLInputElement>("propOutline").checked;
  recompile();
});

// ------------------------------------------------------------------ キャンバス
function renderCanvas(): void {
  const W = canvas.width;
  ctx2d.clearRect(0, 0, W, W);
  const pxPerUnit = W / (HOOP_MM * 10 * 1.08);
  const origin = W / 2;

  // 下絵 (アートワークとの重ね表示)
  if ($<HTMLInputElement>("showArt").checked && imageBitmap && oz && plan) {
    const t = oz.transform;
    const u2s = (ux: number, uy: number): [number, number] => [
      origin + (ux + plan!.offset.dx) * pxPerUnit,
      origin + (uy + plan!.offset.dy) * pxPerUnit,
    ];
    const [sx0, sy0] = u2s((0 - t.cx) * t.scale, (0 - t.cy) * t.scale);
    const [sx1, sy1] = u2s(
      (imageBitmap.width - t.cx) * t.scale,
      (imageBitmap.height - t.cy) * t.scale,
    );
    ctx2d.save();
    ctx2d.globalAlpha = 0.25;
    ctx2d.drawImage(imageBitmap, sx0, sy0, sx1 - sx0, sy1 - sy0);
    ctx2d.restore();
  }

  // 枠とグリッド
  ctx2d.strokeStyle = "#e8e8e2";
  ctx2d.lineWidth = 1;
  for (let mm = -50; mm <= 50; mm += 10) {
    const p = origin + mm * 10 * pxPerUnit;
    ctx2d.beginPath();
    ctx2d.moveTo(p, origin - 500 * pxPerUnit);
    ctx2d.lineTo(p, origin + 500 * pxPerUnit);
    ctx2d.stroke();
    ctx2d.beginPath();
    ctx2d.moveTo(origin - 500 * pxPerUnit, p);
    ctx2d.lineTo(origin + 500 * pxPerUnit, p);
    ctx2d.stroke();
  }
  ctx2d.strokeStyle = "#d2a09a";
  ctx2d.lineWidth = 2;
  ctx2d.strokeRect(origin - 500 * pxPerUnit, origin - 500 * pxPerUnit, 1000 * pxPerUnit, 1000 * pxPerUnit);

  if (!plan) return;
  const { pattern } = plan;
  const showMoves = $<HTMLInputElement>("showMoves").checked;
  const sel = selectedId ? plan.segments.find((s) => s.objectId === selectedId) : null;

  let colorIdx = 0;
  let prev: { x: number; y: number } | null = null;
  ctx2d.lineCap = "round";
  const limit = Math.min(playerPos, pattern.stitches.length);
  for (let i = 0; i < limit; i++) {
    const s = pattern.stitches[i];
    const px = origin + s.x * pxPerUnit;
    const py = origin + s.y * pxPerUnit;
    const inSel = sel && i >= sel.from && i < sel.to;
    if (s.cmd === STITCH) {
      if (prev) {
        const th = pattern.threads[Math.min(colorIdx, pattern.threads.length - 1)];
        ctx2d.strokeStyle = th ? `rgb(${th.r},${th.g},${th.b})` : "#000";
        ctx2d.lineWidth = inSel ? Math.max(2.5, 6 * pxPerUnit) : Math.max(1, 4 * pxPerUnit);
        ctx2d.globalAlpha = sel && !inSel ? 0.25 : 1;
        ctx2d.beginPath();
        ctx2d.moveTo(origin + prev.x * pxPerUnit, origin + prev.y * pxPerUnit);
        ctx2d.lineTo(px, py);
        ctx2d.stroke();
        ctx2d.globalAlpha = 1;
      }
      prev = { x: s.x, y: s.y };
    } else if (s.cmd === JUMP) {
      if (showMoves && prev) {
        ctx2d.save();
        ctx2d.strokeStyle = "rgba(120,120,130,0.5)";
        ctx2d.lineWidth = 1.5;
        ctx2d.setLineDash([4, 4]);
        ctx2d.beginPath();
        ctx2d.moveTo(origin + prev.x * pxPerUnit, origin + prev.y * pxPerUnit);
        ctx2d.lineTo(px, py);
        ctx2d.stroke();
        ctx2d.restore();
      }
      prev = { x: s.x, y: s.y };
    } else if (s.cmd === TRIM) {
      if (showMoves) {
        ctx2d.save();
        ctx2d.strokeStyle = "#dc2626";
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.moveTo(px - 5, py - 5);
        ctx2d.lineTo(px + 5, py + 5);
        ctx2d.moveTo(px + 5, py - 5);
        ctx2d.lineTo(px - 5, py + 5);
        ctx2d.stroke();
        ctx2d.restore();
      }
    } else if (s.cmd === COLOR_CHANGE) {
      colorIdx++;
      if (showMoves) {
        ctx2d.save();
        ctx2d.fillStyle = "#2563eb";
        ctx2d.beginPath();
        ctx2d.moveTo(px, py - 6);
        ctx2d.lineTo(px + 6, py);
        ctx2d.lineTo(px, py + 6);
        ctx2d.lineTo(px - 6, py);
        ctx2d.closePath();
        ctx2d.fill();
        ctx2d.restore();
      }
    }
  }

  // 選択オブジェクトの開始点 (▶緑) / 終了点 (■赤)
  if (sel) {
    const mark = (p: [number, number], color: string, square: boolean) => {
      const mx = origin + p[0] * pxPerUnit;
      const my = origin + p[1] * pxPerUnit;
      ctx2d.save();
      ctx2d.fillStyle = color;
      ctx2d.strokeStyle = "#fff";
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      if (square) ctx2d.rect(mx - 5, my - 5, 10, 10);
      else {
        ctx2d.moveTo(mx - 5, my - 6);
        ctx2d.lineTo(mx + 7, my);
        ctx2d.lineTo(mx - 5, my + 6);
        ctx2d.closePath();
      }
      ctx2d.fill();
      ctx2d.stroke();
      ctx2d.restore();
    };
    mark(sel.start, "#16a34a", false);
    mark(sel.end, "#dc2626", true);
  }

  // プレイヤー情報
  const sewn = stitchPrefix[limit] ?? 0;
  $("playerInfo").textContent = `${sewn.toLocaleString()} / ${plan.stats.stitches.toLocaleString()} 針`;
}

// キャンバスクリック → オブジェクト選択
canvas.addEventListener("click", (e) => {
  if (!plan || !oz) return;
  const rect = canvas.getBoundingClientRect();
  const cxp = (e.clientX - rect.left) * (canvas.width / rect.width);
  const cyp = (e.clientY - rect.top) * (canvas.height / rect.height);
  const pxPerUnit = canvas.width / (HOOP_MM * 10 * 1.08);
  const origin = canvas.width / 2;
  const ux = (cxp - origin) / pxPerUnit;
  const uy = (cyp - origin) / pxPerUnit;
  // 最も近いステッチを持つセグメントを選ぶ
  let best: string | null = null;
  let bestD = 12 / pxPerUnit + 30;
  for (const seg of plan.segments) {
    for (let i = seg.from; i < seg.to; i += 3) {
      const s = plan.pattern.stitches[i];
      if (s.cmd !== STITCH) continue;
      const d = Math.hypot(s.x - ux, s.y - uy);
      if (d < bestD) {
        bestD = d;
        best = seg.objectId;
      }
    }
  }
  selectedId = best === selectedId ? null : best;
  renderSequence();
  renderProps();
  renderCanvas();
});

// ------------------------------------------------------------------ プレイヤー
$("seek").addEventListener("input", () => {
  playerPos = Number($<HTMLInputElement>("seek").value);
  renderCanvas();
});
$("showMoves").addEventListener("change", () => renderCanvas());
$("showArt").addEventListener("change", () => renderCanvas());

$("playBtn").addEventListener("click", () => {
  playing = !playing;
  $("playBtn").textContent = playing ? "⏸" : "▶";
  if (playing) {
    if (plan && playerPos >= plan.pattern.stitches.length) playerPos = 0;
    tick();
  }
});
function tick(): void {
  if (!playing || !plan) return;
  playerPos = Math.min(playerPos + 25, plan.pattern.stitches.length);
  $<HTMLInputElement>("seek").value = String(playerPos);
  renderCanvas();
  if (playerPos >= plan.pattern.stitches.length) {
    playing = false;
    $("playBtn").textContent = "▶";
    return;
  }
  requestAnimationFrame(tick);
}

function jumpTo(cmd: number, dir: 1 | -1): void {
  if (!plan) return;
  const sts = plan.pattern.stitches;
  let i = playerPos + dir;
  while (i > 0 && i < sts.length && sts[i]?.cmd !== cmd) i += dir;
  playerPos = Math.max(0, Math.min(sts.length, i + 1));
  $<HTMLInputElement>("seek").value = String(playerPos);
  renderCanvas();
}
$("prevTrim").addEventListener("click", () => jumpTo(TRIM, -1));
$("nextTrim").addEventListener("click", () => jumpTo(TRIM, 1));
$("prevColor").addEventListener("click", () => jumpTo(COLOR_CHANGE, -1));
$("nextColor").addEventListener("click", () => jumpTo(COLOR_CHANGE, 1));

// ------------------------------------------------------------------ 出力
const isMobile =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

async function exportFile(data: Uint8Array, filename: string): Promise<void> {
  const blob = new Blob([data.buffer as ArrayBuffer], { type: "application/octet-stream" });
  if (isMobile && typeof navigator.share === "function") {
    try {
      const file = new File([blob], filename, { type: "application/octet-stream" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        $("exportStatus").textContent = `${filename} を共有しました`;
        return;
      }
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  $("exportStatus").textContent = `${filename} を保存しました`;
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

$("exportPes").addEventListener("click", () => {
  if (!plan) return;
  plan.pattern.name = designName;
  void exportFile(writePes(plan.pattern), `${designName}.pes`);
});
$("exportDst").addEventListener("click", () => {
  if (!plan) return;
  plan.pattern.name = designName;
  void exportFile(writeDst(plan.pattern), `${designName}.dst`);
});

// プロジェクト保存 / 読み込み
$("saveProject").addEventListener("click", () => {
  if (!oz) return;
  const json = serializeProject(designName, projectId, g, imageDataUrl, oz.objects, order);
  const blob = new Blob([JSON.stringify(json)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${designName}.project.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  $("exportStatus").textContent = "プロジェクトを保存しました";
});
$("loadProjectBtn").addEventListener("click", () => $<HTMLInputElement>("projectInput").click());
$("projectInput").addEventListener("change", () => {
  const file = $<HTMLInputElement>("projectInput").files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const p = JSON.parse(String(reader.result)) as ProjectJson;
      if (p.app !== "pp1-stitch-studio") throw new Error("不明なファイル形式");
      g = { ...DEFAULT_GLOBAL, ...p.settings };
      designName = p.name;
      projectId = p.id;
      syncSettingsToUi();
      if (!p.imageDataUrl) throw new Error("画像が含まれていません");
      imageDataUrl = p.imageDataUrl;
      const img = new Image();
      img.onload = () => {
        setSourceImage(img);
        // 量子化は決定的なので同じ設定で再構築し、保存済みオブジェクトを適用
        oz = objectize(sourceImage!, g);
        const restored = deserializeObjects(p);
        oz.objects = restored.objects;
        order = restored.order;
        selectedId = null;
        recompile();
        $("exportStatus").textContent = "プロジェクトを読み込みました";
      };
      img.src = p.imageDataUrl;
    } catch (err) {
      $("exportStatus").textContent = `読み込みエラー: ${err}`;
    }
  };
  reader.readAsText(file);
});

function syncSettingsToUi(): void {
  $<HTMLInputElement>("sizeMm").value = String(g.sizeMm);
  $<HTMLInputElement>("maxColors").value = String(g.maxColors);
  $<HTMLSelectElement>("colorMerge").value = String(g.colorMergeLevel);
  $<HTMLInputElement>("autoBg").checked = g.autoBackground;
  $<HTMLInputElement>("rowSpacing").value = String(g.rowSpacingMm);
  $<HTMLInputElement>("satinSpacing").value = String(g.satinSpacingMm);
  $<HTMLInputElement>("stitchLen").value = String(g.stitchLenMm);
  $<HTMLInputElement>("angleDeg").value = String(g.angleDeg);
  $<HTMLInputElement>("outlineOn").checked = g.outline;
  $<HTMLInputElement>("autoThin").checked = g.autoThinDetect;
  $<HTMLSelectElement>("trimMode").value = g.trimMode;
  $<HTMLInputElement>("trimDistance").value = String(g.trimDistanceMm);
  $<HTMLInputElement>("maxStitches").value = String(g.maxStitches);
}

// 初期化
syncSettingsToUi();
renderAll();
