// Phase 2 の確認ページ。
// PNG/JPG/BMP/SVG を読み込み、色数削減 → 領域抽出の結果をプレビューする。
// 表示切替: 元画像 / 減色後 / ベクター輪郭。
// 本格的な UI (シーケンスビュー等) は Phase 5 で構築する。

import { HOOP_SIZE, UNIT_MM, mm } from "../core/constants";
import type { Region } from "../core/region";
import { signedArea } from "../core/geometry";
import { quantize } from "../import/quantize";
import type { LabelMap, RasterImage } from "../import/raster";
import { extractRegions, fitUnitsPerPixel } from "../import/regions";
import { importSvg } from "../import/svg";
import { writeDst } from "../export/dst";
import { writePes } from "../export/pes";
import { validatePlan } from "../export/validate";
import { buildDemoPlan } from "./demo";
import { decodeImageFile } from "./loadImage";
import "./app.css";

declare const __APP_VERSION__: string;

type ViewMode = "original" | "quantized" | "vector";

interface AppState {
  raster: RasterImage | null;
  labelMap: LabelMap | null;
  regions: Region[];
  svgText: string | null;
  view: ViewMode;
  colorCount: number;
  removeWhite: boolean;
  targetSizeMm: number;
}

const state: AppState = {
  raster: null,
  labelMap: null,
  regions: [],
  svgText: null,
  view: "vector",
  colorCount: 6,
  removeWhite: true,
  targetSizeMm: 100,
};

