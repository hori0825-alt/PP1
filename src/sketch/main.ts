// PP1 Sketch — iPad で描いた絵をそのまま刺繍データ (PES/DST) にするアプリ。
//
// 操作:
//   Apple Pencil / 指 / マウスで描く。2本指でピンチ (拡大) とパン (移動)。
//   2本指タップ = 取り消し、3本指タップ = やり直し (Pencil 使用時)。
// データ:
//   描いた線・面はそのまま刺繍の部品 (model.ts)。レイヤー順 = 縫い順。

import "./sketch.css";
import { BROTHER_PALETTE } from "../export/brotherPalette";
import { writeDst } from "../export/dst";
import { writePes } from "../export/pes";
import { validatePlan } from "../export/validate";
import { bucketFill } from "./bucket";
import { compileSketch, flattenPlan, type CompileResult, type FlatStitch, type SeqItem } from "./compile";
import { cleanRing, cleanStroke, dist, distToPolyline, pointInShape, polylineLength, signedAreaMm } from "./geom";
import {
  cloneDoc,
  newDoc,
  newLayer,
  parseDoc,
  resolveStrokeStyle,
  uid,
  type Element,
  type FillEl,
  type Layer,
  type SketchDoc,
  type StrokeEl,
  type StrokeStyle,
  type ThreadRef,
  type Vec,
} from "./model";

const SKETCH_VERSION = "1.0.0";
const STITCH_LIMIT = 12000;
const SAVE_KEY = "pp1-sketch:doc";
const UNDERLAY_KEY = "pp1-sketch:underlay";
const PREF_KEY = "pp1-sketch:prefs";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
$("ver").textContent = `v${SKETCH_VERSION}`;

type Tool = "pen" | "bucket" | "lasso" | "ellipse" | "rect" | "select" | "eraser";
type Mode = "draw" | "stitch";

// ------------------------------------------------------------------ 状態

const palette: ThreadRef[] = BROTHER_PALETTE.map((t) => ({
  r: t.r,
  g: t.g,
  b: t.b,
  pecIndex: t.pecIndex,
  name: t.name,
}));
const byPec = (n: number) => palette.find((p) => p.pecIndex === n) ?? palette[0];

let doc: SketchDoc = loadDoc();
let activeLayerId = doc.layers[doc.layers.length - 1].id;
let tool: Tool = "pen";
let mode: Mode = "draw";
let color: ThreadRef = byPec(20); // Black
let recent: ThreadRef[] = [byPec(20), byPec(5), byPec(13), byPec(29)];
let penWidth = 1.0;
let shapeFill = true;
let gapClose = 1.0;
let selectedId: string | null = null;
let seqSelected: string | null = null;

const prefs = loadPrefs();
let penOnly = prefs.penOnly ?? false;

const undoStack: string[] = [];
const redoStack: string[] = [];
let docVersion = 0;

let compiled: CompileResult | null = null;
let compiledVersion = -1;
let flat: FlatStitch[] = [];
let playerPos = 0;
let playing = false;

// ------------------------------------------------------------------ 保存

function loadDoc(): SketchDoc {
  try {
    const t = localStorage.getItem(SAVE_KEY);
    if (t) {
      const d = parseDoc(t);
      const img = localStorage.getItem(UNDERLAY_KEY);
      if (img) d.settings.underlayImage = img;
      if (d.layers.length === 0) d.layers.push(newLayer("レイヤー1"));
      return d;
    }
  } catch {
    /* 壊れた保存データは無視して新規 */
  }
  return newDoc();
}

function loadPrefs(): { penOnly?: boolean; penOnlyDecided?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function savePrefs(): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ penOnly, penOnlyDecided: prefs.penOnlyDecided }));
  } catch {
    /* noop */
  }
}

let saveTimer = 0;
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const { underlayImage, ...rest } = doc.settings;
      localStorage.setItem(SAVE_KEY, JSON.stringify({ ...doc, settings: { ...rest, underlayImage: null } }));
      if (underlayImage) localStorage.setItem(UNDERLAY_KEY, underlayImage);
      else localStorage.removeItem(UNDERLAY_KEY);
    } catch {
      toast("自動保存できませんでした (容量不足)。「作品を保存」で書き出してください");
    }
  }, 400);
}

// ------------------------------------------------------------------ 変更と履歴

function snapshot(): string {
  return JSON.stringify(doc);
}

/** 変更の直前に呼ぶ (取り消し用の記録) */
function beginChange(): void {
  undoStack.push(snapshot());
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
}

/** 変更の後に呼ぶ */
function changed(): void {
  docVersion++;
  scheduleSave();
  scheduleCompile();
  renderPanels();
  requestDraw();
}

function undo(): void {
  const s = undoStack.pop();
  if (!s) return toast("これ以上取り消せません");
  redoStack.push(snapshot());
  doc = parseDoc(s);
  ensureActiveLayer();
  selectedId = null;
  changed();
  toast("取り消しました");
}
function redo(): void {
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push(snapshot());
  doc = parseDoc(s);
  ensureActiveLayer();
  changed();
  toast("やり直しました");
}

function ensureActiveLayer(): void {
  if (!doc.layers.some((l) => l.id === activeLayerId)) {
    activeLayerId = doc.layers[doc.layers.length - 1].id;
  }
}

const activeLayer = (): Layer => doc.layers.find((l) => l.id === activeLayerId) ?? doc.layers[0];

function findElement(id: string): { el: Element; layer: Layer } | null {
  for (const layer of doc.layers) {
    const el = layer.elements.find((e) => e.id === id);
    if (el) return { el, layer };
  }
  return null;
}

// ------------------------------------------------------------------ コンパイル

let compileTimer = 0;
function scheduleCompile(): void {
  clearTimeout(compileTimer);
  compileTimer = window.setTimeout(() => {
    ensureCompiled();
    renderChips();
    renderPanels();
    if (mode === "stitch") requestDraw();
  }, 250);
}

function ensureCompiled(): CompileResult {
  if (!compiled || compiledVersion !== docVersion) {
    compiled = compileSketch(doc);
    compiledVersion = docVersion;
    flat = flattenPlan(compiled.plan);
    playerPos = flat.length;
    const seek = $<HTMLInputElement>("seek");
    seek.max = String(flat.length);
    seek.value = String(playerPos);
  }
  return compiled;
}

// ------------------------------------------------------------------ キャンバスと表示座標

const stage = $("stage");
const cv = $<HTMLCanvasElement>("cv");
const ctx = cv.getContext("2d")!;
let dpr = window.devicePixelRatio || 1;
const view = { scale: 6, ox: 0, oy: 0 };
let viewInit = false;

function fit(): void {
  // 上はツール設定パネル、下 (プレビュー時) はプレイヤーの分だけ空ける
  const top = mode === "draw" ? 56 : 8;
  const bottom = mode === "stitch" ? 72 : 8;
  const w = cv.clientWidth;
  const h = cv.clientHeight - top - bottom;
  view.scale = Math.max(1, Math.min(w, h) / 106);
  view.ox = w / 2;
  view.oy = top + h / 2;
  requestDraw();
}

