import "./style.css";
import { digitize, type DigitizeResult } from "./digitize/pipeline";
import { COLOR_CHANGE, JUMP, STITCH } from "./embroidery/pattern";
import { writePes } from "./embroidery/pes";
import { writeDst } from "./embroidery/dst";

const HOOP_MM = 100; // PP1 の刺しゅう範囲 100x100mm
const PROCESS_MAX_PX = 600; // 処理解像度の上限 (長辺)

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

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
let result: DigitizeResult | null = null;
let enabledColors: boolean[] = [];

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
  update();
});

// ------------------------------------------------------------ 変換と描画

function readOptions() {
  return {
    sizeMm: clamp(Number($<HTMLInputElement>("sizeMm").value) || 90, 10, HOOP_MM),
    maxColors: clamp(Number($<HTMLInputElement>("maxColors").value) || 6, 1, 12),
    rowSpacingMm: clamp(Number($<HTMLInputElement>("rowSpacing").value) || 0.4, 0.2, 1),
    stitchLenMm: clamp(Number($<HTMLInputElement>("stitchLen").value) || 3, 1, 7),
    angleDeg: Number($<HTMLInputElement>("angle").value) || 0,
    minRegionMm2: clamp(Number($<HTMLInputElement>("minRegion").value) || 0, 0, 20),
    fill: $<HTMLInputElement>("fillOn").checked,
    outline: $<HTMLInputElement>("outlineOn").checked,
    autoBackground: $<HTMLInputElement>("autoBg").checked,
    enabledColors: enabledColors.length > 0 ? enabledColors : undefined,
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

for (const id of ["sizeMm", "maxColors", "rowSpacing", "stitchLen", "angle", "minRegion", "fillOn", "outlineOn", "autoBg"]) {
  $(id).addEventListener("input", () => {
    if (id === "maxColors" || id === "autoBg" || id === "minRegion") enabledColors = [];
    scheduleUpdate();
  });
}
$("showJumps").addEventListener("input", () => render());

function update(): void {
  if (!sourceImage) return;
  const t0 = performance.now();
  try {
    result = digitize(sourceImage, readOptions());
    result.pattern.name = designName;
  } catch (err) {
    console.error(err);
    warningEl.hidden = false;
    warningEl.textContent = `変換エラー: ${err}`;
    return;
  }
  const ms = Math.round(performance.now() - t0);

  const { stats } = result;
  statsEl.innerHTML =
    `<span>ステッチ数 <b>${stats.stitches.toLocaleString()}</b></span>` +
    `<span>色数 <b>${stats.colors}</b></span>` +
    `<span>サイズ <b>${stats.widthMm.toFixed(1)} × ${stats.heightMm.toFixed(1)} mm</b></span>` +
    `<span>推定時間 <b>約${stats.estMinutes}分</b></span>` +
    `<span>処理 <b>${ms}ms</b></span>`;

  const tooBig = stats.widthMm > HOOP_MM || stats.heightMm > HOOP_MM;
  warningEl.hidden = !tooBig;
  if (tooBig) {
    warningEl.textContent = `デザインが PP1 の枠 (${HOOP_MM}×${HOOP_MM}mm) を超えています。サイズを小さくしてください。`;
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
  // パレット全色を表示し、ON/OFF を切り替えられるようにする
  let threadIdx = 0;
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
    const isStitched = colorOrder.includes(c) && enabledColors[c] !== false;
    if (isStitched && threadIdx < pattern.threads.length) {
      const th = pattern.threads[threadIdx++];
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
    } else if (s.cmd === COLOR_CHANGE) {
      colorIdx++;
    }
  }
}

// ------------------------------------------------------------ 書き出し

function download(data: Uint8Array, filename: string): void {
  const blob = new Blob([data.buffer as ArrayBuffer], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

exportPesBtn.addEventListener("click", () => {
  if (!result) return;
  download(writePes(result.pattern), `${designName}.pes`);
});

exportDstBtn.addEventListener("click", () => {
  if (!result) return;
  download(writeDst(result.pattern), `${designName}.dst`);
});

render();
