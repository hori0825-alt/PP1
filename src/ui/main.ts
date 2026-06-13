// Phase 3 の確認ページ。
// PNG/JPG/BMP/SVG → 色数削減 → 領域抽出 → タタミ生成 → PES/DST 出力の一気通貫。
// 表示切替: 元画像 / 減色後 / ベクター / ステッチ。
// 本格的な UI (シーケンスビュー等) は Phase 5 で構築する。

import { HOOP_SIZE, UNIT_MM, mm } from "../core/constants";
import { countStitches, countTrims } from "../core/plan";
import type { Region } from "../core/region";
import type { StitchPlan } from "../core/types";
import { signedArea } from "../core/geometry";
import { quantize } from "../import/quantize";
import type { LabelMap, RasterImage } from "../import/raster";
import { extractRegions, fitUnitsPerPixel } from "../import/regions";
import { importSvg } from "../import/svg";
import type { TrimMode } from "../plan/connect";
import { autoReduce } from "../plan/reduce";
import { planStats } from "../plan/stats";
import { digitizeRegions } from "../stitch/digitize";
import { writeDst } from "../export/dst";
import { writePes } from "../export/pes";
import type { ValidationResult } from "../export/validate";
import { validatePlan } from "../export/validate";
import { buildDemoPlan } from "./demo";
import { decodeImageFile } from "./loadImage";
import "./app.css";

declare const __APP_VERSION__: string;

type ViewMode = "original" | "quantized" | "vector" | "stitch";

interface AppState {
  raster: RasterImage | null;
  labelMap: LabelMap | null;
  regions: Region[];
  plan: StitchPlan | null;
  validation: ValidationResult | null;
  stitchWarnings: string[];
  svgText: string | null;
  fileName: string;
  view: ViewMode;
  colorCount: number;
  removeWhite: boolean;
  targetSizeMm: number;
  angleDeg: number;
  trimMode: TrimMode;
  /** 自動削減の適用内容 (表示用) */
  reduceApplied: string[];
}

const state: AppState = {
  raster: null,
  labelMap: null,
  regions: [],
  plan: null,
  validation: null,
  stitchWarnings: [],
  svgText: null,
  fileName: "design",
  view: "stitch",
  colorCount: 6,
  removeWhite: true,
  targetSizeMm: 100,
  angleDeg: 45,
  trimMode: "auto",
  reduceApplied: [],
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
  if (state.regions.length > 0) {
    const result = digitizeRegions(state.regions, state.fileName.slice(0, 8).toUpperCase(), {
      angleDeg: state.angleDeg,
      trimMode: state.trimMode,
    });
    state.plan = result.plan;
    state.stitchWarnings = result.warnings;
    state.validation = validatePlan(result.plan);
  } else {
    state.plan = null;
    state.validation = null;
    state.stitchWarnings = [];
  }
  state.reduceApplied = [];
  render();
}