function download(filename: string, data: Uint8Array): void {
  const blob = new Blob([data.buffer as ArrayBuffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function recompute(): void {
  if (state.svgText !== null) {
    state.regions = importSvg(state.svgText, mm(state.targetSizeMm)).regions;
    state.labelMap = null;
  } else if (state.raster !== null) {
    state.labelMap = quantize(state.raster, {
      colorCount: state.colorCount,
      removeWhiteBackground: state.removeWhite,
    });
    state.regions = extractRegions(state.labelMap, {
      unitsPerPixel: fitUnitsPerPixel(state.raster.width, state.raster.height, mm(state.targetSizeMm)),
    });
  }
  render();
}

function drawHoop(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, scale: number): void {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#c0c8d0";
  ctx.lineWidth = 1;
  ctx.strokeRect(
    canvas.width / 2 - (HOOP_SIZE / 2) * scale,
    canvas.height / 2 - (HOOP_SIZE / 2) * scale,
    HOOP_SIZE * scale,
    HOOP_SIZE * scale,
  );
}

function renderCanvas(): void {
  const canvas = document.getElementById("preview") as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const scale = canvas.width / (HOOP_SIZE * 1.1);
  drawHoop(ctx, canvas, scale);
  const toX = (v: number): number => canvas.width / 2 + v * scale;
  const toY = (v: number): number => canvas.height / 2 + v * scale;

  if (state.view !== "vector" && state.raster) {
    const img = state.raster;
    const upp = fitUnitsPerPixel(img.width, img.height, mm(state.targetSizeMm));
    const tmp = document.createElement("canvas");
    tmp.width = img.width;
    tmp.height = img.height;
    const tctx = tmp.getContext("2d");
    if (!tctx) return;
    const out = tctx.createImageData(img.width, img.height);
    if (state.view === "original" || !state.labelMap) {
      out.data.set(img.data);
    } else {
      const lm = state.labelMap;
      for (let i = 0; i < lm.labels.length; i++) {
        const v = lm.labels[i];
        if (v === -1) {
          out.data[i * 4 + 3] = 0;
        } else {
          const c = lm.palette[v];
          out.data[i * 4] = c.r;
          out.data[i * 4 + 1] = c.g;
          out.data[i * 4 + 2] = c.b;
          out.data[i * 4 + 3] = 255;
        }
      }
    }
    tctx.putImageData(out, 0, 0);
    const dw = img.width * upp * scale;
    const dh = img.height * upp * scale;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, canvas.width / 2 - dw / 2, canvas.height / 2 - dh / 2, dw, dh);
    return;
  }

  // ベクター表示: 領域を塗り + 輪郭線
  for (const region of state.regions) {
    const path = new Path2D();
    const trace = (pts: { x: number; y: number }[]): void => {
      pts.forEach((p, i) => {
        if (i === 0) path.moveTo(toX(p.x), toY(p.y));
        else path.lineTo(toX(p.x), toY(p.y));
      });
      path.closePath();
    };
    trace(region.outer);
    for (const hole of region.holes) trace(hole);
    ctx.fillStyle = `rgba(${region.color.r},${region.color.g},${region.color.b},0.85)`;
    ctx.fill(path, "evenodd");
    ctx.strokeStyle = region.selfIntersecting ? "#e02020" : "#00000040";
    ctx.lineWidth = region.selfIntersecting ? 2 : 0.7;
    ctx.stroke(path);
  }
}

function regionSummary(): string {
  if (state.regions.length === 0) return "<p class=\"note\">画像または SVG を読み込んでください。</p>";
  const colorKey = (r: Region): string => `${r.color.r},${r.color.g},${r.color.b}`;
  const byColor = new Map<string, { color: Region["color"]; count: number; area: number }>();
  for (const r of state.regions) {
    const key = colorKey(r);
    const entry = byColor.get(key) ?? { color: r.color, count: 0, area: 0 };
    entry.count++;
    entry.area +=
      Math.abs(signedArea(r.outer)) - r.holes.reduce((s, hh) => s + Math.abs(signedArea(hh)), 0);
    byColor.set(key, entry);
  }
  const rows = [...byColor.values()]
    .sort((a, b) => b.area - a.area)
    .map(
      (e) => `<tr>
        <td><span class="swatch" style="background:rgb(${e.color.r},${e.color.g},${e.color.b})"></span></td>
        <td>${e.count}</td>
        <td>${(e.area * UNIT_MM * UNIT_MM).toFixed(1)} mm²</td>
      </tr>`,
    )
    .join("");
  const selfX = state.regions.filter((r) => r.selfIntersecting).length;
  return `
    <table class="colors">
      <thead><tr><th>色</th><th>領域</th><th>面積</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">領域 ${state.regions.length} / 色 ${byColor.size}${selfX > 0 ? ` / ⚠ 自己交差 ${selfX}` : ""}</p>
  `;
}

function render(): void {
  const app = document.getElementById("app");
  if (!app) return;
  const hasImage = state.raster !== null && state.svgText === null;

  app.innerHTML = `
    <header>
      <h1>PP1 Stitch Studio <span class="version">v${__APP_VERSION__} (Phase 2)</span></h1>
    </header>
    <main>
      <canvas id="preview" width="560" height="560"></canvas>
      <aside>
        <h2>読み込み</h2>
        <input type="file" id="file" accept=".png,.jpg,.jpeg,.bmp,.svg" />
        <label>サイズ
          <select id="size">
            ${[100, 70, 50, 30, 20]
              .map(
                (v) =>
                  `<option value="${v}" ${v === state.targetSizeMm ? "selected" : ""}>${v / 10} cm</option>`,
              )
              .join("")}
          </select>
        </label>
        <label ${hasImage ? "" : "class=\"disabled\""}>色数
          <input type="range" id="colors" min="2" max="15" value="${state.colorCount}" ${hasImage ? "" : "disabled"} />
          <span>${state.colorCount}</span>
        </label>
        <label ${hasImage ? "" : "class=\"disabled\""}>
          <input type="checkbox" id="white" ${state.removeWhite ? "checked" : ""} ${hasImage ? "" : "disabled"} />
          白背景を除去
        </label>
        <label>表示
          <select id="view">
            <option value="original" ${state.view === "original" ? "selected" : ""}>元画像</option>
            <option value="quantized" ${state.view === "quantized" ? "selected" : ""}>減色後</option>
            <option value="vector" ${state.view === "vector" ? "selected" : ""}>ベクター</option>
          </select>
        </label>
        <h2>結果</h2>
        <div id="summary">${regionSummary()}</div>
        <h2>Phase 1 デモ出力</h2>
        <button id="dl-pes">デモ PES</button>
        <button id="dl-dst">デモ DST</button>
        <p class="note">領域→ステッチ生成は Phase 3 で実装。</p>
      </aside>
    </main>
  `;

  renderCanvas();

  document.getElementById("file")?.addEventListener("change", (e) => {
    void (async (): Promise<void> => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (file.name.toLowerCase().endsWith(".svg")) {
        state.svgText = await file.text();
        state.raster = null;
      } else {
        state.raster = await decodeImageFile(file);
        state.svgText = null;
      }
      recompute();
    })();
  });
  document.getElementById("size")?.addEventListener("change", (e) => {
    state.targetSizeMm = Number((e.target as HTMLSelectElement).value);
    recompute();
  });
  document.getElementById("colors")?.addEventListener("change", (e) => {
    state.colorCount = Number((e.target as HTMLInputElement).value);
    recompute();
  });
  document.getElementById("white")?.addEventListener("change", (e) => {
    state.removeWhite = (e.target as HTMLInputElement).checked;
    recompute();
  });
  document.getElementById("view")?.addEventListener("change", (e) => {
    state.view = (e.target as HTMLSelectElement).value as ViewMode;
    render();
  });
  document.getElementById("dl-pes")?.addEventListener("click", () => {
    const plan = buildDemoPlan();
    if (validatePlan(plan).ok) download("phase1-demo.pes", writePes(plan).data);
  });
  document.getElementById("dl-dst")?.addEventListener("click", () => {
    const plan = buildDemoPlan();
    if (validatePlan(plan).ok) download("phase1-demo.dst", writeDst(plan));
  });
}

render();