function resize(): void {
  dpr = window.devicePixelRatio || 1;
  const r = stage.getBoundingClientRect();
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  if (!viewInit) {
    fit();
    viewInit = true;
  }
  requestDraw();
}
new ResizeObserver(resize).observe(stage);

const toMm = (sx: number, sy: number): Vec => ({ x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale });

function localXY(e: PointerEvent | MouseEvent): { x: number; y: number } {
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

let drawQueued = false;
function requestDraw(): void {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

const rgb = (c: { r: number; g: number; b: number }, a = 1) =>
  a === 1 ? `rgb(${c.r},${c.g},${c.b})` : `rgba(${c.r},${c.g},${c.b},${a})`;

let underlayImg: HTMLImageElement | null = null;
let underlaySrc: string | null = null;
function underlayImage(): HTMLImageElement | null {
  const src = doc.settings.underlayImage;
  if (!src) return null;
  if (src !== underlaySrc) {
    underlaySrc = src;
    underlayImg = new Image();
    underlayImg.onload = () => requestDraw();
    underlayImg.src = src;
  }
  return underlayImg && underlayImg.complete ? underlayImg : null;
}

function draw(): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#e9ebef";
  ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight);
  // 以降は mm 座標で描く
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy);
  const px = 1 / view.scale; // 1 画面px の mm

  // 刺繍枠 (100×100mm)
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(-50, -50, 100, 100);
  ctx.strokeStyle = "#eef0f3";
  ctx.lineWidth = px;
  for (let v = -40; v <= 40; v += 10) {
    ctx.beginPath();
    ctx.moveTo(v, -50);
    ctx.lineTo(v, 50);
    ctx.moveTo(-50, v);
    ctx.lineTo(50, v);
    ctx.stroke();
  }
  ctx.strokeStyle = "#d9a3ad";
  ctx.lineWidth = 2 * px;
  ctx.strokeRect(-50, -50, 100, 100);

  // 下絵
  const s = doc.settings;
  const img = underlayImage();
  if (img && s.underlayVisible) {
    const k = 100 / Math.max(img.width, img.height);
    const w = img.width * k;
    const h = img.height * k;
    ctx.globalAlpha = s.underlayOpacity;
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.globalAlpha = 1;
  }

  if (mode === "stitch") {
    drawStitches(px);
  } else {
    for (const layer of doc.layers) {
      if (!layer.visible) continue;
      for (const el of layer.elements) drawElement(el, 1, px);
    }
    drawSelection(px);
    drawGesturePreview(px);
  }
}

function elementPath(el: Element): Path2D {
  const p = new Path2D();
  if (el.kind === "fill") {
    for (const ring of [el.outer, ...el.holes]) {
      ring.forEach((v, i) => (i === 0 ? p.moveTo(v.x, v.y) : p.lineTo(v.x, v.y)));
      p.closePath();
    }
  } else {
    el.points.forEach((v, i) => (i === 0 ? p.moveTo(v.x, v.y) : p.lineTo(v.x, v.y)));
    if (el.closed) p.closePath();
  }
  return p;
}

function drawElement(el: Element, alpha: number, px: number, offset?: Vec): void {
  ctx.save();
  if (offset) ctx.translate(offset.x, offset.y);
  const path = elementPath(el);
  if (el.kind === "fill") {
    ctx.fillStyle = rgb(el.color, alpha);
    ctx.fill(path, "evenodd");
  } else {
    ctx.strokeStyle = rgb(el.color, alpha);
    ctx.lineWidth = Math.max(el.width, 1.2 * px);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (resolveStrokeStyle(el) === "running") ctx.setLineDash([doc.settings.runLen * 0.75, doc.settings.runLen * 0.25]);
    if (el.points.length === 1) {
      ctx.beginPath();
      ctx.arc(el.points[0].x, el.points[0].y, Math.max(el.width / 2, px), 0, Math.PI * 2);
      ctx.fillStyle = rgb(el.color, alpha);
      ctx.fill();
    } else {
      ctx.stroke(path);
    }
  }
  ctx.restore();
}

function drawSelection(px: number): void {
  if (!selectedId) return;
  const f = findElement(selectedId);
  if (!f) return;
  ctx.save();
  if (move.active) ctx.translate(move.dx, move.dy);
  ctx.strokeStyle = "#2f6fec";
  ctx.lineWidth = 2 * px;
  ctx.setLineDash([6 * px, 4 * px]);
  const pts = f.el.kind === "fill" ? f.el.outer : f.el.points;
  const pad = f.el.kind === "stroke" ? f.el.width / 2 + 2 * px : 2 * px;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  ctx.strokeRect(minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2);
  ctx.restore();
}

