// Phase 1 の最小確認ページ。
// デモ StitchPlan をプレビューし、PES/DST をダウンロードできる。
// 本格的な UI は Phase 5 で構築する。

import { HOOP_SIZE, UNIT_MM } from "../core/constants";
import { countStitches, countTrims, planBounds } from "../core/plan";
import type { StitchPlan } from "../core/types";
import { writeDst } from "../export/dst";
import { writePes } from "../export/pes";
import { validatePlan } from "../export/validate";
import { buildDemoPlan } from "./demo";
import "./app.css";

declare const __APP_VERSION__: string;

function download(filename: string, data: Uint8Array): void {
  const blob = new Blob([data.buffer as ArrayBuffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function renderPreview(canvas: HTMLCanvasElement, plan: StitchPlan): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const scale = canvas.width / (HOOP_SIZE * 1.1);
  const toX = (v: number): number => canvas.width / 2 + v * scale;
  const toY = (v: number): number => canvas.height / 2 + v * scale;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 100mm 枠
  ctx.strokeStyle = "#c0c8d0";
  ctx.lineWidth = 1;
  ctx.strokeRect(
    toX(-HOOP_SIZE / 2),
    toY(-HOOP_SIZE / 2),
    HOOP_SIZE * scale,
    HOOP_SIZE * scale,
  );

  for (const block of plan.blocks) {
    ctx.strokeStyle = `rgb(${block.thread.r},${block.thread.g},${block.thread.b})`;
    ctx.lineWidth = 0.8;
    for (const run of block.runs) {
      ctx.beginPath();
      run.stitches.forEach((p, i) => {
        if (i === 0) ctx.moveTo(toX(p.x), toY(p.y));
        else ctx.lineTo(toX(p.x), toY(p.y));
      });
      ctx.stroke();
    }
  }
}

function main(): void {
  const app = document.getElementById("app");
  if (!app) return;

  const plan = buildDemoPlan();
  const result = validatePlan(plan);
  const bounds = planBounds(plan);
  const sizeText = bounds
    ? `${((bounds.maxX - bounds.minX) * UNIT_MM).toFixed(1)} × ${((bounds.maxY - bounds.minY) * UNIT_MM).toFixed(1)} mm`
    : "-";

  app.innerHTML = `
    <header>
      <h1>PP1 Stitch Studio <span class="version">v${__APP_VERSION__} (Phase 1)</span></h1>
    </header>
    <main>
      <canvas id="preview" width="560" height="560"></canvas>
      <aside>
        <h2>デモデザイン</h2>
        <dl>
          <dt>針数</dt><dd>${countStitches(plan)}</dd>
          <dt>色数</dt><dd>${plan.blocks.length}</dd>
          <dt>糸切り回数</dt><dd>${countTrims(plan)}</dd>
          <dt>サイズ</dt><dd>${sizeText}</dd>
        </dl>
        <div id="validation" class="${result.ok ? "ok" : "error"}">
          ${result.ok ? "✓ 検証OK" : "✗ エラーあり"}
          ${result.issues.map((i) => `<p class="${i.severity}">${i.message}</p>`).join("")}
        </div>
        <button id="dl-pes">PES をダウンロード</button>
        <button id="dl-dst">DST をダウンロード</button>
        <p class="note">Phase 1: エクスポーター基盤のみ。画像読み込みは Phase 2 で実装。</p>
      </aside>
    </main>
  `;

  renderPreview(document.getElementById("preview") as HTMLCanvasElement, plan);

  document.getElementById("dl-pes")?.addEventListener("click", () => {
    download("phase1-demo.pes", writePes(plan).data);
  });
  document.getElementById("dl-dst")?.addEventListener("click", () => {
    download("phase1-demo.dst", writeDst(plan));
  });
}

main();