/** 自動針数削減を実行して結果を反映する */
function runAutoReduce(): void {
  if (state.regions.length === 0) return;
  const result = autoReduce(state.regions, state.fileName.slice(0, 8).toUpperCase(), {
    angleDeg: state.angleDeg,
    trimMode: state.trimMode,
  });
  state.regions = result.regions;
  state.plan = result.plan;
  state.validation = validatePlan(result.plan);
  state.reduceApplied = [
    `針数 ${result.before} → ${result.after}`,
    ...result.applied,
  ];
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

  if ((state.view === "original" || state.view === "quantized") && state.raster) {
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

  if (state.view === "stitch" && state.plan) {
    // ステッチ表示: Run 内は実線、Run 間の渡りは点線
    for (const block of state.plan.blocks) {
      const color = `rgb(${block.thread.r},${block.thread.g},${block.thread.b})`;
      let prev: { x: number; y: number } | null = null;
      for (const run of block.runs) {
        if (prev && run.stitches.length > 0) {
          ctx.strokeStyle = "#99999988";
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(toX(prev.x), toY(prev.y));
          ctx.lineTo(toX(run.stitches[0].x), toY(run.stitches[0].y));
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        run.stitches.forEach((p, i) => {
          if (i === 0) ctx.moveTo(toX(p.x), toY(p.y));
          else ctx.lineTo(toX(p.x), toY(p.y));
        });
        ctx.stroke();
        if (run.stitches.length > 0) prev = run.stitches[run.stitches.length - 1];
      }
    }
    return;
  }

  // ベクター表示
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

function statsPanel(): string {
  if (!state.plan || !state.validation) {
    return "<p class=\"note\">画像または SVG を読み込んでください。</p>";
  }
  const v = state.validation;
  const stats = planStats(state.plan);
  const issuesHtml = [...v.issues.map((i) => ({ sev: i.severity, msg: i.message })),
    ...state.stitchWarnings.map((w) => ({ sev: "warning" as const, msg: w }))]
    .map((i) => `<p class="${i.sev}">${i.sev === "error" ? "✗" : "⚠"} ${i.msg}</p>`)
    .join("");
  const overLimit = v.issues.some((i) => i.code === "stitch-count-exceeded");
  const reducedHtml =
    state.reduceApplied.length > 0
      ? `<div class="reduced">${state.reduceApplied.map((s) => `<p>✓ ${s}</p>`).join("")}</div>`
      : "";
  return `
    <dl>
      <dt>針数</dt><dd>${countStitches(state.plan)}</dd>
      <dt>色数</dt><dd>${v.stats.colorCount}</dd>
      <dt>糸切り</dt><dd>${countTrims(state.plan)} 回</dd>
      <dt>色替え</dt><dd>${v.stats.colorChanges} 回</dd>
      <dt>渡り糸</dt><dd>最大 ${(stats.travel.max * UNIT_MM).toFixed(1)} / 平均 ${(stats.travel.avg * UNIT_MM).toFixed(1)} mm</dd>
      <dt>推定時間</dt><dd>約 ${Math.ceil(stats.estMinutes)} 分</dd>
      <dt>サイズ</dt><dd>${(v.stats.width * UNIT_MM).toFixed(1)} × ${(v.stats.height * UNIT_MM).toFixed(1)} mm</dd>
    </dl>
    <div id="validation" class="${v.ok ? "ok" : "error"}">
      ${v.ok ? "✓ 出力可能" : "✗ 修正が必要"}
      ${issuesHtml}
    </div>
    ${overLimit ? `<button id="reduce">自動針数削減を実行</button>` : ""}
    ${reducedHtml}
  `;
}

function regionSummary(): string {
  if (state.regions.length === 0) return "";
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
        <td>${(e.area * UNIT_MM * UNIT_MM).toFixed(0)} mm²</td>
      </tr>`,
    )
    .join("");
  return `
    <table class="colors">
      <thead><tr><th>色</th><th>領域</th><th>面積</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function render(): void {
  const app = document.getElementById("app");
  if (!app) return;
  const hasImage = state.raster !== null && state.svgText === null;
  const canExport = state.plan !== null && state.validation !== null && state.validation.ok;

  app.innerHTML = `
    <header>
      <h1>PP1 Stitch Studio <span class="version">v${__APP_VERSION__} (Phase 3)</span></h1>
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
        <label>角度
          <select id="angle">
            ${[0, 45, 90, 135]
              .map((v) => `<option value="${v}" ${v === state.angleDeg ? "selected" : ""}>${v}°</option>`)
              .join("")}
          </select>
        </label>
        <label>糸切り
          <select id="trim">
            <option value="auto" ${state.trimMode === "auto" ? "selected" : ""}>自動 (距離判定)</option>
            <option value="never" ${state.trimMode === "never" ? "selected" : ""}>切らない</option>
            <option value="always" ${state.trimMode === "always" ? "selected" : ""}>常に切る</option>
          </select>
        </label>
        <label>表示
          <select id="view">
            <option value="original" ${state.view === "original" ? "selected" : ""}>元画像</option>
            <option value="quantized" ${state.view === "quantized" ? "selected" : ""}>減色後</option>
            <option value="vector" ${state.view === "vector" ? "selected" : ""}>ベクター</option>
            <option value="stitch" ${state.view === "stitch" ? "selected" : ""}>ステッチ</option>
          </select>
        </label>
        <h2>診断</h2>
        <div id="summary">${statsPanel()}${regionSummary()}</div>
        <h2>出力</h2>
        <button id="dl-pes" ${canExport ? "" : "disabled"}>PES をダウンロード</button>
        <button id="dl-dst" ${canExport ? "" : "disabled"}>DST をダウンロード</button>
        <button id="dl-demo" class="secondary">デモデザイン (PES)</button>
        <p class="note">縫い順・糸切り最適化は Phase 4 で実装。</p>
      </aside>
    </main>
  `;

  renderCanvas();

  document.getElementById("file")?.addEventListener("change", (e) => {
    void (async (): Promise<void> => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      state.fileName = file.name.replace(/\.[^.]+$/, "") || "design";
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
  document.getElementById("angle")?.addEventListener("change", (e) => {
    state.angleDeg = Number((e.target as HTMLSelectElement).value);
    recompute();
  });
  document.getElementById("trim")?.addEventListener("change", (e) => {
    state.trimMode = (e.target as HTMLSelectElement).value as TrimMode;
    recompute();
  });
  document.getElementById("reduce")?.addEventListener("click", () => {
    runAutoReduce();
  });
  document.getElementById("view")?.addEventListener("change", (e) => {
    state.view = (e.target as HTMLSelectElement).value as ViewMode;
    render();
  });
  document.getElementById("dl-pes")?.addEventListener("click", () => {
    if (state.plan) download(`${state.fileName}.pes`, writePes(state.plan).data);
  });
  document.getElementById("dl-dst")?.addEventListener("click", () => {
    if (state.plan) download(`${state.fileName}.dst`, writeDst(state.plan));
  });
  document.getElementById("dl-demo")?.addEventListener("click", () => {
    download("demo.pes", writePes(buildDemoPlan()).data);
  });
}

render();