function drawStitches(px: number): void {
  const res = ensureCompiled();
  const blocks = res.plan.blocks;
  const showJumps = $<HTMLInputElement>("showJumps").checked;
  const sel = seqSelected ? res.seq.find((q) => q.elementId === seqSelected) : null;
  const end = Math.min(playerPos, flat.length);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let i = 1;
  while (i < end) {
    // 同じブロックの通常ステッチをまとめて1パスで描く
    const b = flat[i].block;
    const dimmed = sel ? !(i >= sel.from && i < sel.to) : false;
    ctx.beginPath();
    let any = false;
    while (i < end && flat[i].block === b && (sel ? !(i >= sel.from && i < sel.to) === dimmed : true)) {
      const a = flat[i - 1];
      const p = flat[i];
      if (p.move === 0) {
        ctx.moveTo(a.x / 10, a.y / 10);
        ctx.lineTo(p.x / 10, p.y / 10);
        any = true;
      }
      i++;
    }
    if (any) {
      ctx.strokeStyle = rgb(blocks[b].thread, dimmed ? 0.18 : 1);
      ctx.lineWidth = Math.max(0.22, 1.1 * px);
      ctx.stroke();
    }
  }
  if (showJumps) {
    ctx.lineWidth = 1.5 * px;
    for (let k = 1; k < end; k++) {
      const p = flat[k];
      if (p.move === 0) continue;
      const a = flat[k - 1];
      if (p.move === 1 || p.move === 2) {
        ctx.strokeStyle = p.move === 1 ? "rgba(217,119,6,0.9)" : "rgba(120,120,130,0.7)";
        ctx.setLineDash([4 * px, 3 * px]);
        ctx.beginPath();
        ctx.moveTo(a.x / 10, a.y / 10);
        ctx.lineTo(p.x / 10, p.y / 10);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (p.move === 2) {
        // 糸切り位置 (×)
        const r = 5 * px;
        ctx.strokeStyle = "#dc2626";
        ctx.lineWidth = 2 * px;
        ctx.beginPath();
        ctx.moveTo(a.x / 10 - r, a.y / 10 - r);
        ctx.lineTo(a.x / 10 + r, a.y / 10 + r);
        ctx.moveTo(a.x / 10 + r, a.y / 10 - r);
        ctx.lineTo(a.x / 10 - r, a.y / 10 + r);
        ctx.stroke();
        ctx.lineWidth = 1.5 * px;
      }
    }
  }
  // 現在の針位置
  if (end > 0 && end < flat.length) {
    const p = flat[end - 1];
    ctx.fillStyle = "#2f6fec";
    ctx.beginPath();
    ctx.arc(p.x / 10, p.y / 10, 4 * px, 0, Math.PI * 2);
    ctx.fill();
  }
  const sewn = end;
  $("seekInfo").textContent = `${sewn.toLocaleString()} / ${flat.length.toLocaleString()} 針`;
}

// ------------------------------------------------------------------ ジェスチャー

interface Ptr {
  x: number;
  y: number;
  sx: number;
  sy: number;
  type: string;
}
const pointers = new Map<number, Ptr>();

type Gesture =
  | { kind: "draw"; id: number; raw: Vec[]; smooth: Vec; start: Vec; cur: Vec }
  | { kind: "pinch"; ids: [number, number]; d0: number; scale0: number; anchor: Vec; c0: { x: number; y: number } }
  | { kind: "pan"; id: number; ox0: number; oy0: number; sx: number; sy: number }
  | { kind: "move"; id: number; start: Vec }
  | { kind: "erase"; id: number; changedAny: boolean };
let gesture: Gesture | null = null;
const move = { active: false, dx: 0, dy: 0 };

// 2本指/3本指タップの検出
let tap = { count: 0, t0: 0, moved: false };

function cancelGesture(): void {
  if (gesture?.kind === "move") move.active = false;
  gesture = null;
  requestDraw();
}

cv.addEventListener("pointerdown", (e) => {
  try {
    cv.setPointerCapture(e.pointerId);
  } catch {
    /* 合成イベント等でキャプチャできなくても描画は続ける */
  }
  const p = localXY(e);
  pointers.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, type: e.pointerType });

  if (e.pointerType === "pen" && !penOnly && !prefs.penOnlyDecided) {
    penOnly = true;
    prefs.penOnlyDecided = true;
    $<HTMLInputElement>("setPenOnly").checked = true;
    savePrefs();
    toast("Apple Pencil で描けます。指はピンチで拡大・2本指タップで取り消し");
  }

  const touches = [...pointers.entries()].filter(([, q]) => q.type === "touch");
  if (e.pointerType === "touch") {
    if (tap.count === 0 || performance.now() - tap.t0 > 350) tap = { count: 0, t0: performance.now(), moved: false };
    tap.count = Math.max(tap.count, touches.length);
    if (touches.length >= 2) {
      // 指で描きかけていた線は捨ててピンチへ
      const [a, b] = touches.slice(0, 2);
      const c0 = { x: (a[1].x + b[1].x) / 2, y: (a[1].y + b[1].y) / 2 };
      gesture = {
        kind: "pinch",
        ids: [a[0], b[0]],
        d0: Math.hypot(a[1].x - b[1].x, a[1].y - b[1].y) || 1,
        scale0: view.scale,
        anchor: toMm(c0.x, c0.y),
        c0,
      };
      move.active = false;
      requestDraw();
      return;
    }
    if (penOnly || mode === "stitch") {
      gesture = { kind: "pan", id: e.pointerId, ox0: view.ox, oy0: view.oy, sx: p.x, sy: p.y };
      return;
    }
  } else if (e.pointerType === "mouse" && (e.button === 1 || e.button === 2 || spaceDown)) {
    gesture = { kind: "pan", id: e.pointerId, ox0: view.ox, oy0: view.oy, sx: p.x, sy: p.y };
    return;
  }
  if (gesture) return;
  if (mode === "stitch") {
    gesture = { kind: "pan", id: e.pointerId, ox0: view.ox, oy0: view.oy, sx: p.x, sy: p.y };
    return;
  }
  startTool(e.pointerId, toMm(p.x, p.y));
});

cv.addEventListener("pointermove", (e) => {
  const ptr = pointers.get(e.pointerId);
  if (!ptr) return;
  const p = localXY(e);
  ptr.x = p.x;
  ptr.y = p.y;
  if (Math.hypot(p.x - ptr.sx, p.y - ptr.sy) > 10) tap.moved = true;
  if (!gesture) return;

  if (gesture.kind === "pinch") {
    const a = pointers.get(gesture.ids[0]);
    const b = pointers.get(gesture.ids[1]);
    if (!a || !b) return;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    view.scale = Math.min(80, Math.max(1.5, (gesture.scale0 * d) / gesture.d0));
    view.ox = c.x - gesture.anchor.x * view.scale;
    view.oy = c.y - gesture.anchor.y * view.scale;
    requestDraw();
    return;
  }
  if (gesture.kind === "pan" && gesture.id === e.pointerId) {
    view.ox = gesture.ox0 + (p.x - gesture.sx);
    view.oy = gesture.oy0 + (p.y - gesture.sy);
    requestDraw();
    return;
  }
  if (gesture.kind === "draw" && gesture.id === e.pointerId) {
    const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    for (const ce of evs.length ? evs : [e]) {
      const q = localXY(ce);
      const m = toMm(q.x, q.y);
      gesture.cur = m;
      if (tool === "pen" || tool === "lasso") {
        // 手ぶれ補正 (lazy brush)
        gesture.smooth = {
          x: gesture.smooth.x + (m.x - gesture.smooth.x) * 0.45,
          y: gesture.smooth.y + (m.y - gesture.smooth.y) * 0.45,
        };
        gesture.raw.push(gesture.smooth);
      }
    }
    requestDraw();
    return;
  }
  if (gesture.kind === "move" && gesture.id === e.pointerId) {
    const m = toMm(p.x, p.y);
    move.dx = m.x - gesture.start.x;
    move.dy = m.y - gesture.start.y;
    requestDraw();
    return;
  }
  if (gesture.kind === "erase" && gesture.id === e.pointerId) {
    eraseAt(toMm(p.x, p.y), gesture);
  }
});

function endPointer(e: PointerEvent, cancelled: boolean): void {
  const ptr = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (!ptr) return;

  // 指を全部離したとき、短いマルチタップなら取り消し/やり直し
  const touchesLeft = [...pointers.values()].some((q) => q.type === "touch");
  if (ptr.type === "touch" && !touchesLeft && tap.count >= 2) {
    const quick = performance.now() - tap.t0 < 320 && !tap.moved;
    const n = tap.count;
    tap = { count: 0, t0: 0, moved: false };
    if (quick && !cancelled) {
      gesture = null;
      if (n === 2) undo();
      else if (n >= 3) redo();
      return;
    }
  }
  if (!touchesLeft && ptr.type === "touch") tap = { count: 0, t0: 0, moved: false };

  if (!gesture) return;
  if (gesture.kind === "pinch") {
    if (!gesture.ids.includes(e.pointerId)) return;
    gesture = null;
    return;
  }
  if ("id" in gesture && gesture.id !== e.pointerId) return;
  if (cancelled) return cancelGesture();
  const g = gesture;
  gesture = null;
  if (g.kind === "draw") {
    const p = localXY(e);
    g.raw.push(toMm(p.x, p.y));
    g.cur = toMm(p.x, p.y);
    finishTool(g);
  } else if (g.kind === "move") {
    move.active = false;
    if (selectedId && (Math.abs(move.dx) > 0.05 || Math.abs(move.dy) > 0.05)) {
      const f = findElement(selectedId);
      if (f) {
        beginChange();
        translateElement(f.el, move.dx, move.dy);
        changed();
      }
    }
    requestDraw();
  } else if (g.kind === "erase") {
    if (g.changedAny) changed();
  }
  requestDraw();
}
cv.addEventListener("pointerup", (e) => endPointer(e, false));
cv.addEventListener("pointercancel", (e) => endPointer(e, true));
cv.addEventListener("contextmenu", (e) => e.preventDefault());

