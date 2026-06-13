// 作業指示書の出力 (ブラウザ層)。
// 作業指示書データ + QR + プレビューを HTML 化し、印刷ウィンドウで PDF 保存する
// (依存追加なし。ブラウザの「PDF に保存」を利用)。QR/プレビューの画像保存も提供。

import type { StitchPlan } from "../core/types";
import { planToSvg } from "../export/svgPreview";
import { encodeQr, qrToSvg } from "../report/qr";
import { buildWorkOrder } from "../report/workorder";
import type { WorkOrder } from "../report/workorder";

export interface ReportContext {
  plan: StitchPlan;
  projectId: string;
  designName: string;
  fileName: string;
  createdAt: string;
  fabricId: string;
}

function workOrderHtml(wo: WorkOrder, qrSvg: string, previewSvg: string): string {
  const rows = wo.threads
    .map(
      (t) => `<tr>
        <td>${t.order}</td>
        <td><span class="sw" style="background:rgb(${t.rgb.r},${t.rgb.g},${t.rgb.b})"></span></td>
        <td>#${t.pecIndex} ${t.name}</td>
        <td>${t.stitches.toLocaleString()}</td>
      </tr>`,
    )
    .join("");
  const notes = wo.notes.length
    ? `<div class="notes">${wo.notes.map((n) => `<p>⚠ ${n}</p>`).join("")}</div>`
    : "";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
    <title>作業指示書 ${wo.projectId}</title>
    <style>
      body{font-family:"Hiragino Sans","Noto Sans JP",system-ui,sans-serif;color:#222;margin:24px;}
      h1{font-size:18px;margin:0 0 4px;}
      .sub{color:#888;font-size:12px;margin-bottom:16px;}
      .grid{display:flex;gap:24px;align-items:flex-start;}
      .preview{border:1px solid #ddd;border-radius:6px;}
      table{border-collapse:collapse;font-size:13px;width:100%;margin-top:8px;}
      th,td{border-bottom:1px solid #eee;padding:4px 8px;text-align:left;}
      .sw{display:inline-block;width:14px;height:14px;border-radius:3px;border:1px solid #0002;vertical-align:middle;}
      dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:13px;}
      dt{color:#888;}
      .qr{margin-top:12px;text-align:center;}
      .notes{background:#fdeeee;color:#a02828;padding:8px 12px;border-radius:6px;font-size:12px;margin-top:12px;}
      @media print{button{display:none;}}
    </style></head><body>
    <h1>刺繍 作業指示書</h1>
    <div class="sub">プロジェクト ID: ${wo.projectId} / 発行 ${new Date(wo.issuedAt).toLocaleString("ja-JP")}</div>
    <div class="grid">
      <div>
        <div class="preview">${previewSvg}</div>
        <div class="qr">${qrSvg}<div style="font-size:11px;color:#888;">${wo.projectId}</div></div>
      </div>
      <div style="flex:1;">
        <dl>
          <dt>デザイン名</dt><dd>${wo.designName}</dd>
          <dt>元ファイル</dt><dd>${wo.fileName}</dd>
          <dt>サイズ</dt><dd>${wo.widthMm.toFixed(1)} × ${wo.heightMm.toFixed(1)} mm</dd>
          <dt>総針数</dt><dd>${wo.totalStitches.toLocaleString()}</dd>
          <dt>色数 / 糸替え</dt><dd>${wo.colorCount} 色 / ${wo.colorChanges} 回</dd>
          <dt>糸切り回数</dt><dd>${wo.trims} 回</dd>
          <dt>推定縫製時間</dt><dd>約 ${Math.ceil(wo.estMinutes)} 分</dd>
          <dt>布地</dt><dd>${wo.fabric.name}</dd>
          <dt>推奨糸</dt><dd>${wo.fabric.recommendedThread}</dd>
          <dt>推奨針</dt><dd>${wo.fabric.recommendedNeedle}</dd>
        </dl>
        <h3 style="font-size:14px;margin:16px 0 0;">使用糸・縫い順</h3>
        <table><thead><tr><th>順</th><th>色</th><th>糸</th><th>針数</th></tr></thead><tbody>${rows}</tbody></table>
        ${notes}
      </div>
    </div>
    <button onclick="window.print()" style="margin-top:20px;padding:8px 16px;">PDF として印刷 / 保存</button>
    </body></html>`;
}

/** 作業指示書を新しいウィンドウで開く (ユーザーが「PDF に保存」で出力) */
export function openWorkOrder(ctx: ReportContext): WorkOrder {
  const wo = buildWorkOrder(ctx.plan, ctx);
  const qrSvg = qrToSvg(encodeQr(ctx.projectId), 3);
  const previewSvg = planToSvg(ctx.plan, { size: 280 });
  const html = workOrderHtml(wo, qrSvg, previewSvg);
  const w = window.open("", "_blank");
  if (w) {
    w.document.write(html);
    w.document.close();
  }
  return wo;
}

function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** プロジェクト ID の QR を SVG で保存 */
export function downloadQr(projectId: string): void {
  downloadText(`${projectId}-qr.svg`, qrToSvg(encodeQr(projectId), 4), "image/svg+xml");
}

/** ステッチプレビューを SVG で保存 */
export function downloadPreview(plan: StitchPlan, name: string): void {
  downloadText(`${name}-preview.svg`, planToSvg(plan, { size: 600 }), "image/svg+xml");
}
