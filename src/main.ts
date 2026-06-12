import "./style.css";
import { digitizeWithLimit, type LimitedDigitizeResult } from "./digitize/pipeline";
import { COLOR_CHANGE, JUMP, STITCH, TRIM } from "./embroidery/pattern";
import { writePes } from "./embroidery/pes";
import { writeDst } from "./embroidery/dst";

// ビルド時に vite.config.ts の define で package.json の version が注入される
declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

const HOOP_MM = 100; // PP1 の刺しゅう範囲 100x100mm
const PROCESS_MAX_PX = 1000; // 処理解像度の上限 (長辺)。細い線の認識のため高めにする

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

$("version").textContent = `v${APP_VERSION}`;
console.info(`PP1 Stitch Studio v${APP_VERSION}`);

const dropzone = $("dropzone");
const fileInput = $<HTMLInputElement>("fileInput");
const srcPreview = $<HTMLCanvasElement>("srcPreview");
const stitchCanvas = $<HTMLCanvasElement>("stitchCanvas");
const threadList = $<HTMLUListElement>("threadList");
const statsEl = $("stats");
const warningEl = $("warning");
const exportPesBtn = $<HTMLButtonElement>("exportPes");
const exportDstBtn = $<HTMLButtonElement>("exportDst");

let sourceImage: ImageData | null = null;
let designName = "PP1";
let result: LimitedDigitizeResult | null = null;
let enabledColors: boolean[] = [];
/** クリックで指定した「縫わない (抜き)」点 (処理画像のピクセル座標) */
let excludePoints: [number, number][] = [];
/** クリックで指定した「色の変更」点 (処理画像のピクセル座標 + 変更先パレット番号) */
let recolorPoints: { x: number; y: number; color: number }[] = [];

function resetClickEdits(): void {
  excludePoints = [];
  recolorPoints = [];
}

// ------------------------------------------------------------ 画像読み込み

function loadImageFile(file: File): void {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    setSourceImage(img);
    designName = file.name
      .replace(/\.[^.]+$/, "")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 8) || "PP1";
    enabledColors = [];
    resetClickEdits();
    update();
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

function setSourceImage(img: CanvasImageSource & { width: number; height: number }): void {
  const scale = Math.min(1, PROCESS_MAX_PX / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  sourceImage = ctx.getImageData(0, 0, w, h);

  // 入力プレビュー
  srcPreview.hidden = false;
  const pctx = srcPreview.getContext("2d")!;
  pctx.clearRect(0, 0, srcPreview.width, srcPreview.height);
  const ps = Math.min(srcPreview.width / w, srcPreview.height / h);
  pctx.imageSmoothingEnabled = true;
  pctx.drawImage(off, 0, 0, w * ps, h * ps);
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") fileInput.click();
});
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
  const file = e.dataTransfer?.files?.[0];
  if (file) loadImageFile(file);
});