cv.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const p = localXY(e);
    const anchor = toMm(p.x, p.y);
    const k = Math.exp(-e.deltaY * 0.0015);
    view.scale = Math.min(80, Math.max(1.5, view.scale * k));
    view.ox = p.x - anchor.x * view.scale;
    view.oy = p.y - anchor.y * view.scale;
    requestDraw();
  },
  { passive: false },
);
document.addEventListener("gesturestart", (e) => e.preventDefault());

let spaceDown = false;
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "INPUT") return;
  if (e.code === "Space") spaceDown = true;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
    deleteSelected();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") spaceDown = false;
});

// ------------------------------------------------------------------ ツール

function editableLayer(): Layer | null {
  const l = activeLayer();
  if (l.locked) {
    toast(`レイヤー「${l.name}」はロック中です`);
    return null;
  }
  if (!l.visible) {
    toast(`レイヤー「${l.name}」は非表示です`);
    return null;
  }
  return l;
}

function startTool(id: number, m: Vec): void {
  if (tool === "select") {
    const hit = hitTest(m, true);
    selectedId = hit ? hit.el.id : null;
    seqSelected = selectedId;
    if (hit) {
      activeLayerId = hit.layer.id;
      if (!hit.layer.locked) {
        gesture = { kind: "move", id, start: m };
        move.active = true;
        move.dx = 0;
        move.dy = 0;
      }
    }
    renderPanels();
    requestDraw();
    return;
  }
  if (tool === "eraser") {
    if (!editableLayer()) return;
    gesture = { kind: "erase", id, changedAny: false };
    eraseAt(m, gesture);
    return;
  }
  gesture = { kind: "draw", id, raw: [m], smooth: m, start: m, cur: m };
  requestDraw();
}

function finishTool(g: Extract<Gesture, { kind: "draw" }>): void {
  const layer = editableLayer();
  if (!layer) return;

  if (tool === "pen") {
    const pts = cleanStroke(g.raw);
    if (pts.length === 0) return;
    let closed = false;
    let points = pts;
    if (pts.length > 4 && polylineLength(pts) > 10 && dist(pts[0], pts[pts.length - 1]) <= Math.max(2, penWidth * 1.5)) {
      closed = true;
      points = pts.slice(0, -1);
    }
    addElement(layer, {
      kind: "stroke",
      id: uid(),
      points: points.length === 1 ? [points[0]] : points,
      closed,
      width: penWidth,
      style: "auto",
      color: { ...color },
    });
    return;
  }
  if (tool === "lasso") {
    const ring = cleanRing(g.raw);
    if (ring.length < 3 || Math.abs(signedAreaMm(ring)) < 1) return toast("もう少し大きく囲んでください");
    addElement(layer, { kind: "fill", id: uid(), outer: ring, holes: [], angleDeg: null, color: { ...color } });
    return;
  }
  if (tool === "ellipse" || tool === "rect") {
    const a = g.start;
    const b = g.cur;
    if (Math.abs(b.x - a.x) < 1 || Math.abs(b.y - a.y) < 1) return toast("ドラッグして大きさを決めてください");
    const ring = shapeRing(tool, a, b);
    if (shapeFill) {
      addElement(layer, { kind: "fill", id: uid(), outer: ring, holes: [], angleDeg: null, color: { ...color } });
    } else {
      addElement(layer, {
        kind: "stroke",
        id: uid(),
        points: ring,
        closed: true,
        width: penWidth,
        style: "auto",
        color: { ...color },
      });
    }
    return;
  }
  if (tool === "bucket") {
    const strokes: StrokeEl[] = [];
    for (const l of doc.layers) {
      if (!l.visible) continue;
      for (const el of l.elements) if (el.kind === "stroke") strokes.push(el);
    }
    const r = bucketFill(strokes, g.cur, { gapCloseMm: gapClose });
    if (!r.ok) {
      toast(
        r.reason === "on-line"
          ? "線の上ではなく、線で囲まれた内側をタップしてください"
          : r.reason === "open"
            ? "囲みが閉じていないため塗れません (線をつなげるか「隙間を閉じる」を大きく)"
            : "小さすぎて塗れません",
      );
      return;
    }
    addElement(layer, { kind: "fill", id: uid(), outer: r.outer, holes: r.holes, angleDeg: null, color: { ...color } });
  }
}

function shapeRing(t: "ellipse" | "rect", a: Vec, b: Vec): Vec[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  if (t === "rect") {
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  const n = Math.max(24, Math.min(120, Math.round((rx + ry) * 2)));
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const t2 = (i / n) * Math.PI * 2;
    out.push({ x: cx + rx * Math.cos(t2), y: cy + ry * Math.sin(t2) });
  }
  return out;
}

function addElement(layer: Layer, el: Element): void {
  beginChange();
  layer.elements.push(el);
  pushRecent(el.color);
  changed();
}

function translateElement(el: Element, dx: number, dy: number): void {
  const mv = (v: Vec) => ({ x: v.x + dx, y: v.y + dy });
  if (el.kind === "stroke") el.points = el.points.map(mv);
  else {
    el.outer = el.outer.map(mv);
    el.holes = el.holes.map((h) => h.map(mv));
  }
}

function hitTest(m: Vec, anyLayer: boolean): { el: Element; layer: Layer } | null {
  const tol = 10 / view.scale;
  const layers = anyLayer ? [...doc.layers].reverse() : [activeLayer()];
  for (const layer of layers) {
    if (!layer.visible) continue;
    for (let i = layer.elements.length - 1; i >= 0; i--) {
      const el = layer.elements[i];
      if (el.kind === "stroke") {
        if (distToPolyline(m, el.points, el.closed) <= el.width / 2 + tol) return { el, layer };
      } else if (pointInShape(m, el.outer, el.holes) || distToPolyline(m, el.outer, true) <= tol) {
        return { el, layer };
      }
    }
  }
  return null;
}

function eraseAt(m: Vec, g: Extract<Gesture, { kind: "erase" }>): void {
  const hit = hitTest(m, false);
  if (!hit) return;
  if (!g.changedAny) beginChange();
  g.changedAny = true;
  hit.layer.elements = hit.layer.elements.filter((e) => e !== hit.el);
  if (selectedId === hit.el.id) selectedId = null;
  docVersion++;
  requestDraw();
}

function deleteSelected(): void {
  if (!selectedId) return;
  const f = findElement(selectedId);
  if (!f) return;
  if (f.layer.locked) return toast("ロック中のレイヤーです");
  beginChange();
  f.layer.elements = f.layer.elements.filter((e) => e.id !== selectedId);
  selectedId = null;
  changed();
}

