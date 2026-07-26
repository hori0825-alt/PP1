import type { BodyParams } from '../../core/params';
import { buildBodySurface } from '../../geometry/surface';

const SAMPLES = 48;

/** 正面(rx)・側面(ry)の半径を t=0..1 で折れ線グラフとして描画する（読み取り専用）。 */
export function drawContourGraph(canvas: HTMLCanvasElement, body: BodyParams): void {
  const maybeCtx = canvas.getContext('2d');
  if (!maybeCtx) return;
  const ctx = maybeCtx;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  const surface = buildBodySurface(body.sections);
  const ts: number[] = [];
  const rxs: number[] = [];
  const rys: number[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    ts.push(t);
    rxs.push(surface.rx(t));
    rys.push(surface.ry(t));
  }
  const maxR = Math.max(1, ...rxs, ...rys);

  const padding = 8;
  const plotW = width - padding * 2;
  const plotH = height - padding * 2;

  function toX(t: number): number {
    return padding + t * plotW;
  }
  function toY(r: number): number {
    return padding + plotH - (r / maxR) * plotH;
  }

  function plotLine(values: number[], color: string): void {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = toX(ts[i]!);
      const y = toY(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  plotLine(rxs, '#5b2a86');
  plotLine(rys, '#4f7942');

  // 断面制御点を点で表示
  ctx.fillStyle = '#333';
  for (const section of body.sections) {
    ctx.beginPath();
    ctx.arc(toX(section.t), toY(section.rx), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#888';
  ctx.font = '10px sans-serif';
  ctx.fillText('紫=正面幅(rx) 緑=側面奥行き(ry)', padding, height - 2);
}