// サンプルデザイン (二色の星 + 円)
$("sampleBtn").addEventListener("click", () => {
  const off = document.createElement("canvas");
  off.width = 400;
  off.height = 400;
  const ctx = off.getContext("2d")!;
  ctx.fillStyle = "#2f7ec2";
  ctx.beginPath();
  ctx.arc(200, 200, 170, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f7c948";
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 130 : 55;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const x = 200 + r * Math.cos(a);
    const y = 200 + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  setSourceImage(off);
  designName = "SAMPLE";
  enabledColors = [];
  resetClickEdits();
  update();
});

// ------------------------------------------------------------ 変換と描画

function readOptions() {
  return {
    sizeMm: clamp(Number($<HTMLInputElement>("sizeMm").value) || 90, 10, HOOP_MM),
    maxColors: clamp(Number($<HTMLInputElement>("maxColors").value) || 6, 1, 12),
    colorMergeLevel: clamp(Number($<HTMLSelectElement>("colorMerge").value) || 2, 1, 3),
    rowSpacingMm: clamp(Number($<HTMLInputElement>("rowSpacing").value) || 0.4, 0.2, 1),
    stitchLenMm: clamp(Number($<HTMLInputElement>("stitchLen").value) || 3, 1, 7),
    angleDeg: Number($<HTMLInputElement>("angle").value) || 0,
    minRegionMm2: clamp(Number($<HTMLInputElement>("minRegion").value) || 0, 0, 20),
    fill: $<HTMLInputElement>("fillOn").checked,
    outline: $<HTMLInputElement>("outlineOn").checked,
    autoBackground: $<HTMLInputElement>("autoBg").checked,
    // 細い線の設定
    autoThinDetect: $<HTMLInputElement>("autoThin").checked,
    satinMaxWidthMm: clamp(Number($<HTMLInputElement>("satinMaxWidth").value) || 6, 0, 20),
    satinSpacingMm: clamp(Number($<HTMLInputElement>("satinSpacing").value) || 0.3, 0.1, 0.6),
    centerlineMaxWidthMm: clamp(Number($<HTMLInputElement>("centerlineMax").value) || 0, 0, 5),
    outlineStitchMm: clamp(Number($<HTMLInputElement>("outlineStitch").value) || 2, 0.5, 5),
    tripleOutline: $<HTMLInputElement>("tripleOutline").checked,
    adaptiveAngle: $<HTMLInputElement>("adaptiveAngle").checked,
    // 縫いの連続性
    reduceTrims: $<HTMLInputElement>("reduceTrims").checked,
    maxConnectMm: clamp(Number($<HTMLInputElement>("maxConnect").value) || 50, 1, 100),
    outlineSmoothing: clamp(Math.round(Number($<HTMLInputElement>("smoothing").value) || 0), 0, 3),
    enabledColors: enabledColors.length > 0 ? enabledColors : undefined,
    excludePoints: excludePoints.length > 0 ? excludePoints : undefined,
    recolorPoints: recolorPoints.length > 0 ? recolorPoints : undefined,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

let timer: ReturnType<typeof setTimeout> | null = null;
function scheduleUpdate(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(update, 250);
}

for (const id of [
  "sizeMm", "maxColors", "colorMerge", "rowSpacing", "stitchLen", "angle", "minRegion",
  "fillOn", "outlineOn", "autoBg",
  "autoThin", "satinMaxWidth", "satinSpacing", "centerlineMax", "outlineStitch", "tripleOutline",
  "adaptiveAngle",
  "reduceTrims", "maxConnect", "smoothing", "maxStitches",
]) {
  $(id).addEventListener("input", () => {
    if (id === "maxColors" || id === "colorMerge" || id === "autoBg" || id === "minRegion") {
      // パレットが変わる操作では色番号ベースの指定が無効になるためリセット
      enabledColors = [];
      recolorPoints = [];
    }
    scheduleUpdate();
  });
}
$("showJumps").addEventListener("input", () => render());

function update(): void {
  if (!sourceImage) return;
  const t0 = performance.now();
  const maxStitches = clamp(
    Math.round(Number($<HTMLInputElement>("maxStitches").value) || 0),
    0,
    50000,
  );
  try {
    result = digitizeWithLimit(sourceImage, readOptions(), maxStitches);
    result.pattern.name = designName;
  } catch (err) {
    console.error(err);
    warningEl.hidden = false;
    warningEl.textContent = `変換エラー: ${err}`;
    return;
  }
  const ms = Math.round(performance.now() - t0);

  const { stats, autoAdjusted, overLimit } = result;
  const adjustNote = autoAdjusted
    ? `<span>密度自動調整 <b>行間隔→${autoAdjusted.rowSpacingMm}mm` +
      (autoAdjusted.stitchLenMm !== readOptions().stitchLenMm
        ? ` / ステッチ長→${autoAdjusted.stitchLenMm}mm`
        : "") +
      `</b></span>`
    : "";
  statsEl.innerHTML =
    `<span>総針数 <b${overLimit ? ' class="over"' : ""}>${stats.stitches.toLocaleString()}</b></span>` +
    `<span>糸切り <b>${stats.trims}</b>回</span>` +
    `<span>ジャンプ <b>${stats.jumps}</b>回</span>` +
    `<span>色替え <b>${stats.colorChanges}</b>回</span>` +
    `<span>サイズ <b>${stats.widthMm.toFixed(1)} × ${stats.heightMm.toFixed(1)} mm</b></span>` +
    `<span>推定時間 <b>約${stats.estMinutes}分</b></span>` +
    `<span>処理 <b>${ms}ms</b></span>` +
    adjustNote;

  const tooBig = stats.widthMm > HOOP_MM || stats.heightMm > HOOP_MM;
  warningEl.hidden = !tooBig && !overLimit;
  if (tooBig) {
    warningEl.textContent = `デザインが PP1 の枠 (${HOOP_MM}×${HOOP_MM}mm) を超えています。サイズを小さくしてください。`;
  } else if (overLimit) {
    warningEl.textContent =
      `密度を限界まで下げても最大針数 ${maxStitches.toLocaleString()} を超えています ` +
      `(現在 ${stats.stitches.toLocaleString()}針)。サイズ・色数・輪郭線の設定を見直してください。`;
  }

  renderThreadList();
  render();
  const ok = stats.stitches > 0 && !tooBig;
  exportPesBtn.disabled = !ok;
  exportDstBtn.disabled = !ok;
}

function renderThreadList(): void {
  threadList.innerHTML = "";
  if (!result) return;
  const { quant, colorOrder, pattern } = result;
  // パレット全色を表示し、ON/OFF を切り替えられるようにする。
  // threads は縫い順 (colorOrder) に並んでいるため、パレット番号から引く
  for (let c = 0; c < quant.palette.length; c++) {
    const pal = quant.palette[c];
    const li = document.createElement("li");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = enabledColors[c] !== false;
    cb.addEventListener("input", () => {
      enabledColors = quant.palette.map((_, i) =>
        i === c ? cb.checked : enabledColors[i] !== false,
      );
      scheduleUpdate();
    });
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = `rgb(${pal.r},${pal.g},${pal.b})`;
    const label = document.createElement("span");
    const sewIdx = colorOrder.indexOf(c);
    if (sewIdx >= 0 && sewIdx < pattern.threads.length && enabledColors[c] !== false) {
      const th = pattern.threads[sewIdx];
      label.textContent = `${th.name} (#${th.catalog})`;
    } else {
      label.textContent = "未使用";
    }
    const pct = document.createElement("span");
    pct.className = "muted";
    const total = quant.palette.reduce((s, p) => s + p.count, 0);
    pct.textContent = `${((pal.count / total) * 100).toFixed(0)}%`;
    li.append(cb, sw, label, pct);
    threadList.appendChild(li);
  }

  // 「色を変更」の変更先セレクトをパレットと同期 (選択は維持)
  const sel = $<HTMLSelectElement>("recolorTarget");
  const prev = sel.value;
  sel.innerHTML = "";
  for (let c = 0; c < quant.palette.length; c++) {
    const pal = quant.palette[c];
    const opt = document.createElement("option");
    opt.value = String(c);
    opt.textContent = `色${c + 1} rgb(${pal.r},${pal.g},${pal.b})`;
    opt.style.background = `rgb(${pal.r},${pal.g},${pal.b})`;
    sel.appendChild(opt);
  }
  if (prev !== "" && Number(prev) < quant.palette.length) sel.value = prev;
}

function render(): void {
  const ctx = stitchCanvas.getContext("2d")!;
  const W = stitchCanvas.width;
  ctx.clearRect(0, 0, W, W);

  // 枠とグリッド (100x100mm)
  const pxPerUnit = W / (HOOP_MM * 10 * 1.08);
  const origin = W / 2;
  ctx.strokeStyle = "#e3e3da";
  ctx.lineWidth = 1;
  for (let mm = -50; mm <= 50; mm += 10) {
    const p = origin + mm * 10 * pxPerUnit;
    ctx.beginPath();
    ctx.moveTo(p, origin - 500 * pxPerUnit);
    ctx.lineTo(p, origin + 500 * pxPerUnit);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(origin - 500 * pxPerUnit, p);
    ctx.lineTo(origin + 500 * pxPerUnit, p);
    ctx.stroke();
  }
  ctx.strokeStyle = "#c2675d";
  ctx.lineWidth = 2;
  ctx.strokeRect(
    origin - 500 * pxPerUnit,
    origin - 500 * pxPerUnit,
    1000 * pxPerUnit,
    1000 * pxPerUnit,
  );

  if (!result) return;
  const { pattern } = result;
  const showJumps = $<HTMLInputElement>("showJumps").checked;

  let colorIdx = 0;
  let prev: { x: number; y: number } | null = null;
  ctx.lineWidth = Math.max(1, 4 * pxPerUnit);
  ctx.lineCap = "round";

  for (const s of pattern.stitches) {
    const px = origin + s.x * pxPerUnit;
    const py = origin + s.y * pxPerUnit;
    if (s.cmd === STITCH) {
      if (prev) {
        const th = pattern.threads[Math.min(colorIdx, pattern.threads.length - 1)];
        ctx.strokeStyle = th ? `rgb(${th.r},${th.g},${th.b})` : "#000";
        ctx.beginPath();
        ctx.moveTo(origin + prev.x * pxPerUnit, origin + prev.y * pxPerUnit);
        ctx.lineTo(px, py);
        ctx.stroke();
      }
      prev = { x: s.x, y: s.y };
    } else if (s.cmd === JUMP) {
      if (showJumps && prev) {
        ctx.strokeStyle = "rgba(120,120,120,0.45)";
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(origin + prev.x * pxPerUnit, origin + prev.y * pxPerUnit);
        ctx.lineTo(px, py);
        ctx.stroke();
        ctx.restore();
      }
      prev = { x: s.x, y: s.y };
    } else if (s.cmd === TRIM) {
      if (showJumps) {
        // 糸切り位置: 赤い✕
        ctx.save();
        ctx.strokeStyle = "#e0312f";
        ctx.lineWidth = 2;
        const r = 5;
        ctx.beginPath();
        ctx.moveTo(px - r, py - r);
        ctx.lineTo(px + r, py + r);
        ctx.moveTo(px + r, py - r);
        ctx.lineTo(px - r, py + r);
        ctx.stroke();
        ctx.restore();
      }
    } else if (s.cmd === COLOR_CHANGE) {
      colorIdx++;
      if (showJumps) {
        // 色替え位置: 青い◆
        ctx.save();
        ctx.fillStyle = "#3a7bd5";
        const r = 6;
        ctx.beginPath();
        ctx.moveTo(px, py - r);
        ctx.lineTo(px + r, py);
        ctx.lineTo(px, py + r);
        ctx.lineTo(px - r, py);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // 抜き指定マーカー (×)
  const v = result.view;
  ctx.strokeStyle = "#d04040";
  ctx.lineWidth = 2;
  for (const [ex, ey] of excludePoints) {
    const ux = (ex - v.cx) * v.scale + v.offsetX;
    const uy = (ey - v.cy) * v.scale + v.offsetY;
    const px = origin + ux * pxPerUnit;
    const py = origin + uy * pxPerUnit;
    const r = 6;
    ctx.beginPath();
    ctx.moveTo(px - r, py - r);
    ctx.lineTo(px + r, py + r);
    ctx.moveTo(px + r, py - r);
    ctx.lineTo(px - r, py + r);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, r + 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 色変更マーカー (変更先の色の丸 + 筆記号)
  if (recolorPoints.length > 0 && result) {
    const palette = result.quant.palette;
    for (const { x: rx, y: ry, color } of recolorPoints) {
      const ux = (rx - v.cx) * v.scale + v.offsetX;
      const uy = (ry - v.cy) * v.scale + v.offsetY;
      const px = origin + ux * pxPerUnit;
      const py = origin + uy * pxPerUnit;
      const pal = palette[color];
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.fillStyle = pal ? `rgb(${pal.r},${pal.g},${pal.b})` : "#888";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#222";
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ------------------------------------------------------ クリックで抜き指定

/** 除外マスク上の連結成分 (クリック解除用) */
function maskComponent(mask: Uint8Array, w: number, h: number, sx: number, sy: number): Set<number> {
  const comp = new Set<number>();
  const start = sy * w + sx;
  if (!mask[start]) return comp;
  comp.add(start);
  const queue = [start];
  while (queue.length > 0) {
    const i = queue.pop()!;
    const ix = i % w;
    const iy = (i / w) | 0;
    const neighbors = [
      ix > 0 ? i - 1 : -1,
      ix < w - 1 ? i + 1 : -1,
      iy > 0 ? i - w : -1,
      iy < h - 1 ? i + w : -1,
    ];
    for (const ni of neighbors) {
      if (ni >= 0 && mask[ni] && !comp.has(ni)) {
        comp.add(ni);
        queue.push(ni);
      }
    }
  }
  return comp;
}

/**
 * クリック位置の近傍から縫い領域 (または抜き済み領域) を探す。
 * 細い線や領域の境界をクリックしたときに 1px のずれで外れないように
 * リング状に半径を広げて走査する。
 */
function findClickTarget(
  ix: number,
  iy: number,
): { x: number; y: number; excluded: boolean } | null {
  if (!result) return null;
  const { width: w, height: h, labels } = result.quant;
  const mask = result.excludedMask;
  const maxR = Math.max(4, Math.round(Math.max(w, h) * 0.012));
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // リングのみ走査
        const x = ix + dx;
        const y = iy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const idx = y * w + x;
        if (mask && mask[idx]) return { x, y, excluded: true };
        if (labels[idx] >= 0) return { x, y, excluded: false };
      }
    }
  }
  return null;
}

stitchCanvas.addEventListener("click", (e) => {
  if (!result || !sourceImage) return;
  const rect = stitchCanvas.getBoundingClientRect();
  const canvasX = (e.clientX - rect.left) * (stitchCanvas.width / rect.width);
  const canvasY = (e.clientY - rect.top) * (stitchCanvas.height / rect.height);
  const W = stitchCanvas.width;
  const pxPerUnit = W / (HOOP_MM * 10 * 1.08);
  const origin = W / 2;
  // キャンバス座標 → パターン座標 (0.1mm) → 処理画像ピクセル座標
  const ux = (canvasX - origin) / pxPerUnit;
  const uy = (canvasY - origin) / pxPerUnit;
  const v = result.view;
  const ix = Math.round((ux - v.offsetX) / v.scale + v.cx);
  const iy = Math.round((uy - v.offsetY) / v.scale + v.cy);

  const target = findClickTarget(ix, iy);
  if (!target) return; // 背景クリックは無視

  const { width: qw, height: qh } = result.quant;
  const recolorMode = $<HTMLInputElement>("modeRecolor").checked;

  if (recolorMode) {
    // 色の変更: クリックした連結領域を選択中の色に塗り替える
    const colorIdx = Number($<HTMLSelectElement>("recolorTarget").value);
    if (!Number.isFinite(colorIdx) || colorIdx < 0) return;
    if (target.excluded) return; // 抜き済み領域は対象外
    recolorPoints.push({ x: target.x, y: target.y, color: colorIdx });
  } else if (target.excluded) {
    // すでに抜き指定された領域をクリック → 解除
    const comp = maskComponent(result.excludedMask!, qw, qh, target.x, target.y);
    excludePoints = excludePoints.filter(([qx, qy]) => !comp.has(qy * qw + qx));
  } else {
    excludePoints.push([target.x, target.y]);
  }
  update();
});

$("clearExclude").addEventListener("click", () => {
  if (excludePoints.length === 0 && recolorPoints.length === 0) return;
  resetClickEdits();
  update();
});

// ------------------------------------------------------------ 書き出し

// スマホ判定 (iPadOS は Mac を名乗るため maxTouchPoints で判別)
const isMobile =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const exportStatusEl = $("exportStatus");

function setExportStatus(msg: string): void {
  exportStatusEl.textContent = msg;
}

/**
 * ファイルの書き出し。
 * - スマホ: 共有シート (Web Share API) でファイルを直接「ファイルに保存」や
 *   Artspira へ渡す。リンク式ダウンロードはモバイルブラウザで動かない・
 *   保存先が分からないことが多いため
 * - PC / 非対応ブラウザ: 従来どおりダウンロード
 */
async function exportFile(data: Uint8Array, filename: string): Promise<void> {
  const blob = new Blob([data.buffer as ArrayBuffer], { type: "application/octet-stream" });

  if (isMobile && typeof navigator.share === "function") {
    try {
      const file = new File([blob], filename, { type: "application/octet-stream" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        setExportStatus(`${filename} を共有しました`);
        return;
      }
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") {
        setExportStatus("共有をキャンセルしました");
        return;
      }
      // 共有に失敗した場合は通常ダウンロードにフォールバック
      console.warn("share failed, falling back to download:", err);
    }
  }

  const url = URL.createObjectURL(blob);
  // download 属性非対応 (一部のアプリ内ブラウザ) は新しいタブで開く
  if (!("download" in HTMLAnchorElement.prototype)) {
    window.open(url, "_blank");
    setExportStatus("新しいタブで開きました。共有メニューから保存してください");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setExportStatus(`${filename} をダウンロードしました (端末のダウンロードフォルダを確認)`);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

exportPesBtn.addEventListener("click", () => {
  if (!result) return;
  void exportFile(writePes(result.pattern), `${designName}.pes`);
});

exportDstBtn.addEventListener("click", () => {
  if (!result) return;
  void exportFile(writeDst(result.pattern), `${designName}.dst`);
});

render();