function drawGesturePreview(px: number): void {
  if (!gesture || gesture.kind !== "draw") return;
  const g = gesture;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (tool === "pen" || tool === "lasso") {
    ctx.beginPath();
    g.raw.forEach((v, i) => (i === 0 ? ctx.moveTo(v.x, v.y) : ctx.lineTo(v.x, v.y)));
    if (tool === "lasso") {
      ctx.closePath();
      ctx.fillStyle = rgb(color, 0.5);
      ctx.fill();
      ctx.strokeStyle = rgb(color);
      ctx.lineWidth = 1.5 * px;
    } else {
      ctx.strokeStyle = rgb(color);
      ctx.lineWidth = Math.max(penWidth, 1.2 * px);
    }
    ctx.stroke();
  } else if (tool === "ellipse" || tool === "rect") {
    const ring = shapeRing(tool, g.start, g.cur);
    ctx.beginPath();
    ring.forEach((v, i) => (i === 0 ? ctx.moveTo(v.x, v.y) : ctx.lineTo(v.x, v.y)));
    ctx.closePath();
    if (shapeFill) {
      ctx.fillStyle = rgb(color, 0.6);
      ctx.fill();
    } else {
      ctx.strokeStyle = rgb(color);
      ctx.lineWidth = penWidth;
      ctx.stroke();
    }
  }
  ctx.restore();
  if (selectedId && move.active) {
    const f = findElement(selectedId);
    if (f) drawElement(f.el, 0.5, px, { x: move.dx, y: move.dy });
  }
}

// ------------------------------------------------------------------ ツールバー

function setTool(t: Tool): void {
  tool = t;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#tools [data-tool]")) {
    b.classList.toggle("on", b.dataset.tool === t);
  }
  if (t !== "select") selectedId = null;
  if (mode === "stitch") setMode("draw");
  renderToolOpts();
  renderPanels();
  requestDraw();
}
for (const b of document.querySelectorAll<HTMLButtonElement>("#tools [data-tool]")) {
  b.addEventListener("click", () => setTool(b.dataset.tool as Tool));
}
$("fitBtn").addEventListener("click", fit);

function styleName(w: number): string {
  const s = resolveStrokeStyle({ kind: "stroke", id: "", points: [], closed: false, width: w, style: "auto", color });
  return s === "running" ? "ランニング (細線)" : s === "triple" ? "3重ぬい (くっきり線)" : "サテン (太い線)";
}

function renderToolOpts(): void {
  const box = $("toolOpts");
  box.innerHTML = "";
  if (mode === "stitch") return;
  const widthCtl = () => {
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.gap = "10px";
    wrap.style.alignItems = "center";
    wrap.innerHTML = `<label>太さ <input type="range" min="0.4" max="7" step="0.1" value="${penWidth}"><span class="val">${penWidth.toFixed(1)}mm</span></label><span class="presetRow"></span><small class="styleNm" style="color:#7b8394">${styleName(penWidth)}</small>`;
    const range = wrap.querySelector("input")!;
    const val = wrap.querySelector(".val")!;
    const nm = wrap.querySelector(".styleNm")!;
    const presets = wrap.querySelector(".presetRow")!;
    const sync = () => {
      val.textContent = `${penWidth.toFixed(1)}mm`;
      nm.textContent = styleName(penWidth);
      range.value = String(penWidth);
      for (const pb of presets.querySelectorAll("button")) pb.classList.toggle("on", Number(pb.dataset.w) === penWidth);
    };
    for (const w of [0.5, 1.0, 2, 3, 5]) {
      const pb = document.createElement("button");
      pb.textContent = `${w}`;
      pb.dataset.w = String(w);
      pb.addEventListener("click", () => {
        penWidth = w;
        sync();
      });
      presets.appendChild(pb);
    }
    range.addEventListener("input", () => {
      penWidth = Math.round(Number(range.value) * 10) / 10;
      sync();
    });
    sync();
    return wrap;
  };
  const tip = (t: string) => {
    const s = document.createElement("span");
    s.style.fontSize = "13px";
    s.style.color = "#7b8394";
    s.textContent = t;
    return s;
  };
  if (tool === "pen") box.append(widthCtl());
  else if (tool === "bucket") {
    const wrap = document.createElement("label");
    wrap.innerHTML = `隙間を閉じる <input type="range" min="0" max="3" step="0.25" value="${gapClose}"><span class="val">${gapClose.toFixed(2)}mm</span>`;
    const r = wrap.querySelector("input")!;
    r.addEventListener("input", () => {
      gapClose = Number(r.value);
      wrap.querySelector(".val")!.textContent = `${gapClose.toFixed(2)}mm`;
    });
    box.append(tip("線で囲まれた内側をタップすると塗ります"), wrap);
  } else if (tool === "lasso") box.append(tip("塗りたい形をぐるっと囲んでください"));
  else if (tool === "ellipse" || tool === "rect") {
    const seg = document.createElement("span");
    seg.className = "presetRow";
    for (const [v, label] of [
      [true, "塗り"],
      [false, "線"],
    ] as const) {
      const b = document.createElement("button");
      b.textContent = label;
      b.classList.toggle("on", shapeFill === v);
      b.addEventListener("click", () => {
        shapeFill = v;
        renderToolOpts();
      });
      seg.appendChild(b);
    }
    box.append(seg);
    if (!shapeFill) box.append(widthCtl());
  } else if (tool === "select") box.append(tip("タップで選択、ドラッグで移動。右のパネルで色や太さを変えられます"));
  else if (tool === "eraser") box.append(tip(`なぞった線・面を消します (レイヤー「${activeLayer().name}」)`));
}

// ------------------------------------------------------------------ 色

function pushRecent(c: ThreadRef): void {
  recent = [c, ...recent.filter((r) => !(r.r === c.r && r.g === c.g && r.b === c.b))].slice(0, 8);
}

function setColor(c: ThreadRef): void {
  color = { ...c };
  $("colorSwatch").style.background = rgb(color);
  if (selectedId) {
    const f = findElement(selectedId);
    if (f && !f.layer.locked) {
      beginChange();
      f.el.color = { ...color };
      changed();
    }
  }
  renderPalette();
}

function renderPalette(): void {
  const mk = (c: ThreadRef) => {
    const b = document.createElement("button");
    b.style.background = rgb(c);
    b.title = `${c.name ?? ""} (#${c.pecIndex ?? ""})`;
    b.classList.toggle("on", c.r === color.r && c.g === color.g && c.b === color.b);
    b.addEventListener("click", () => {
      setColor(c);
      pushRecent(c);
      renderPalette();
    });
    return b;
  };
  $("recent").replaceChildren(...recent.map(mk));
  $("paletteGrid").replaceChildren(...palette.map(mk));
}
$("colorBtn").addEventListener("click", () => {
  renderPalette();
  $("palette").hidden = !$("palette").hidden;
});
$("paletteClose").addEventListener("click", () => ($("palette").hidden = true));

// ------------------------------------------------------------------ モード

function setMode(m: Mode): void {
  mode = m;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#modeSeg button")) {
    b.classList.toggle("on", b.dataset.mode === m);
  }
  $("player").hidden = m !== "stitch";
  if (m === "stitch") {
    ensureCompiled();
    playerPos = flat.length;
    $<HTMLInputElement>("seek").value = String(playerPos);
  } else {
    playing = false;
    $("play").textContent = "▶";
  }
  renderToolOpts();
  requestDraw();
}
for (const b of document.querySelectorAll<HTMLButtonElement>("#modeSeg button")) {
  b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
}

