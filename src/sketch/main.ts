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
  cloneElement,
  decimate,
  deleteNodes,
  duplicateElements,
  elementBox,
  flipElement,
  getNode,
  insertNode,
  mapElement,
  nearestNode,
  nearestSegment,
  nodeCount,
  nodeKey,
  paths,
  rotateElement,
  scaleFn,
  selectionBox,
  softMoveNodes,
  subdivide,
  translateFn,
  type Box,
  type NodeRef,
} from "./edit";
import { getBitmap, getImageData, loadStoredImages, putImage, readImageFile, removeUnusedImages } from "./images";
import {
  cloneDoc,
  imageCorners,
  isStitchEl,
  newDoc,
  newLayer,
  parseDoc,
  parseDocWithImages,
  PP1_HOOP_MM,
  type ImageEl,
  type StitchEl,
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

const SKETCH_VERSION = "1.2.0";
const STITCH_LIMIT = 12000;
const SAVE_KEY = "pp1-sketch:doc";
const UNDERLAY_KEY = "pp1-sketch:underlay";
const PREF_KEY = "pp1-sketch:prefs";
const CLIP_KEY = "pp1-sketch:clipboard";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
$("ver").textContent = `v${SKETCH_VERSION}`;

type Tool = "pen" | "bucket" | "lasso" | "ellipse" | "rect" | "select" | "node" | "eraser";
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
/** 選択中の部品 (id) */
let selection: string[] = [];
let seqSelected: string | null = null;
/** 追加選択モード (タップで選択に足す/外す) */
let additive = false;
/** 拡大縮小で線の太さも変える */
let scaleWidth = false;
/** 編集点ツール: 対象の部品と、選択中の点 */
let nodeTarget: string | null = null;
let nodeSel: NodeRef[] = [];
/** やわらか変形の範囲 (mm, 0 = 選んだ点だけ) */
let softRadius = 6;
let clipboard: Element[] = loadClipboard();
let pasteCount = 0;

const prefs = loadPrefs();
let penOnly = prefs.penOnly ?? false;
let panelOpen = prefs.panelOpen ?? window.innerWidth >= 1400;

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

function loadClipboard(): Element[] {
  try {
    const v = JSON.parse(localStorage.getItem(CLIP_KEY) ?? "[]");
    return Array.isArray(v) ? (v as Element[]) : [];
  } catch {
    return [];
  }
}

function loadPrefs(): { penOnly?: boolean; penOnlyDecided?: boolean; panelOpen?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function savePrefs(): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ penOnly, penOnlyDecided: prefs.penOnlyDecided, panelOpen }));
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
  pruneSelection();
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
  pruneSelection();
  changed();
  toast("取り消しました");
}
function redo(): void {
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push(snapshot());
  doc = parseDoc(s);
  ensureActiveLayer();
  pruneSelection();
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

/** 部品を同じ id の新しい部品に差し替える */
function replaceElement(el: Element): void {
  for (const layer of doc.layers) {
    const i = layer.elements.findIndex((e) => e.id === el.id);
    if (i >= 0) {
      layer.elements[i] = el;
      return;
    }
  }
}

/** 選択中の部品 (レイヤーの順・描いた順に並べる) */
function selectedEls(): { el: Element; layer: Layer }[] {
  const set = new Set(selection);
  const out: { el: Element; layer: Layer }[] = [];
  for (const layer of doc.layers) for (const el of layer.elements) if (set.has(el.id)) out.push({ el, layer });
  return out;
}

/** 消えた部品やロックされた部品を選択から外す */
function pruneSelection(): void {
  selection = selection.filter((id) => {
    const f = findElement(id);
    return f && f.layer.visible && !f.layer.locked;
  });
  if (nodeTarget && !findElement(nodeTarget)) {
    nodeTarget = null;
    nodeSel = [];
  }
  if (nodeTarget) {
    const el = findElement(nodeTarget)!.el;
    const ps = paths(el);
    nodeSel = nodeSel.filter((r) => r.index < (ps[r.ring]?.pts.length ?? 0));
  }
}

function setSelection(ids: string[]): void {
  selection = [...new Set(ids)];
  seqSelected = selection.length === 1 ? selection[0] : null;
  // 選んだ部品のレイヤーを「描くレイヤー」にする (画像だけのレイヤーは除く: 下敷きに描き込まないため)
  const first = selection.length ? findElement(selection[selection.length - 1]) : null;
  if (first && first.el.kind !== "image") activeLayerId = first.layer.id;
  renderToolOpts();
  renderPanels();
  requestDraw();
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
/** ユーザーが拡大・移動したら、画面サイズが変わっても勝手に全体表示し直さない */
let viewTouched = false;

/**
 * 刺繍枠 (100mm) を画面いっぱいに表示する。
 * ツール設定は枠の外の余白 (横長なら左、縦長なら上) に置くので、余白が足りるときは場所を取らない。
 */
function fit(): void {
  // パネルを開いているときは、その分よける (狭い画面では重ねて表示し、枠は小さくしない)
  const pw = panelOpen ? $("panel").getBoundingClientRect().width : 0;
  const panelW = cv.clientWidth - pw >= 700 ? pw : 0;
  const bottom = mode === "stitch" ? 68 : 6;
  const w = Math.max(50, cv.clientWidth - panelW);
  const h = Math.max(50, cv.clientHeight - bottom - 6);
  const landscape = cv.clientWidth > cv.clientHeight;
  const cw = doc.settings.canvasW + 2;
  const ch = doc.settings.canvasH + 2;
  const base = Math.min(w / cw, h / ch);
  let scale = base;
  if (mode === "draw") {
    // ツール設定 (横長なら左、縦長なら上) の分の余白を空ける。
    // 余白が少し足りないだけならキャンバスを優先する (ツール設定が角に少しかかってもよい)
    if (landscape && (w - cw * scale) / 2 < 180) scale = Math.max(Math.min(h / ch, (w - 360) / cw), base * 0.94);
    if (!landscape && (h - ch * scale) / 2 < 64) scale = Math.max(Math.min(w / cw, (h - 128) / ch), base * 0.9);
  }
  view.scale = Math.max(0.5, scale);
  view.ox = w / 2;
  view.oy = 6 + h / 2;
  viewTouched = false;
  requestDraw();
}

let lastStage = { w: 0, h: 0 };
function resize(): void {
  dpr = window.devicePixelRatio || 1;
  const r = stage.getBoundingClientRect();
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  const big = Math.abs(r.width - lastStage.w) > 40 || Math.abs(r.height - lastStage.h) > 40;
  lastStage = { w: r.width, h: r.height };
  // 初回、または回転・全画面切り替えで大きさが変わったら、全体表示し直す
  if (!viewInit || (big && !viewTouched)) {
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

function draw(): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#e9ebef";
  ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight);
  // 以降は mm 座標で描く
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy);
  const px = 1 / view.scale; // 1 画面px の mm

  // キャンバス (刺繍する範囲)。中心が原点、10mm ごとの方眼
  const { canvasW: W, canvasH: H } = doc.settings;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(-W / 2, -H / 2, W, H);
  ctx.strokeStyle = "#eef0f3";
  ctx.lineWidth = px;
  ctx.beginPath();
  for (let v = Math.ceil(-W / 2 / 10 + 1e-9) * 10; v < W / 2; v += 10) {
    ctx.moveTo(v, -H / 2);
    ctx.lineTo(v, H / 2);
  }
  for (let v = Math.ceil(-H / 2 / 10 + 1e-9) * 10; v < H / 2; v += 10) {
    ctx.moveTo(-W / 2, v);
    ctx.lineTo(W / 2, v);
  }
  ctx.stroke();
  ctx.strokeStyle = "#d9a3ad";
  ctx.lineWidth = 2 * px;
  ctx.strokeRect(-W / 2, -H / 2, W, H);
  // キャンバスが PP1 の枠より大きいときは、枠の範囲を点線で示す
  if (W > PP1_HOOP_MM || H > PP1_HOOP_MM) {
    const hw = Math.min(W, PP1_HOOP_MM) / 2;
    const hh = Math.min(H, PP1_HOOP_MM) / 2;
    ctx.save();
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.strokeStyle = "#e8506a";
    ctx.lineWidth = 1.5 * px;
    ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
    ctx.restore();
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

function elementPath(el: StitchEl): Path2D {
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

/** 画像を3つの角 (p0 左上, p1 右上, p2 左下) に合わせて描く */
function drawImageEl(el: ImageEl, px: number): void {
  const img = getBitmap(el.imageId, requestDraw);
  const c = imageCorners(el);
  ctx.save();
  if (!img) {
    // 画像データがまだ無い (読み込み中・別の端末で作った作品など)
    ctx.beginPath();
    c.forEach((v, i) => (i === 0 ? ctx.moveTo(v.x, v.y) : ctx.lineTo(v.x, v.y)));
    ctx.closePath();
    ctx.fillStyle = "rgba(120,130,150,0.12)";
    ctx.fill();
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.strokeStyle = "#9aa3b2";
    ctx.lineWidth = px;
    ctx.stroke();
    ctx.restore();
    return;
  }
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  ctx.transform((el.p1.x - el.p0.x) / w, (el.p1.y - el.p0.y) / w, (el.p2.x - el.p0.x) / h, (el.p2.y - el.p0.y) / h, el.p0.x, el.p0.y);
  ctx.globalAlpha = Math.max(0.05, Math.min(1, el.opacity));
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function drawElement(el: Element, alpha: number, px: number, offset?: Vec): void {
  if (el.kind === "image") return drawImageEl(el, px);
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

type HandleName = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rot";

/** 選択枠のハンドル位置 (mm)。小さすぎる辺のハンドルは出さない */
function handlePositions(b: Box): { name: HandleName; p: Vec }[] {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const wPx = (b.maxX - b.minX) * view.scale;
  const hPx = (b.maxY - b.minY) * view.scale;
  const out: { name: HandleName; p: Vec }[] = [
    { name: "rot", p: { x: cx, y: b.minY - 34 / view.scale } },
    { name: "nw", p: { x: b.minX, y: b.minY } },
    { name: "ne", p: { x: b.maxX, y: b.minY } },
    { name: "se", p: { x: b.maxX, y: b.maxY } },
    { name: "sw", p: { x: b.minX, y: b.maxY } },
  ];
  if (wPx > 56) out.push({ name: "n", p: { x: cx, y: b.minY } }, { name: "s", p: { x: cx, y: b.maxY } });
  if (hPx > 56) out.push({ name: "e", p: { x: b.maxX, y: cy } }, { name: "w", p: { x: b.minX, y: cy } });
  return out;
}

/** 選択枠 (線の太さぶん+少し余白) */
function selBoxPadded(): Box | null {
  const b = selectionBox(selectedEls().map((f) => f.el));
  if (!b) return null;
  const pad = 4 / view.scale;
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

function drawSelection(px: number): void {
  ctx.save();
  if (tool === "node") drawNodes(px);
  else if (selection.length > 0) {
    const els = selectedEls();
    // 複数選択なら、それぞれの部品も薄く囲む
    if (els.length > 1) {
      ctx.strokeStyle = "rgba(47,111,236,0.45)";
      ctx.lineWidth = px;
      ctx.setLineDash([3 * px, 3 * px]);
      for (const f of els) {
        const e = elementBox(f.el);
        ctx.strokeRect(e.minX, e.minY, e.maxX - e.minX, e.maxY - e.minY);
      }
    }
    const b = selBoxPadded();
    if (b) {
      ctx.strokeStyle = "#2f6fec";
      ctx.lineWidth = 1.5 * px;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
      ctx.setLineDash([]);
      if (tool === "select") {
        const hs = handlePositions(b);
        const rot = hs.find((h) => h.name === "rot")!;
        ctx.beginPath();
        ctx.moveTo(rot.p.x, rot.p.y);
        ctx.lineTo(rot.p.x, b.minY);
        ctx.stroke();
        for (const h of hs) {
          ctx.fillStyle = "#fff";
          ctx.lineWidth = 2 * px;
          ctx.beginPath();
          if (h.name === "rot") ctx.arc(h.p.x, h.p.y, 9 * px, 0, Math.PI * 2);
          else ctx.rect(h.p.x - 6 * px, h.p.y - 6 * px, 12 * px, 12 * px);
          ctx.fill();
          ctx.stroke();
        }
        // 回転ハンドルの矢印
        ctx.beginPath();
        ctx.arc(rot.p.x, rot.p.y, 4.5 * px, -Math.PI * 0.9, Math.PI * 0.4);
        ctx.stroke();
      }
    }
  }
  // 範囲選択の四角
  if (gesture?.kind === "marquee") {
    const g = gesture;
    ctx.fillStyle = "rgba(47,111,236,0.08)";
    ctx.strokeStyle = "#2f6fec";
    ctx.lineWidth = px;
    ctx.setLineDash([4 * px, 3 * px]);
    const x = Math.min(g.start.x, g.cur.x);
    const y = Math.min(g.start.y, g.cur.y);
    ctx.fillRect(x, y, Math.abs(g.cur.x - g.start.x), Math.abs(g.cur.y - g.start.y));
    ctx.strokeRect(x, y, Math.abs(g.cur.x - g.start.x), Math.abs(g.cur.y - g.start.y));
  }
  ctx.restore();
  // 変形中の寸法・角度
  if (gesture && (gesture.kind === "xform" || gesture.kind === "node") && gesture.info) {
    const g = gesture;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sx = g.cur.x * view.scale + view.ox;
    const sy = g.cur.y * view.scale + view.oy;
    ctx.font = "600 13px -apple-system, sans-serif";
    const w = ctx.measureText(g.info).width + 14;
    const lx = Math.min(cv.clientWidth - w - 4, sx + 18);
    const ly = Math.max(4, sy - 44);
    ctx.fillStyle = "rgba(29,35,48,0.88)";
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(lx, ly, w, 24, 6);
    else ctx.rect(lx, ly, w, 24);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(g.info, lx + 7, ly + 16.5);
    ctx.restore();
  }
}

/** 編集点ツール: 対象の部品の輪郭と点を描く */
function drawNodes(px: number): void {
  const f = nodeTarget ? findElement(nodeTarget) : null;
  if (!f) return;
  const sel = new Set(nodeSel.map(nodeKey));
  ctx.strokeStyle = "#2f6fec";
  ctx.lineWidth = 1.2 * px;
  for (const path of paths(f.el)) {
    ctx.beginPath();
    path.pts.forEach((v, i) => (i === 0 ? ctx.moveTo(v.x, v.y) : ctx.lineTo(v.x, v.y)));
    if (path.closed) ctx.closePath();
    ctx.stroke();
  }
  // やわらか変形の範囲 (ドラッグ中)
  if (gesture?.kind === "node" && softRadius > 0 && gesture.grab) {
    ctx.save();
    ctx.strokeStyle = "rgba(232,80,106,0.5)";
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.beginPath();
    ctx.arc(gesture.grab.x, gesture.grab.y, softRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  paths(f.el).forEach((path, ring) => {
    path.pts.forEach((v, index) => {
      const on = sel.has(nodeKey({ ring, index }));
      const r = (on ? 5.5 : 4) * px;
      ctx.fillStyle = on ? "#e8506a" : "#fff";
      ctx.strokeStyle = on ? "#b8324a" : "#2f6fec";
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      if (index === 0 && !path.closed) ctx.arc(v.x, v.y, r * 1.2, 0, Math.PI * 2);
      else ctx.rect(v.x - r, v.y - r, r * 2, r * 2);
      ctx.fill();
      ctx.stroke();
    });
  });
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
  | {
      kind: "xform";
      id: number;
      op: "move" | "scale" | "rotate";
      handle: HandleName | null;
      start: Vec;
      cur: Vec;
      /** つかみ始めた時点の部品 (毎回ここから計算するので誤差がたまらない) */
      orig: Element[];
      box: Box;
      before: string;
      moved: boolean;
      /** 動かさずに離したら、この部品だけを選択し直す */
      tapId: string | null;
      info: string;
    }
  | { kind: "marquee"; id: number; start: Vec; cur: Vec; target: "elements" | "nodes"; base: string[]; baseNodes: NodeRef[] }
  | {
      kind: "node";
      id: number;
      start: Vec;
      cur: Vec;
      grab: Vec | null;
      orig: Element;
      refs: NodeRef[];
      before: string;
      moved: boolean;
      inserted: boolean;
      info: string;
    }
  | { kind: "erase"; id: number; changedAny: boolean };
let gesture: Gesture | null = null;

// 2本指/3本指タップの検出
let tap = { count: 0, t0: 0, moved: false };

/** 途中の変形を元に戻して、ジェスチャーをやめる */
function cancelGesture(): void {
  const g = gesture;
  gesture = null;
  if (g && (g.kind === "xform" || g.kind === "node") && g.moved) {
    doc = parseDoc(g.before);
    ensureActiveLayer();
    pruneSelection();
    renderPanels();
  }
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
      // 指で描きかけていた線・変形は取りやめてピンチへ
      if (gesture && gesture.kind !== "pan" && gesture.kind !== "pinch") cancelGesture();
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
      requestDraw();
      return;
    }
    // Pencil モードでは指は移動・拡大専用。ただし選択・編集点ツールは指でも操作できる
    if ((penOnly && tool !== "select" && tool !== "node") || mode === "stitch") {
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
  startTool(e.pointerId, toMm(p.x, p.y), e.shiftKey);
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
    viewTouched = true;
    requestDraw();
    return;
  }
  if (gesture.kind === "pan" && gesture.id === e.pointerId) {
    view.ox = gesture.ox0 + (p.x - gesture.sx);
    view.oy = gesture.oy0 + (p.y - gesture.sy);
    if (tap.moved) viewTouched = true;
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
  if (gesture.kind === "xform" && gesture.id === e.pointerId) {
    updateXform(gesture, toMm(p.x, p.y), e.shiftKey);
    return;
  }
  if (gesture.kind === "node" && gesture.id === e.pointerId) {
    updateNodeDrag(gesture, toMm(p.x, p.y));
    return;
  }
  if (gesture.kind === "marquee" && gesture.id === e.pointerId) {
    gesture.cur = toMm(p.x, p.y);
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
  } else if (g.kind === "xform") {
    if (g.moved) commitFrom(g.before);
    else if (g.tapId) setSelection([g.tapId]);
  } else if (g.kind === "node") {
    if (g.moved || g.inserted) commitFrom(g.before);
    renderToolOpts();
  } else if (g.kind === "marquee") {
    finishMarquee(g);
  } else if (g.kind === "erase") {
    if (g.changedAny) {
      pruneSelection();
      changed();
    }
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
    viewTouched = true;
    requestDraw();
  },
  { passive: false },
);
document.addEventListener("gesturestart", (e) => e.preventDefault());

let spaceDown = false;
window.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.code === "Space") spaceDown = true;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (mod && k === "y") {
    e.preventDefault();
    redo();
  } else if (mod && k === "c") {
    e.preventDefault();
    copySelection(false);
  } else if (mod && k === "x") {
    e.preventDefault();
    copySelection(true);
  } else if (mod && k === "v") {
    e.preventDefault();
    paste();
  } else if (mod && k === "d") {
    e.preventDefault();
    duplicateSelection();
  } else if (mod && k === "a") {
    e.preventDefault();
    selectAll();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (tool === "node" && nodeSel.length) deleteSelectedNodes();
    else if (selection.length) deleteSelected();
  } else if (e.key === "Escape") {
    if (gesture) cancelGesture();
    else if (tool === "node" && nodeSel.length) {
      nodeSel = [];
      renderToolOpts();
      requestDraw();
    } else setSelection([]);
  } else if (e.key.startsWith("Arrow") && (selection.length || (tool === "node" && nodeSel.length))) {
    e.preventDefault();
    const step = e.shiftKey ? 5 : 0.5;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    nudge(dx, dy);
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

function startTool(id: number, m: Vec, shift = false): void {
  if (tool === "select") return startSelect(id, m, shift || additive);
  if (tool === "node") return startNode(id, m, shift || additive);
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
    // 塗れる範囲: キャンバス (と描いた線) が収まる正方形
    const sb = selectionBox(strokes);
    const reach = Math.max(doc.settings.canvasW, doc.settings.canvasH, sb ? 2 * Math.max(-sb.minX, sb.maxX, -sb.minY, sb.maxY) : 0);
    const r = bucketFill(strokes, g.cur, { gapCloseMm: gapClose, areaMm: Math.min(320, reach + 4) });
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

function addElement(layer: Layer, el: StitchEl): void {
  beginChange();
  layer.elements.push(el);
  pushRecent(el.color);
  changed();
}

function hitTest(m: Vec, anyLayer: boolean): { el: Element; layer: Layer } | null {
  const tol = 10 / view.scale;
  const layers = anyLayer ? [...doc.layers].reverse() : [activeLayer()];
  for (const layer of layers) {
    if (!layer.visible || (anyLayer && layer.locked)) continue;
    for (let i = layer.elements.length - 1; i >= 0; i--) {
      const el = layer.elements[i];
      if (el.kind === "stroke") {
        if (distToPolyline(m, el.points, el.closed) <= el.width / 2 + tol) return { el, layer };
      } else if (el.kind === "image") {
        if (pointInShape(m, imageCorners(el), [])) return { el, layer };
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
  selection = selection.filter((id) => id !== hit.el.id);
  if (nodeTarget === hit.el.id) nodeTarget = null;
  docVersion++;
  requestDraw();
}

// ------------------------------------------------------------------ 選択・変形

/** 変形の確定: つかむ前の状態を取り消し履歴に積む */
function commitFrom(before: string): void {
  undoStack.push(before);
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
  changed();
}

function hitHandle(m: Vec): HandleName | null {
  const b = selBoxPadded();
  if (!b) return null;
  const tol = 22 / view.scale;
  let best: HandleName | null = null;
  let bd = tol;
  for (const h of handlePositions(b)) {
    const d = dist(h.p, m);
    // 回転ハンドルと角のハンドルを優先 (辺のハンドルと重なるとき)
    const bias = h.name === "rot" || h.name.length === 2 ? 0.8 : 1;
    if (d * bias <= bd) {
      bd = d * bias;
      best = h.name;
    }
  }
  return best;
}

function inBox(m: Vec, b: Box | null): boolean {
  return !!b && m.x >= b.minX && m.x <= b.maxX && m.y >= b.minY && m.y <= b.maxY;
}

function beginXform(id: number, m: Vec, op: "move" | "scale" | "rotate", handle: HandleName | null, tapId: string | null): void {
  const els = selectedEls().map((f) => cloneElement(f.el));
  // 計算は実際の外接矩形で行う (表示の枠は少し余白をつけている)
  const box = selectionBox(els);
  if (els.length === 0 || !box) return;
  gesture = { kind: "xform", id, op, handle, start: m, cur: m, orig: els, box, before: snapshot(), moved: false, tapId, info: "" };
}

function startSelect(id: number, m: Vec, add: boolean): void {
  // 1. 選択枠のハンドル (拡大縮小・回転)
  if (selection.length > 0 && !add) {
    const h = hitHandle(m);
    if (h) return beginXform(id, m, h === "rot" ? "rotate" : "scale", h, null);
  }
  const hit = hitTest(m, true);
  if (hit) {
    const isSel = selection.includes(hit.el.id);
    if (add) {
      // 追加選択: タップで足す / 外す
      setSelection(isSel ? selection.filter((x) => x !== hit.el.id) : [...selection, hit.el.id]);
      if (!isSel) beginXform(id, m, "move", null, null);
      return;
    }
    if (!isSel) setSelection([hit.el.id]);
    // すでに複数選択の一部をタップして動かさなかったら、その部品だけを選び直す
    return beginXform(id, m, "move", null, isSel && selection.length > 1 ? hit.el.id : null);
  }
  // 2. 選択枠の内側の空いた所をつかんでも移動できる
  if (!add && inBox(m, selBoxPadded())) return beginXform(id, m, "move", null, null);
  // 3. 何もない所: 範囲選択
  gesture = { kind: "marquee", id, start: m, cur: m, target: "elements", base: add ? selection.slice() : [], baseNodes: [] };
  requestDraw();
}

function updateXform(g: Extract<Gesture, { kind: "xform" }>, m: Vec, shift: boolean): void {
  g.cur = m;
  const b = g.box;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  if (!g.moved && dist(m, g.start) * view.scale < 3) return;
  g.moved = true;
  let out: Element[];
  if (g.op === "move") {
    const dx = m.x - g.start.x;
    const dy = m.y - g.start.y;
    out = g.orig.map((el) => mapElement(el, translateFn(dx, dy)));
    g.info = `移動 ${dx >= 0 ? "+" : ""}${dx.toFixed(1)}, ${dy >= 0 ? "+" : ""}${dy.toFixed(1)} mm`;
  } else if (g.op === "rotate") {
    const a0 = Math.atan2(g.start.y - cy, g.start.x - cx);
    const a1 = Math.atan2(m.y - cy, m.x - cx);
    let deg = ((a1 - a0) * 180) / Math.PI;
    deg = ((deg % 360) + 540) % 360 - 180;
    // 15° ごとに吸い付く (Shift なら常に 15° 刻み)
    const snap = Math.round(deg / 15) * 15;
    if (shift || Math.abs(deg - snap) < 4) deg = snap;
    const rad = (deg * Math.PI) / 180;
    out = g.orig.map((el) => rotateElement(el, cx, cy, rad));
    g.info = `回転 ${Math.round(deg)}°`;
  } else {
    const h = g.handle!;
    // 反対側の角・辺を基準点にする
    const ax = h.includes("w") ? b.maxX : h.includes("e") ? b.minX : cx;
    const ay = h.includes("n") ? b.maxY : h.includes("s") ? b.minY : cy;
    const hx = h.includes("w") ? b.minX : h.includes("e") ? b.maxX : cx;
    const hy = h.includes("n") ? b.minY : h.includes("s") ? b.maxY : cy;
    let sx = 1;
    let sy = 1;
    if (h.length === 2 && !shift) {
      // 角: 縦横比を保って拡大縮小
      const vx = hx - ax;
      const vy = hy - ay;
      const k = ((m.x - ax) * vx + (m.y - ay) * vy) / (vx * vx + vy * vy || 1);
      sx = sy = Math.max(0.05, k);
    } else {
      if (h.includes("w") || h.includes("e")) sx = Math.max(0.05, (m.x - ax) / (hx - ax || 1));
      if (h.includes("n") || h.includes("s")) sy = Math.max(0.05, (m.y - ay) / (hy - ay || 1));
    }
    const f = scaleFn(ax, ay, sx, sy);
    const wk = Math.sqrt(sx * sy);
    out = g.orig.map((el) => {
      const r = mapElement(el, f);
      if (scaleWidth && r.kind === "stroke") r.width = Math.round(Math.min(7, Math.max(0.3, r.width * wk)) * 10) / 10;
      return r;
    });
    const w = (b.maxX - b.minX) * sx;
    const hh = (b.maxY - b.minY) * sy;
    g.info = `${Math.max(0, w).toFixed(1)} × ${Math.max(0, hh).toFixed(1)} mm (${Math.round(sx * 100)}${sx !== sy ? `×${Math.round(sy * 100)}` : ""}%)`;
  }
  for (const el of out) replaceElement(el);
  requestDraw();
}

function marqueeBox(g: { start: Vec; cur: Vec }): Box {
  return {
    minX: Math.min(g.start.x, g.cur.x),
    minY: Math.min(g.start.y, g.cur.y),
    maxX: Math.max(g.start.x, g.cur.x),
    maxY: Math.max(g.start.y, g.cur.y),
  };
}

function finishMarquee(g: Extract<Gesture, { kind: "marquee" }>): void {
  const r = marqueeBox(g);
  const tiny = (r.maxX - r.minX) * view.scale < 6 && (r.maxY - r.minY) * view.scale < 6;
  if (g.target === "nodes") {
    const f = nodeTarget ? findElement(nodeTarget) : null;
    if (!f) return;
    if (tiny) nodeSel = g.baseNodes;
    else {
      const picked: NodeRef[] = [];
      paths(f.el).forEach((path, ring) =>
        path.pts.forEach((v, index) => {
          if (inBox(v, r)) picked.push({ ring, index });
        }),
      );
      const keys = new Set(g.baseNodes.map(nodeKey));
      nodeSel = [...g.baseNodes, ...picked.filter((q) => !keys.has(nodeKey(q)))];
    }
    renderToolOpts();
    requestDraw();
    return;
  }
  if (tiny) return setSelection(g.base);
  const ids: string[] = [];
  for (const layer of doc.layers) {
    if (!layer.visible || layer.locked) continue;
    for (const el of layer.elements) {
      const e = elementBox(el);
      const inside = e.minX >= r.minX && e.maxX <= r.maxX && e.minY >= r.minY && e.maxY <= r.maxY;
      const touches =
        el.kind === "image" ? imageCorners(el).some((v) => inBox(v, r)) : paths(el).some((p) => p.pts.some((v) => inBox(v, r)));
      const covers = el.kind === "fill" && pointInShape({ x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 }, el.outer, el.holes);
      if (inside || touches || covers) ids.push(el.id);
    }
  }
  setSelection([...g.base, ...ids]);
  if (ids.length) toast(`${selection.length}個を選択しました`);
}

/** 選択中の部品に変形をかける (ボタン・キー操作用) */
function transformSelection(fn: (el: Element, box: Box) => Element, label?: string): void {
  const els = selectedEls();
  const box = selectionBox(els.map((f) => f.el));
  if (!box || els.length === 0) return toast("先に部品を選んでください");
  beginChange();
  for (const f of els) replaceElement(fn(f.el, box));
  changed();
  if (label) toast(label);
}

const boxCenter = (b: Box): Vec => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });

function flipSelection(horizontal: boolean): void {
  transformSelection((el, b) => flipElement(el, boxCenter(b).x, boxCenter(b).y, horizontal));
}
function rotateSelection(deg: number): void {
  transformSelection((el, b) => rotateElement(el, boxCenter(b).x, boxCenter(b).y, (deg * Math.PI) / 180));
}

let nudgeTimer = 0;
let nudgeBefore: string | null = null;
/** 矢印キーで少しずつ動かす (連打してもまとめて1回の取り消しにする) */
function nudge(dx: number, dy: number): void {
  if (!nudgeBefore) nudgeBefore = snapshot();
  if (tool === "node" && nodeTarget && nodeSel.length) {
    const f = findElement(nodeTarget);
    if (f) replaceElement(softMoveNodes(f.el, nodeSel, dx, dy, 0));
  } else {
    for (const f of selectedEls()) replaceElement(mapElement(f.el, translateFn(dx, dy)));
  }
  requestDraw();
  clearTimeout(nudgeTimer);
  nudgeTimer = window.setTimeout(() => {
    if (nudgeBefore) commitFrom(nudgeBefore);
    nudgeBefore = null;
  }, 500);
}

function selectAll(): void {
  if (tool === "node" && nodeTarget) {
    const f = findElement(nodeTarget);
    if (!f) return;
    nodeSel = paths(f.el).flatMap((p, ring) => p.pts.map((_, index) => ({ ring, index })));
    renderToolOpts();
    requestDraw();
    return;
  }
  const l = activeLayer();
  if (l.locked || !l.visible) return toast(`レイヤー「${l.name}」はロック中か非表示です`);
  if (tool !== "select") setTool("select");
  setSelection(l.elements.map((e) => e.id));
  toast(`レイヤー「${l.name}」の ${selection.length}個を選択しました`);
}

function deleteSelected(): void {
  const els = selectedEls();
  if (els.length === 0) return;
  beginChange();
  const ids = new Set(els.map((f) => f.el.id));
  for (const layer of doc.layers) layer.elements = layer.elements.filter((e) => !ids.has(e.id));
  if (nodeTarget && ids.has(nodeTarget)) nodeTarget = null;
  selection = [];
  seqSelected = null;
  changed();
  renderToolOpts();
}

// ------------------------------------------------------------------ コピー&ペースト

function saveClipboard(): void {
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify(clipboard));
  } catch {
    /* 容量不足でもこのページ内では使える */
  }
}

function copySelection(cut: boolean): void {
  const els = selectedEls();
  if (els.length === 0) return toast("コピーする部品を選んでください");
  clipboard = els.map((f) => cloneElement(f.el));
  pasteCount = 0;
  saveClipboard();
  if (cut) {
    deleteSelected();
    toast(`${clipboard.length}個を切り取りました`);
  } else toast(`${clipboard.length}個をコピーしました`);
  renderToolOpts();
}

function paste(): void {
  if (clipboard.length === 0) return toast("コピーした部品がありません");
  const layer = editableLayer();
  if (!layer) return;
  // 元と重ならないよう、貼るたびに少しずつずらす (切り取りの後は同じ位置)
  pasteCount++;
  const off = 3 * pasteCount;
  const els = duplicateElements(clipboard, off, off);
  beginChange();
  layer.elements.push(...els);
  changed();
  if (tool !== "select") setTool("select");
  setSelection(els.map((e) => e.id));
  toast(`レイヤー「${layer.name}」に ${els.length}個を貼り付けました`);
}

function duplicateSelection(): void {
  const els = selectedEls();
  if (els.length === 0) return toast("複製する部品を選んでください");
  beginChange();
  const ids: string[] = [];
  // 元の部品のすぐ後ろ (同じレイヤー) に入れる
  for (const f of els) {
    const [copy] = duplicateElements([f.el], 3, 3);
    const i = f.layer.elements.findIndex((e) => e.id === f.el.id);
    f.layer.elements.splice(i + 1, 0, copy);
    ids.push(copy.id);
  }
  changed();
  setSelection(ids);
  toast(`${ids.length}個を複製しました`);
}

// ------------------------------------------------------------------ 編集点

function nodeTargetEl(): { el: Element; layer: Layer } | null {
  const f = nodeTarget ? findElement(nodeTarget) : null;
  if (!f || !f.layer.visible) return null;
  return f;
}

function setNodeTarget(id: string | null): void {
  nodeTarget = id;
  nodeSel = [];
  if (id) {
    selection = [id];
    seqSelected = id;
    const f = findElement(id);
    if (f) activeLayerId = f.layer.id;
  }
  renderToolOpts();
  renderPanels();
  requestDraw();
}

function startNode(id: number, m: Vec, add: boolean): void {
  const f = nodeTargetEl();
  const tol = 14 / view.scale;
  if (f && !f.layer.locked) {
    // 1. 点をつかむ
    const n = nearestNode(f.el, m, tol);
    if (n) {
      const isSel = nodeSel.some((q) => nodeKey(q) === nodeKey(n));
      if (add) nodeSel = isSel ? nodeSel.filter((q) => nodeKey(q) !== nodeKey(n)) : [...nodeSel, n];
      else if (!isSel) nodeSel = [n];
      renderToolOpts();
      if (!nodeSel.some((q) => nodeKey(q) === nodeKey(n))) return requestDraw();
      gesture = {
        kind: "node",
        id,
        start: m,
        cur: m,
        grab: getNode(f.el, n) ?? null,
        orig: cloneElement(f.el),
        refs: nodeSel.slice(),
        before: snapshot(),
        moved: false,
        inserted: false,
        info: "",
      };
      return requestDraw();
    }
    // 2. 辺の上をタップ → 点を追加 (そのままドラッグで動かせる)
    const seg = nearestSegment(f.el, m, 12 / view.scale);
    if (seg) {
      const before = snapshot();
      const r = insertNode(f.el, seg.ring, seg.index, seg.point);
      replaceElement(r.el);
      nodeSel = [r.ref];
      gesture = {
        kind: "node",
        id,
        start: m,
        cur: m,
        grab: seg.point,
        orig: cloneElement(r.el),
        refs: [r.ref],
        before,
        moved: false,
        inserted: true,
        info: "点を追加",
      };
      renderToolOpts();
      return requestDraw();
    }
  }
  // 3. 別の部品をタップ → その部品を編集する
  const hit = hitTest(m, true);
  if (hit && hit.el.kind === "image") {
    if (!f) toast("画像には編集点がありません。選択ツールで拡大縮小・回転できます");
  }
  if (hit && hit.el.kind !== "image" && hit.el.id !== nodeTarget) {
    setNodeTarget(hit.el.id);
    toast(`${hit.el.kind === "fill" ? "面" : "線"}の編集点: 点をドラッグで変形、線の上をタップで点を追加`);
    return;
  }
  if (!f) {
    if (!hit) toast("編集する線・面をタップしてください");
    return;
  }
  // 4. 何もない所: 点の範囲選択
  gesture = { kind: "marquee", id, start: m, cur: m, target: "nodes", base: [], baseNodes: add ? nodeSel.slice() : [] };
  requestDraw();
}

function updateNodeDrag(g: Extract<Gesture, { kind: "node" }>, m: Vec): void {
  g.cur = m;
  if (!g.moved && dist(m, g.start) * view.scale < 2) return;
  g.moved = true;
  const dx = m.x - g.start.x;
  const dy = m.y - g.start.y;
  replaceElement(softMoveNodes(g.orig, g.refs, dx, dy, softRadius));
  if (g.grab) g.grab = { x: (getNode(g.orig, g.refs[0]) ?? g.grab).x + dx, y: (getNode(g.orig, g.refs[0]) ?? g.grab).y + dy };
  g.info = `${g.refs.length}点 移動 ${Math.hypot(dx, dy).toFixed(1)}mm${softRadius > 0 ? ` (やわらか ${softRadius}mm)` : ""}`;
  requestDraw();
}

function editNodeTarget(fn: (el: Element) => Element, msg?: string): void {
  const f = nodeTargetEl();
  if (!f) return toast("編集する線・面をタップしてください");
  if (f.layer.locked) return toast("ロック中のレイヤーです");
  beginChange();
  replaceElement(fn(f.el));
  pruneSelection();
  changed();
  renderToolOpts();
  if (msg) toast(msg);
}

function deleteSelectedNodes(): void {
  if (nodeSel.length === 0) return toast("削除する点を選んでください (点をタップ)");
  const n = nodeSel.length;
  const refs = nodeSel;
  nodeSel = [];
  editNodeTarget((el) => deleteNodes(el, refs), `${n}点を削除しました`);
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
}

// ------------------------------------------------------------------ ツールバー

function setTool(t: Tool): void {
  tool = t;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#tools [data-tool]")) {
    b.classList.toggle("on", b.dataset.tool === t);
  }
  if (gesture) cancelGesture();
  if (t === "node") {
    // 選択中の部品が1つなら、そのまま編集点を出す
    if (selection.length === 1 && findElement(selection[0])?.el.kind !== "image") nodeTarget = selection[0];
    else if (!nodeTarget || !findElement(nodeTarget)) nodeTarget = null;
    nodeSel = [];
    if (!nodeTarget) toast("編集する線・面をタップしてください");
  } else if (t !== "select") {
    selection = [];
    seqSelected = null;
  }
  if (t === "select" && nodeTarget && selection.length === 0) selection = [nodeTarget];
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
    wrap.className = "widthCtl";
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
  } else if (tool === "select") renderSelectOpts(box, tip);
  else if (tool === "node") renderNodeOpts(box, tip);
  else if (tool === "eraser") box.append(tip(`なぞった線・面を消します (レイヤー「${activeLayer().name}」)`));
}

function actionBtn(label: string, title: string, fn: () => void, opts: { on?: boolean; danger?: boolean; disabled?: boolean } = {}): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "act";
  b.innerHTML = label;
  b.title = title;
  if (opts.on) b.classList.add("on");
  if (opts.danger) b.classList.add("danger");
  b.disabled = !!opts.disabled;
  b.addEventListener("click", fn);
  return b;
}

function group(...items: HTMLElement[]): HTMLElement {
  const g = document.createElement("div");
  g.className = "actGroup";
  g.append(...items);
  return g;
}

function renderSelectOpts(box: HTMLElement, tip: (t: string) => HTMLElement): void {
  const n = selection.length;
  const none = n === 0;
  box.append(
    group(
      actionBtn("＋選択", "タップで選択に追加・解除 (Shift でも可)", () => {
        additive = !additive;
        renderToolOpts();
      }, { on: additive }),
      actionBtn("全選択", "このレイヤーの部品をすべて選択 (⌘A)", selectAll),
    ),
  );
  if (none) {
    box.append(
      tip("タップで選択 / 何もない所をドラッグで範囲選択"),
      group(actionBtn("貼り付け", "⌘V", paste, { disabled: clipboard.length === 0 })),
    );
    return;
  }
  const scaleLbl = document.createElement("label");
  scaleLbl.className = "chk";
  scaleLbl.innerHTML = `<input type="checkbox" ${scaleWidth ? "checked" : ""}> 拡縮で線の太さも変える`;
  scaleLbl.querySelector("input")!.addEventListener("change", (e) => (scaleWidth = (e.target as HTMLInputElement).checked));
  box.append(
    tip(`${n}個を選択中 — 角をドラッグで拡大縮小、○で回転`),
    group(
      actionBtn("コピー", "⌘C", () => copySelection(false)),
      actionBtn("切り取り", "⌘X", () => copySelection(true)),
      actionBtn("貼り付け", "⌘V", paste, { disabled: clipboard.length === 0 }),
      actionBtn("複製", "⌘D", duplicateSelection),
    ),
    group(
      actionBtn("⇋ 左右反転", "左右反転", () => flipSelection(true)),
      actionBtn("⇵ 上下反転", "上下反転", () => flipSelection(false)),
      actionBtn("↻ 90°", "右に90°回転", () => rotateSelection(90)),
    ),
    group(
      actionBtn("◇ 編集点", "選んだ部品の点を編集", () => setTool("node"), { disabled: n !== 1 }),
      actionBtn("削除", "Delete", deleteSelected, { danger: true }),
    ),
    scaleLbl,
  );
}

function renderNodeOpts(box: HTMLElement, tip: (t: string) => HTMLElement): void {
  const f = nodeTargetEl();
  if (!f) {
    box.append(tip("編集する線・面をタップしてください"));
    return;
  }
  const soft = document.createElement("label");
  soft.innerHTML = `やわらか <input type="range" min="0" max="20" step="1" value="${softRadius}"><span class="val">${softRadius ? `${softRadius}mm` : "点だけ"}</span>`;
  const r = soft.querySelector("input")!;
  r.addEventListener("input", () => {
    softRadius = Number(r.value);
    soft.querySelector(".val")!.textContent = softRadius ? `${softRadius}mm` : "点だけ";
  });
  const el = f.el;
  box.append(
    tip(`点 ${nodeCount(el)}個${nodeSel.length ? ` (選択 ${nodeSel.length})` : ""} — 点をドラッグで変形・線の上をタップで点を追加`),
    soft,
    group(
      actionBtn("＋選択", "タップで点を選択に追加・解除", () => {
        additive = !additive;
        renderToolOpts();
      }, { on: additive }),
      actionBtn("全部の点", "⌘A", selectAll),
    ),
    group(
      actionBtn("点を削除", "選んだ点を削除 (Delete)", deleteSelectedNodes, { danger: true, disabled: nodeSel.length === 0 }),
      actionBtn("間引く", "形を保ったまま点を減らす", () => {
        nodeSel = [];
        editNodeTarget(decimate, "点を間引きました");
      }),
      actionBtn("増やす", "各辺の真ん中に点を足す", () => {
        nodeSel = [];
        editNodeTarget(subdivide, "点を増やしました");
      }),
    ),
  );
  if (el.kind === "stroke" && el.points.length >= 3) {
    box.append(
      group(
        actionBtn(el.closed ? "線を開く" : "線を閉じる", "始点と終点をつなぐ / 切り離す", () =>
          editNodeTarget((x) => (x.kind === "stroke" ? { ...x, closed: !x.closed } : x)),
        ),
      ),
    );
  }
  box.append(group(actionBtn("選択に戻る", "選択ツール", () => setTool("select"))));
}

// ------------------------------------------------------------------ 色

function pushRecent(c: ThreadRef): void {
  recent = [c, ...recent.filter((r) => !(r.r === c.r && r.g === c.g && r.b === c.b))].slice(0, 8);
}

function setColor(c: ThreadRef): void {
  color = { ...c };
  $("colorSwatch").style.background = rgb(color);
  const els = selectedEls().filter((f) => !f.layer.locked && isStitchEl(f.el));
  if (els.length && (tool === "select" || tool === "node")) {
    beginChange();
    for (const f of els) if (isStitchEl(f.el)) f.el.color = { ...color };
    changed();
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

for (const b of document.querySelectorAll<HTMLButtonElement>("#tabs button[data-tab]")) {
  b.addEventListener("click", () => {
    for (const x of document.querySelectorAll<HTMLButtonElement>("#tabs button[data-tab]")) x.classList.toggle("on", x === b);
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
  $("panelLayerName").textContent = activeLayer().name;
  const list = $("layerList");
  const counts = layerStitchCounts();
  const items: HTMLElement[] = [];
  const n = doc.layers.length;
  // 縫う順番の番号 (画像だけのレイヤーは縫わないので番号を振らない)
  const sewNo = new Map<string, number>();
  let k = 0;
  for (const l of doc.layers) if (!isImageLayer(l)) sewNo.set(l.id, ++k);
  // 一番上のレイヤーを一番上に表示
  for (let i = n - 1; i >= 0; i--) {
    const layer = doc.layers[i];
    const li = document.createElement("li");
    if (layer.id === activeLayerId) li.classList.add("active");
    if (!layer.visible) li.classList.add("hiddenL");
    const lines = layer.elements.filter((e) => e.kind === "stroke").length;
    const fills = layer.elements.filter((e) => e.kind === "fill").length;
    const imgs = layer.elements.length - lines - fills;
    const st = counts.get(layer.id);
    const imgOnly = isImageLayer(layer);
    li.innerHTML = imgOnly
      ? `<span class="ord img" title="下敷きの画像 (縫いません)">🖼</span>`
      : `<span class="ord" title="縫う順番">${sewNo.get(layer.id)}</span>`;
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
    nm.innerHTML = imgOnly
      ? `${escapeHtml(layer.name)}<small>画像${imgs}・縫いません</small>`
      : `${escapeHtml(layer.name)}<small>線${lines}・面${fills}${imgs ? `・画像${imgs}` : ""}${st !== undefined ? `・${st.toLocaleString()}針` : ""}</small>`;
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
    if (imgOnly) li.append(eye, nm, lock);
    else li.append(eye, nm, ord, lock);
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
      const id = seqSelected === q.elementId ? null : q.elementId;
      if (id && tool !== "select" && tool !== "node") setTool("select");
      setSelection(id ? [id] : []);
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
  const els = selectedEls();
  if (els.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const strokes = els.filter((f) => f.el.kind === "stroke").map((f) => f.el as StrokeEl);
  const fills = els.filter((f) => f.el.kind === "fill").map((f) => f.el as FillEl);
  const one = els.length === 1 ? els[0] : null;
  const bb = selectionBox(els.map((f) => f.el))!;
  const W = bb.maxX - bb.minX;
  const H = bb.maxY - bb.minY;
  const sameLayer = els.every((f) => f.layer === els[0].layer);
  const layerOpts =
    (sameLayer ? "" : `<option value="" selected>(いろいろ)</option>`) +
    doc.layers
      .map((l) => `<option value="${l.id}" ${sameLayer && l.id === els[0].layer.id ? "selected" : ""}>${escapeHtml(l.name)}</option>`)
      .join("");
  const images = els.filter((f) => f.el.kind === "image").map((f) => f.el as ImageEl);
  const title =
    one && one.el.kind === "image"
      ? "画像 (下敷き・縫いません)"
      : one && isStitchEl(one.el)
        ? `${one.el.kind === "fill" ? "面" : "線"} <span class="sw" style="display:inline-block;width:14px;height:14px;border-radius:4px;vertical-align:middle;background:${rgb(one.el.color)}"></span>`
        : `${els.length}個 (線${strokes.length}・面${fills.length}${images.length ? `・画像${images.length}` : ""})`;
  let body = `<h4>選択中: ${title}</h4>`;
  body += `<label>大きさ (mm) <span class="sizeRow"><input id="selSW" type="number" min="0.5" max="200" step="0.5" value="${W.toFixed(1)}">×<input id="selSH" type="number" min="0.5" max="200" step="0.5" value="${H.toFixed(1)}"></span></label>`;
  body += `<label class="tog"><input id="selKeep" type="checkbox" checked> 縦横比を保つ</label>`;
  if (strokes.length) {
    const w0 = strokes[0].width;
    const same = strokes.every((x) => x.width === w0);
    body += `<label>線の太さ (mm) <input id="selW" type="number" min="0.4" max="7" step="0.1" value="${same ? w0 : ""}" placeholder="いろいろ"></label>`;
    const st0 = strokes[0].style;
    const sameSt = strokes.every((x) => x.style === st0);
    body += `<label>線の縫い方 <select id="selStyle">${sameSt ? "" : `<option value="" selected>(いろいろ)</option>`}${(
      [
        ["auto", "自動"],
        ["running", "ランニング"],
        ["triple", "3重ぬい"],
        ["satin", "サテン"],
      ] as [StrokeStyle, string][]
    )
      .map(([v, l]) => `<option value="${v}" ${sameSt && st0 === v ? "selected" : ""}>${l}</option>`)
      .join("")}</select></label>`;
  }
  if (fills.length) {
    const a0 = String(fills[0].angleDeg ?? "");
    const sameA = fills.every((x) => String(x.angleDeg ?? "") === a0);
    const opts = [["", "標準"], ["0", "0°"], ["45", "45°"], ["90", "90°"], ["135", "135°"]];
    if (sameA && !opts.some(([v]) => v === a0)) opts.push([a0, `${a0}°`]);
    body += `<label>面の縫い角度 <select id="selAngle">${sameA ? "" : `<option value="-" selected>(いろいろ)</option>`}${opts
      .map(([v, l]) => `<option value="${v}" ${sameA && a0 === v ? "selected" : ""}>${l}</option>`)
      .join("")}</select></label>`;
  }
  if (images.length) {
    body += `<label>画像の濃さ <input id="selOpacity" type="range" min="0.05" max="1" step="0.05" value="${images[0].opacity}"></label>`;
  }
  body += `<label>レイヤー <select id="selLayer">${layerOpts}</select></label>`;
  body += `<div class="row">${strokes.length + fills.length ? `<button id="selColor">いまの色に変える</button>` : ""}<button id="selDel" class="mini danger">削除</button></div>`;
  if (images.length) body += `<p class="note">位置と大きさを決めたら、レイヤーの 🔒 でロックすると上から描いても動きません。</p>`;
  box.innerHTML = body;

  const edit = (fn: () => void) => {
    beginChange();
    fn();
    changed();
  };
  const resizeTo = (w: number, h: number) => {
    const keep = box.querySelector<HTMLInputElement>("#selKeep")!.checked;
    let sx = W > 0.01 ? w / W : 1;
    let sy = H > 0.01 ? h / H : 1;
    if (keep) {
      const k = Math.abs(w - W) > 1e-6 ? sx : sy;
      sx = sy = k;
    }
    if (!(sx > 0 && sy > 0)) return;
    const c = boxCenter(bb);
    transformSelection((el) => {
      const r = mapElement(el, scaleFn(c.x, c.y, sx, sy));
      if (scaleWidth && r.kind === "stroke") r.width = Math.round(Math.min(7, Math.max(0.3, r.width * Math.sqrt(sx * sy))) * 10) / 10;
      return r;
    });
  };
  box.querySelector<HTMLInputElement>("#selSW")!.addEventListener("change", (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    if (v > 0) resizeTo(v, H);
  });
  box.querySelector<HTMLInputElement>("#selSH")!.addEventListener("change", (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    if (v > 0) resizeTo(W, v);
  });
  box.querySelector<HTMLInputElement>("#selW")?.addEventListener("change", (e) => {
    const v = Math.min(7, Math.max(0.4, Number((e.target as HTMLInputElement).value) || 1));
    edit(() => strokes.forEach((x) => (x.width = v)));
  });
  box.querySelector<HTMLSelectElement>("#selStyle")?.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value as StrokeStyle;
    if (v) edit(() => strokes.forEach((x) => (x.style = v)));
  });
  box.querySelector<HTMLSelectElement>("#selAngle")?.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v !== "-") edit(() => fills.forEach((x) => (x.angleDeg = v === "" ? null : Number(v))));
  });
  box.querySelector<HTMLSelectElement>("#selLayer")?.addEventListener("change", (e) => {
    const to = doc.layers.find((l) => l.id === (e.target as HTMLSelectElement).value);
    if (!to) return;
    if (to.locked) return toast("ロック中のレイヤーには移せません");
    edit(() => {
      for (const f of els) {
        if (f.layer === to) continue;
        f.layer.elements = f.layer.elements.filter((x) => x !== f.el);
        to.elements.push(f.el);
      }
      activeLayerId = to.id;
    });
  });
  box.querySelector("#selColor")?.addEventListener("click", () =>
    edit(() => els.forEach((f) => isStitchEl(f.el) && (f.el.color = { ...color }))),
  );
  // 濃さはドラッグ中は描き直すだけ、離したときに1回だけ取り消し履歴に積む
  const op = box.querySelector<HTMLInputElement>("#selOpacity");
  if (op) {
    let before: string | null = null;
    op.addEventListener("input", () => {
      if (!before) before = snapshot();
      for (const im of images) im.opacity = Number(op.value);
      requestDraw();
    });
    op.addEventListener("change", () => {
      if (before) commitFrom(before);
      before = null;
    });
  }
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
  const tooBig = s.widthMm > PP1_HOOP_MM + 0.5 || s.heightMm > PP1_HOOP_MM + 0.5;
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
  $("canvasInfo").textContent = `${s.canvasW}×${s.canvasH}mm${s.canvasW > PP1_HOOP_MM || s.canvasH > PP1_HOOP_MM ? " (PP1 の枠より大きい)" : ""}`;
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
$("setPenOnly").addEventListener("change", (e) => {
  penOnly = (e.target as HTMLInputElement).checked;
  prefs.penOnlyDecided = true;
  savePrefs();
});

// ------------------------------------------------------------------ 下敷きの画像

function openImagePicker(): void {
  $("menu").hidden = true;
  $<HTMLInputElement>("imgFile").click();
}
for (const id of ["imgBtn", "imgLoad", "imgLoad2", "mImage"]) $(id).addEventListener("click", openImagePicker);

/** キャンバスに収まる大きさ (scale=0.9 なら 9割) で中央に置いた画像 */
function makeImageEl(imageId: string, wPx: number, hPx: number, opacity: number, fitMm?: number): ImageEl {
  const { canvasW: W, canvasH: H } = doc.settings;
  const k = fitMm ? fitMm / Math.max(wPx, hPx) : Math.min((W * 0.9) / wPx, (H * 0.9) / hPx);
  const iw = wPx * k;
  const ih = hPx * k;
  return {
    kind: "image",
    id: uid(),
    imageId,
    p0: { x: -iw / 2, y: -ih / 2 },
    p1: { x: iw / 2, y: -ih / 2 },
    p2: { x: -iw / 2, y: ih / 2 },
    opacity,
  };
}

function isImageLayer(l: Layer): boolean {
  return l.elements.length > 0 && l.elements.every((e) => e.kind === "image");
}

$("imgFile").addEventListener("change", async () => {
  const input = $<HTMLInputElement>("imgFile");
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const { url, w, h } = await readImageFile(file);
    const imageId = putImage(url, undefined, (ok) => {
      if (!ok) toast("画像をこの端末に保存できませんでした。「作品を保存」で書き出しておいてください");
    });
    const el = makeImageEl(imageId, w, h, 0.5);
    beginChange();
    const n = doc.layers.filter(isImageLayer).length;
    const layer = newLayer(n ? `下絵${n + 1}` : "下絵");
    layer.elements.push(el);
    // 一番下のレイヤーに入れる (上のレイヤーに描いた線が画像の上に重なる)
    doc.layers.unshift(layer);
    changed();
    if (mode === "stitch") setMode("draw");
    setTool("select");
    setSelection([el.id]);
    toast("画像を一番下のレイヤーに入れました。角で大きさ・○で回転。決まったらレイヤーの 🔒 でロック");
  } catch (err) {
    toast(String((err as Error).message ?? err));
  }
});

/** 旧版の「下絵」設定を画像レイヤーに移す */
function migrateUnderlay(): void {
  const url = doc.settings.underlayImage;
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    if (doc.settings.underlayImage !== url) return;
    const imageId = putImage(url);
    // 旧版は 100mm 角に収めて中央に表示していた
    const el = makeImageEl(imageId, img.naturalWidth, img.naturalHeight, doc.settings.underlayOpacity, 100);
    const layer = newLayer("下絵");
    layer.visible = doc.settings.underlayVisible;
    layer.locked = true;
    layer.elements.push(el);
    doc.layers.unshift(layer);
    doc.settings.underlayImage = null;
    changed();
  };
  img.src = url;
}

function usedImageIds(): Set<string> {
  const ids = new Set<string>();
  for (const l of doc.layers) for (const e of l.elements) if (e.kind === "image") ids.add(e.imageId);
  for (const e of clipboard) if (e.kind === "image") ids.add(e.imageId);
  return ids;
}

/** 作品ファイル用: 使っている画像のデータを埋め込んだ JSON */
function docJsonWithImages(): string {
  const images: Record<string, string> = {};
  for (const l of doc.layers)
    for (const e of l.elements)
      if (e.kind === "image") {
        const d = getImageData(e.imageId);
        if (d) images[e.imageId] = d;
      }
  return JSON.stringify({ ...doc, images });
}

// ------------------------------------------------------------------ キャンバスのサイズ

const CV_PRESETS: Record<string, [number, number, string?][]> = {
  cvSquare: [[100, 100, "PP1 最大"], [90, 90], [80, 80], [70, 70], [60, 60], [50, 50], [40, 40], [30, 30]],
  cvWide: [[100, 80], [100, 70], [100, 50], [100, 30], [80, 50], [60, 40]],
  cvTall: [[80, 100], [70, 100], [50, 100], [30, 100], [50, 80], [40, 60]],
};
let cvMode: "resize" | "new" = "resize";

function openCanvasDlg(m: "resize" | "new"): void {
  cvMode = m;
  $("menu").hidden = true;
  $("canvasTitle").textContent = m === "new" ? "新しく描く — キャンバスのサイズ" : "キャンバスのサイズ";
  $("cvOk").textContent = m === "new" ? "新しく描く (いまの絵は消えます)" : "このサイズにする";
  $("cvScaleRow").hidden = m === "new";
  $<HTMLInputElement>("cvW").value = String(doc.settings.canvasW);
  $<HTMLInputElement>("cvH").value = String(doc.settings.canvasH);
  $<HTMLInputElement>("cvScale").checked = false;
  renderCanvasDlg();
  $("canvasDlg").hidden = false;
}

function cvValues(): { w: number; h: number } {
  const clamp = (v: number) => Math.round(Math.min(300, Math.max(10, v || 100)) * 10) / 10;
  return { w: clamp(Number($<HTMLInputElement>("cvW").value)), h: clamp(Number($<HTMLInputElement>("cvH").value)) };
}

function renderCanvasDlg(): void {
  const { w, h } = cvValues();
  for (const [boxId, list] of Object.entries(CV_PRESETS)) {
    $(boxId).replaceChildren(
      ...list.map(([pw, ph, note]) => {
        const b = document.createElement("button");
        b.textContent = `${pw}×${ph}${note ? ` (${note})` : ""}`;
        b.classList.toggle("on", pw === w && ph === h);
        b.addEventListener("click", () => {
          $<HTMLInputElement>("cvW").value = String(pw);
          $<HTMLInputElement>("cvH").value = String(ph);
          renderCanvasDlg();
        });
        return b;
      }),
    );
  }
  const warn: string[] = [];
  if (w > PP1_HOOP_MM || h > PP1_HOOP_MM) warn.push(`PP1 の刺繍枠 (100×100mm) より大きいサイズです。枠の外の部分は PP1 では縫えません。`);
  if (cvMode === "resize" && !$<HTMLInputElement>("cvScale").checked) {
    const b = selectionBox(doc.layers.flatMap((l) => l.elements));
    if (b && (b.minX < -w / 2 - 0.5 || b.maxX > w / 2 + 0.5 || b.minY < -h / 2 - 0.5 || b.maxY > h / 2 + 0.5)) {
      warn.push("描いた絵の一部がキャンバスの外に出ます (「絵も合わせて拡大縮小」で収められます)。");
    }
  }
  $("cvWarn").textContent = warn.join(" ");
  $("cvWarn").hidden = warn.length === 0;
}
for (const id of ["cvW", "cvH"]) $(id).addEventListener("input", renderCanvasDlg);
$("cvScale").addEventListener("change", renderCanvasDlg);
$("canvasClose").addEventListener("click", () => ($("canvasDlg").hidden = true));
$("canvasBtn").addEventListener("click", () => openCanvasDlg("resize"));
$("mCanvas").addEventListener("click", () => openCanvasDlg("resize"));

$("cvOk").addEventListener("click", () => {
  const { w, h } = cvValues();
  $("canvasDlg").hidden = true;
  beginChange();
  if (cvMode === "new") {
    doc = newDoc(w, h);
    activeLayerId = doc.layers[doc.layers.length - 1].id;
    selection = [];
    nodeTarget = null;
  } else {
    if ($<HTMLInputElement>("cvScale").checked) {
      // 絵の大きさの比率を保ったまま、新しいキャンバスに合わせる (線の太さはそのまま)
      const k = Math.min(w / doc.settings.canvasW, h / doc.settings.canvasH);
      for (const l of doc.layers) l.elements = l.elements.map((e) => mapElement(e, scaleFn(0, 0, k, k)));
    }
    doc.settings.canvasW = w;
    doc.settings.canvasH = h;
  }
  syncSettings();
  changed();
  fit();
  toast(cvMode === "new" ? `${w}×${h}mm のキャンバスで新しく描きます` : `キャンバスを ${w}×${h}mm にしました`);
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
  if (res.stats.widthMm > PP1_HOOP_MM + 0.5 || res.stats.heightMm > PP1_HOOP_MM + 0.5) {
    problems.push(`・大きさ ${res.stats.widthMm.toFixed(0)}×${res.stats.heightMm.toFixed(0)}mm が PP1 の刺繍枠 (100×100mm) を超えています`);
  }
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
  void shareOrDownload(docJsonWithImages(), `${doc.settings.name || "SKETCH"}.pp1sketch.json`, "application/json");
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
      const { doc: d, images } = parseDocWithImages(t);
      for (const [id, url] of Object.entries(images)) if (typeof url === "string") putImage(url, id);
      beginChange();
      doc = d;
      activeLayerId = doc.layers[doc.layers.length - 1].id;
      selection = [];
      nodeTarget = null;
      syncSettings();
      changed();
      migrateUnderlay();
      fit();
      toast("作品を開きました");
    } catch (err) {
      toast(String((err as Error).message ?? err));
    }
  });
  $<HTMLInputElement>("openFile").value = "";
});
$("mNew").addEventListener("click", () => openCanvasDlg("new"));

// ポップオーバーの外をタップしたら閉じる
document.addEventListener("pointerdown", (e) => {
  const t = e.target as HTMLElement;
  if (!$("menu").hidden && !t.closest("#menu") && !t.closest("#menuBtn")) $("menu").hidden = true;
  if (!$("palette").hidden && !t.closest("#palette") && !t.closest("#colorBtn")) $("palette").hidden = true;
  if (!$("canvasDlg").hidden && !t.closest("#canvasDlg") && !t.closest("#canvasBtn") && !t.closest("#menu")) $("canvasDlg").hidden = true;
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

// ------------------------------------------------------------------ パネル (引き出し) と全画面

function setPanelOpen(open: boolean): void {
  panelOpen = open;
  $("panel").classList.toggle("closed", !open);
  $("panelBtn").classList.toggle("on", open);
  savePrefs();
  if (!viewTouched) fit();
  if (open) renderPanels();
}
$("panelBtn").addEventListener("click", () => setPanelOpen(!panelOpen));
$("panelClose").addEventListener("click", () => setPanelOpen(false));

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };
const isStandalone =
  window.matchMedia?.("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

function isFullscreen(): boolean {
  const d = document as FsDoc;
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}

function toggleFullscreen(): void {
  const d = document as FsDoc;
  const el = document.documentElement as FsEl;
  try {
    if (isFullscreen()) {
      if (d.exitFullscreen) void d.exitFullscreen();
      else d.webkitExitFullscreen?.();
      return;
    }
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => fullscreenFallback());
      return;
    }
    if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
      return;
    }
  } catch {
    /* 下の案内へ */
  }
  fullscreenFallback();
}
function fullscreenFallback(): void {
  toast("Safari の共有ボタン →「ホーム画面に追加」で開くと、いつでも全画面で使えます");
}
$("fsBtn").addEventListener("click", toggleFullscreen);
const syncFs = () => {
  $("fsBtn").textContent = isFullscreen() ? "🗗" : "⛶";
  $("fsBtn").title = isFullscreen() ? "全画面をやめる" : "全画面表示";
};
document.addEventListener("fullscreenchange", syncFs);
document.addEventListener("webkitfullscreenchange", syncFs);
if (isStandalone) $("fsBtn").hidden = true;

// 初期化
void loadStoredImages().then(() => {
  migrateUnderlay();
  if (undoStack.length === 0) void removeUnusedImages(usedImageIds());
  requestDraw();
});
$("colorSwatch").style.background = rgb(color);
$("panel").classList.toggle("closed", !panelOpen);
$("panelBtn").classList.toggle("on", panelOpen);
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
  get selection() {
    return selection.slice();
  },
  get view() {
    return { ...view };
  },
  get nodeSel() {
    return nodeSel.slice();
  },
};