$("seek").addEventListener("input", () => {
  playerPos = Number($<HTMLInputElement>("seek").value);
  requestDraw();
});
$("showJumps").addEventListener("change", requestDraw);
$("play").addEventListener("click", () => {
  playing = !playing;
  $("play").textContent = playing ? "⏸" : "▶";
  if (playing) {
    if (playerPos >= flat.length) playerPos = 0;
    tick();
  }
});
function tick(): void {
  if (!playing) return;
  playerPos = Math.min(flat.length, playerPos + Math.max(4, Math.round(flat.length / 600)));
  $<HTMLInputElement>("seek").value = String(playerPos);
  draw();
  if (playerPos >= flat.length) {
    playing = false;
    $("play").textContent = "▶";
    return;
  }
  requestAnimationFrame(tick);
}
function jumpEvent(dir: 1 | -1): void {
  let i = playerPos + dir;
  while (i > 0 && i < flat.length && flat[i].move < 2) i += dir;
  playerPos = Math.max(0, Math.min(flat.length, i + (dir > 0 ? 1 : 0)));
  $<HTMLInputElement>("seek").value = String(playerPos);
  requestDraw();
}
$("prevTrim").addEventListener("click", () => jumpEvent(-1));
$("nextTrim").addEventListener("click", () => jumpEvent(1));

// ------------------------------------------------------------------ パネル

for (const b of document.querySelectorAll<HTMLButtonElement>("#tabs button")) {
  b.addEventListener("click", () => {
    for (const x of document.querySelectorAll<HTMLButtonElement>("#tabs button")) x.classList.toggle("on", x === b);
    for (const t of ["layers", "seq", "settings"]) $(`tab-${t}`).hidden = t !== b.dataset.tab;
    renderPanels();
  });
}

function renderPanels(): void {
  renderLayers();
  renderSeq();
  renderSelBox();
}

function layerStitchCounts(): Map<string, number> {
  const m = new Map<string, number>();
  if (compiled && compiledVersion === docVersion) {
    for (const q of compiled.seq) m.set(q.layerId, (m.get(q.layerId) ?? 0) + q.stitches);
  }
  return m;
}

function renderLayers(): void {
  const list = $("layerList");
  const counts = layerStitchCounts();
  const items: HTMLElement[] = [];
  const n = doc.layers.length;
  // 一番上のレイヤーを一番上に表示。番号は縫う順
  for (let i = n - 1; i >= 0; i--) {
    const layer = doc.layers[i];
    const li = document.createElement("li");
    if (layer.id === activeLayerId) li.classList.add("active");
    if (!layer.visible) li.classList.add("hiddenL");
    const lines = layer.elements.filter((e) => e.kind === "stroke").length;
    const fills = layer.elements.length - lines;
    const st = counts.get(layer.id);
    li.innerHTML = `<span class="ord" title="縫う順番">${i + 1}</span>`;
    const eye = document.createElement("button");
    eye.textContent = layer.visible ? "👁" : "⦸";
    eye.title = "表示/非表示 (非表示は縫いません)";
    eye.addEventListener("click", (ev) => {
      ev.stopPropagation();
      beginChange();
      layer.visible = !layer.visible;
      changed();
    });
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.innerHTML = `${escapeHtml(layer.name)}<small>線${lines}・面${fills}${st !== undefined ? `・${st.toLocaleString()}針` : ""}</small>`;
    nm.addEventListener("dblclick", () => renameLayer(layer));
    const ord = document.createElement("button");
    ord.className = "ordBtn";
    ord.textContent = layer.order === "auto" ? "自動順" : "描いた順";
    ord.title = "レイヤー内の縫い順: 自動 (同じ色をまとめ近い順) / 描いた順";
    ord.addEventListener("click", (ev) => {
      ev.stopPropagation();
      beginChange();
      layer.order = layer.order === "auto" ? "manual" : "auto";
      changed();
    });
    const lock = document.createElement("button");
    lock.textContent = layer.locked ? "🔒" : "🔓";
    lock.title = "ロック";
    lock.addEventListener("click", (ev) => {
      ev.stopPropagation();
      beginChange();
      layer.locked = !layer.locked;
      changed();
    });
    li.append(eye, nm, ord, lock);
    li.addEventListener("click", () => {
      activeLayerId = layer.id;
      renderLayers();
      renderToolOpts();
    });
    items.push(li);
  }
  list.replaceChildren(...items);
}

function renameLayer(layer: Layer): void {
  const name = prompt("レイヤー名", layer.name);
  if (!name) return;
  beginChange();
  layer.name = name.slice(0, 20);
  changed();
}

$("addLayer").addEventListener("click", () => {
  beginChange();
  const idx = doc.layers.findIndex((l) => l.id === activeLayerId);
  const l = newLayer(`レイヤー${doc.layers.length + 1}`);
  doc.layers.splice(idx + 1, 0, l);
  activeLayerId = l.id;
  changed();
});
$("layerUp").addEventListener("click", () => moveLayer(1));
$("layerDown").addEventListener("click", () => moveLayer(-1));
function moveLayer(delta: number): void {
  const i = doc.layers.findIndex((l) => l.id === activeLayerId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= doc.layers.length) return;
  beginChange();
  [doc.layers[i], doc.layers[j]] = [doc.layers[j], doc.layers[i]];
  changed();
}
$("delLayer").addEventListener("click", () => {
  if (doc.layers.length <= 1) return toast("最後のレイヤーは削除できません");
  const l = activeLayer();
  if (l.elements.length > 0 && !confirm(`レイヤー「${l.name}」を削除しますか？ (${l.elements.length}個の線・面も消えます)`)) return;
  beginChange();
  doc.layers = doc.layers.filter((x) => x.id !== l.id);
  ensureActiveLayer();
  changed();
});

function joinBadge(q: SeqItem): string {
  switch (q.join) {
    case "walk":
      return `<span class="j walk">つなぎ</span>`;
    case "jump":
      return `<span class="j jump">渡り ${q.joinMm}mm</span>`;
    case "trim":
      return `<span class="j trim">✂ ${q.joinMm}mm</span>`;
    case "color":
      return `<span class="j color">色替え</span>`;
    default:
      return `<span class="j start">開始</span>`;
  }
}

function renderSeq(): void {
  if ($("tab-seq").hidden) return;
  const list = $("seqList");
  if (!compiled || compiledVersion !== docVersion) {
    list.innerHTML = `<li class="note">計算中…</li>`;
    return;
  }
  const items: HTMLElement[] = [];
  compiled.seq.forEach((q, i) => {
    if (q.join === "color" || q.join === "start") {
      const h = document.createElement("li");
      h.className = "seqColor";
      h.innerHTML = `<span class="sw" style="background:${rgb(q.color)}"></span>${escapeHtml(q.color.name ?? "")} ${q.color.pecIndex ? `#${q.color.pecIndex}` : ""}`;
      items.push(h);
    }
    const li = document.createElement("li");
    if (q.elementId === seqSelected) li.classList.add("sel");
    li.innerHTML = `<span class="n">${i + 1}</span><span class="sw" style="background:${rgb(q.color)}"></span><span class="lb">${q.kind === "fill" ? "面" : "線"} ${q.styleLabel}<br><small>${escapeHtml(q.layerName)}・${q.stitches.toLocaleString()}針</small></span>${joinBadge(q)}`;
    const up = document.createElement("button");
    up.textContent = "↑";
    up.title = "同じレイヤー内で前へ";
    up.addEventListener("click", (ev) => {
      ev.stopPropagation();
      reorderInLayer(q, -1);
    });
    const down = document.createElement("button");
    down.textContent = "↓";
    down.title = "同じレイヤー内で後ろへ";
    down.addEventListener("click", (ev) => {
      ev.stopPropagation();
      reorderInLayer(q, 1);
    });
    li.append(up, down);
    li.addEventListener("click", () => {
      seqSelected = seqSelected === q.elementId ? null : q.elementId;
      selectedId = seqSelected;
      renderSeq();
      renderSelBox();
      requestDraw();
    });
    items.push(li);
  });
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "note";
    li.textContent = "まだ何も描かれていません";
    items.push(li);
  }
  list.replaceChildren(...items);
}

/** 縫い順の ↑↓: 現在の縫い順をそのまま「描いた順」に固定してから入れ替える */
function reorderInLayer(q: SeqItem, delta: number): void {
  if (!compiled) return;
  const layer = doc.layers.find((l) => l.id === q.layerId);
  if (!layer) return;
  const sewnIds = compiled.seq.filter((s) => s.layerId === layer.id).map((s) => s.elementId);
  const i = sewnIds.indexOf(q.elementId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= sewnIds.length) return toast("レイヤーをまたぐ順番は、レイヤーの並びで変えてください");
  beginChange();
  [sewnIds[i], sewnIds[j]] = [sewnIds[j], sewnIds[i]];
  const byId = new Map(layer.elements.map((e) => [e.id, e]));
  const rest = layer.elements.filter((e) => !sewnIds.includes(e.id));
  layer.elements = [...sewnIds.map((id) => byId.get(id)!).filter(Boolean), ...rest];
  if (layer.order === "auto") {
    layer.order = "manual";
    toast(`レイヤー「${layer.name}」を「描いた順」に切り替えました`);
  }
  seqSelected = q.elementId;
  changed();
}

function renderSelBox(): void {
  const box = $("selBox");
  const f = selectedId ? findElement(selectedId) : null;
  if (!f) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const el = f.el;
  const layerOpts = doc.layers
    .map((l) => `<option value="${l.id}" ${l.id === f.layer.id ? "selected" : ""}>${escapeHtml(l.name)}</option>`)
    .join("");
  let body = `<h4>選択中: ${el.kind === "fill" ? "面" : "線"} <span class="sw" style="display:inline-block;width:14px;height:14px;border-radius:4px;vertical-align:middle;background:${rgb(el.color)}"></span></h4>`;
  if (el.kind === "stroke") {
    body += `<label>太さ (mm) <input id="selW" type="number" min="0.4" max="7" step="0.1" value="${el.width}"></label>`;
    body += `<label>縫い方 <select id="selStyle">${(
      [
        ["auto", "自動"],
        ["running", "ランニング"],
        ["triple", "3重ぬい"],
        ["satin", "サテン"],
      ] as [StrokeStyle, string][]
    )
      .map(([v, l]) => `<option value="${v}" ${el.style === v ? "selected" : ""}>${l}</option>`)
      .join("")}</select></label>`;
  } else {
    body += `<label>縫い角度 <select id="selAngle">${[["", "標準"], ["0", "0°"], ["45", "45°"], ["90", "90°"], ["135", "135°"]]
      .map(([v, l]) => `<option value="${v}" ${String(el.angleDeg ?? "") === v ? "selected" : ""}>${l}</option>`)
      .join("")}</select></label>`;
  }
  body += `<label>レイヤー <select id="selLayer">${layerOpts}</select></label>`;
  body += `<div class="row"><button id="selColor">いまの色に変える</button><button id="selDel" class="mini danger">削除</button></div>`;
  box.innerHTML = body;

  const edit = (fn: () => void) => {
    if (f.layer.locked) return toast("ロック中のレイヤーです");
    beginChange();
    fn();
    changed();
  };
  box.querySelector<HTMLInputElement>("#selW")?.addEventListener("change", (e) => {
    const v = Math.min(7, Math.max(0.4, Number((e.target as HTMLInputElement).value) || 1));
    edit(() => ((el as StrokeEl).width = v));
  });
  box.querySelector<HTMLSelectElement>("#selStyle")?.addEventListener("change", (e) => {
    edit(() => ((el as StrokeEl).style = (e.target as HTMLSelectElement).value as StrokeStyle));
  });
  box.querySelector<HTMLSelectElement>("#selAngle")?.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    edit(() => ((el as FillEl).angleDeg = v === "" ? null : Number(v)));
  });
  box.querySelector<HTMLSelectElement>("#selLayer")?.addEventListener("change", (e) => {
    const to = doc.layers.find((l) => l.id === (e.target as HTMLSelectElement).value);
    if (!to || to === f.layer) return;
    edit(() => {
      f.layer.elements = f.layer.elements.filter((x) => x !== el);
      to.elements.push(el);
      activeLayerId = to.id;
    });
  });
  box.querySelector("#selColor")?.addEventListener("click", () => edit(() => (el.color = { ...color })));
  box.querySelector("#selDel")?.addEventListener("click", deleteSelected);
}

// ------------------------------------------------------------------ 統計

function renderChips(): void {
  const c = $("chips");
  if (!compiled || compiled.stats.stitches === 0) {
    c.innerHTML = `<span>描いた線・面がそのまま刺繍になります</span>`;
    return;
  }
  const s = compiled.stats;
  const over = s.stitches > STITCH_LIMIT;
  const tooBig = s.widthMm > 100 || s.heightMm > 100;
  c.innerHTML =
    `<span class="${over ? "bad" : ""}">針数 <b>${s.stitches.toLocaleString()}</b>${over ? " (上限超過)" : ""}</span>` +
    `<span>色 <b>${s.colors}</b></span>` +
    `<span>糸切り <b>${s.trims}</b></span>` +
    `<span>渡り糸 <b>${s.jumps}</b></span>` +
    `<span class="${tooBig ? "bad" : ""}">サイズ <b>${s.widthMm.toFixed(0)}×${s.heightMm.toFixed(0)}mm</b></span>` +
    `<span>約 <b>${Math.max(1, Math.round(s.minutes))}</b> 分</span>`;
}

// ------------------------------------------------------------------ 設定

const DENSITY = {
  dense: { fill: 0.35, satin: 0.33 },
  normal: { fill: 0.4, satin: 0.38 },
  light: { fill: 0.5, satin: 0.45 },
} as const;

function syncSettings(): void {
  const s = doc.settings;
  $<HTMLInputElement>("setName").value = s.name;
  $<HTMLSelectElement>("setTrim").value = s.trimPolicy;
  $<HTMLInputElement>("setTrimDist").value = String(s.trimDistance);
  $<HTMLInputElement>("setAngle").value = String(s.fillAngle);
  $<HTMLInputElement>("setUnderlay").checked = s.underlay;
  $<HTMLInputElement>("setPenOnly").checked = penOnly;
  $<HTMLInputElement>("underlayShow").checked = s.underlayVisible;
  $<HTMLInputElement>("underlayOpacity").value = String(s.underlayOpacity);
  const dens = s.fillSpacing <= 0.36 ? "dense" : s.fillSpacing >= 0.48 ? "light" : "normal";
  $<HTMLSelectElement>("setDensity").value = dens;
}

function bindSetting(id: string, apply: (el: HTMLInputElement & HTMLSelectElement) => void): void {
  $(id).addEventListener("change", (e) => {
    beginChange();
    apply(e.target as HTMLInputElement & HTMLSelectElement);
    changed();
  });
}
bindSetting("setName", (el) => (doc.settings.name = el.value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "SKETCH"));
bindSetting("setTrim", (el) => (doc.settings.trimPolicy = el.value as SketchDoc["settings"]["trimPolicy"]));
bindSetting("setTrimDist", (el) => (doc.settings.trimDistance = Math.min(60, Math.max(3, Number(el.value) || 10))));
bindSetting("setAngle", (el) => (doc.settings.fillAngle = ((Number(el.value) % 180) + 180) % 180));
bindSetting("setUnderlay", (el) => (doc.settings.underlay = el.checked));
bindSetting("setDensity", (el) => {
  const d = DENSITY[el.value as keyof typeof DENSITY] ?? DENSITY.normal;
  doc.settings.fillSpacing = d.fill;
  doc.settings.satinSpacing = d.satin;
});
bindSetting("underlayShow", (el) => (doc.settings.underlayVisible = el.checked));
$("underlayOpacity").addEventListener("input", (e) => {
  doc.settings.underlayOpacity = Number((e.target as HTMLInputElement).value);
  scheduleSave();
  requestDraw();
});
$("setPenOnly").addEventListener("change", (e) => {
  penOnly = (e.target as HTMLInputElement).checked;
  prefs.penOnlyDecided = true;
  savePrefs();
});

$("underlayLoad").addEventListener("click", () => $<HTMLInputElement>("underlayFile").click());
$("underlayFile").addEventListener("change", () => {
  const file = $<HTMLInputElement>("underlayFile").files?.[0];
  if (!file) return;
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    // 保存容量を抑えるため縮小して JPEG に
    const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    beginChange();
    doc.settings.underlayImage = c.toDataURL("image/jpeg", 0.85);
    doc.settings.underlayVisible = true;
    syncSettings();
    changed();
    toast("下絵を読み込みました。なぞって描いてください (下絵は刺繍されません)");
  };
  img.src = url;
  $<HTMLInputElement>("underlayFile").value = "";
});
$("underlayClear").addEventListener("click", () => {
  beginChange();
  doc.settings.underlayImage = null;
  changed();
});

// ------------------------------------------------------------------ 書き出し

const isTouchDevice =
  /iPad|iPhone|iPod|Android/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

async function shareOrDownload(data: Uint8Array | string, filename: string, mime: string): Promise<void> {
  const blob = new Blob([typeof data === "string" ? data : (data.buffer as ArrayBuffer)], { type: mime });
  if (isTouchDevice && typeof navigator.share === "function") {
    try {
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
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
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(`${filename} を保存しました`);
}

function checkBeforeExport(): CompileResult | null {
  const res = ensureCompiled();
  if (res.stats.stitches === 0) {
    toast("まだ何も描かれていません");
    return null;
  }
  const v = validatePlan(res.plan);
  const problems = v.issues.filter((i) => i.severity === "error").map((i) => `・${i.message}`);
  if (res.stats.stitches > STITCH_LIMIT) problems.push(`・針数 ${res.stats.stitches.toLocaleString()} が PP1 の目安 ${STITCH_LIMIT.toLocaleString()} を超えています`);
  if (problems.length > 0 && !confirm(`次の問題があります:\n${[...new Set(problems)].join("\n")}\n\nこのまま保存しますか？`)) return null;
  return res;
}

function exportPes(): void {
  const res = checkBeforeExport();
  if (!res) return;
  void shareOrDownload(writePes(res.plan).data, `${doc.settings.name || "SKETCH"}.pes`, "application/octet-stream");
}
function exportDst(): void {
  const res = checkBeforeExport();
  if (!res) return;
  void shareOrDownload(writeDst(res.plan), `${doc.settings.name || "SKETCH"}.dst`, "application/octet-stream");
}
$("exportBtn").addEventListener("click", exportPes);
$("mExportPes").addEventListener("click", () => {
  $("menu").hidden = true;
  exportPes();
});
$("mExportDst").addEventListener("click", () => {
  $("menu").hidden = true;
  exportDst();
});
$("menuBtn").addEventListener("click", () => ($("menu").hidden = !$("menu").hidden));
$("mSave").addEventListener("click", () => {
  $("menu").hidden = true;
  void shareOrDownload(JSON.stringify(doc), `${doc.settings.name || "SKETCH"}.pp1sketch.json`, "application/json");
});
$("mOpen").addEventListener("click", () => {
  $("menu").hidden = true;
  $<HTMLInputElement>("openFile").click();
});
$("openFile").addEventListener("change", () => {
  const file = $<HTMLInputElement>("openFile").files?.[0];
  if (!file) return;
  file.text().then((t) => {
    try {
      const d = parseDoc(t);
      beginChange();
      doc = d;
      activeLayerId = doc.layers[doc.layers.length - 1].id;
      selectedId = null;
      syncSettings();
      changed();
      toast("作品を開きました");
    } catch (err) {
      toast(String((err as Error).message ?? err));
    }
  });
  $<HTMLInputElement>("openFile").value = "";
});
$("mNew").addEventListener("click", () => {
  $("menu").hidden = true;
  if (!confirm("いまの絵を消して新しく描きますか？ (取り消しで戻せます)")) return;
  beginChange();
  doc = newDoc();
  activeLayerId = doc.layers[doc.layers.length - 1].id;
  selectedId = null;
  syncSettings();
  changed();
});

// ポップオーバーの外をタップしたら閉じる
document.addEventListener("pointerdown", (e) => {
  const t = e.target as HTMLElement;
  if (!$("menu").hidden && !t.closest("#menu") && !t.closest("#menuBtn")) $("menu").hidden = true;
  if (!$("palette").hidden && !t.closest("#palette") && !t.closest("#colorBtn")) $("palette").hidden = true;
});

// ------------------------------------------------------------------ その他

let toastTimer = 0;
function toast(msg: string): void {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2600);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);

// 初期化
$("colorSwatch").style.background = rgb(color);
syncSettings();
renderToolOpts();
renderPanels();
scheduleCompile();
resize();

// テスト・デバッグ用 (コンソールから状態を確認できる)
(window as unknown as { __sketch: unknown }).__sketch = {
  get doc() {
    return doc;
  },
  compile: () => ensureCompiled(),
  cloneDoc: () => cloneDoc(doc),
};
