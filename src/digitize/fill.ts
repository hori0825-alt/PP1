// タタミ縫い / サテン縫い / センターライン縫いのステッチ生成。
// 偶奇規則でループ群を走査し、行セグメントをチェーンに連結したうえで
// 指定モードのステッチを生成する。

import type { Pt } from "./contour";

export interface FillOptions {
  /** 行間隔 (単位: 0.1mm) */
  spacing: number;
  /** 最大ステッチ長 (単位: 0.1mm) */
  stitchLen: number;
  /** 縫い角度 (ラジアン) */
  angle: number;
  /**
   * 縫い種別:
   *   tatami     : タタミ縫い (デフォルト)
   *   satin      : サテン縫い — 走査線1本を1針で縫い光沢のある細線を表現
   *   centerline : センターライン縫い — 領域の中心線をランニングで縫う (極細線向け)
   */
  mode?: "tatami" | "satin" | "centerline";
  /** サテン1針の最大長 (0.1mm単位)。超えた場合は tatami 方式に自動切替。既定 120 (12mm) */
  maxSatinLen?: number;
}

interface Segment {
  x0: number;
  x1: number;
  row: number;
  visited: boolean;
}

export function fillLoops(loops: Pt[][], o: FillOptions): Pt[][] {
  if (loops.length === 0) return [];
  const mode = o.mode ?? "tatami";
  const maxSatinLen = o.maxSatinLen ?? 120;

  // ループを縫い角度で回転 (スキャンを水平に行うため)
  const cos = Math.cos(-o.angle);
  const sin = Math.sin(-o.angle);
  const rot: Pt[][] = loops.map((loop) =>
    loop.map(([x, y]): Pt => [x * cos - y * sin, x * sin + y * cos]),
  );
  const cosB = Math.cos(o.angle);
  const sinB = Math.sin(o.angle);
  const unrotate = ([x, y]: Pt): Pt => [x * cosB - y * sinB, x * sinB + y * cosB];

  let minY = Infinity;
  let maxY = -Infinity;
  for (const loop of rot) {
    for (const [, y] of loop) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minY)) return [];

  // センターラインモードは stitchLen 間隔でスキャン (針落ち密度を直接制御)
  const scanSpacing = mode === "centerline" ? o.stitchLen : o.spacing;

  // 行ごとの交差セグメントを求める
  const rows: Segment[][] = [];
  const rowCount = Math.max(1, Math.floor((maxY - minY) / scanSpacing));
  for (let r = 0; r < rowCount; r++) {
    const y = minY + (r + 0.5) * scanSpacing;
    const xs: number[] = [];
    for (const loop of rot) {
      for (let i = 0; i < loop.length; i++) {
        const [x0, y0] = loop[i];
        const [x1, y1] = loop[(i + 1) % loop.length];
        if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
          xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
        }
      }
    }
    xs.sort((a, b) => a - b);
    const segs: Segment[] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > 0.5) {
        segs.push({ x0: xs[i], x1: xs[i + 1], row: r, visited: false });
      }
    }
    rows.push(segs);
  }

  // セグメントを縦のチェーンに連結
  const chains: Segment[][] = [];
  for (let r = 0; r < rows.length; r++) {
    for (const seg of rows[r]) {
      if (seg.visited) continue;
      seg.visited = true;
      const chain = [seg];
      let cur = seg;
      for (let nr = r + 1; nr < rows.length; nr++) {
        let next: Segment | null = null;
        for (const cand of rows[nr]) {
          if (cand.visited) continue;
          const overlap = Math.min(cur.x1, cand.x1) - Math.max(cur.x0, cand.x0);
          if (overlap > 0.5) {
            next = cand;
            break;
          }
        }
        if (!next) break;
        next.visited = true;
        chain.push(next);
        cur = next;
      }
      chains.push(chain);
    }
  }

  const runs: Pt[][] = [];

  // -------- センターライン --------
  if (mode === "centerline") {
    for (const chain of chains) {
      const run: Pt[] = chain.map((seg) => {
        const y = minY + (seg.row + 0.5) * scanSpacing;
        return [(seg.x0 + seg.x1) / 2, y] as Pt;
      });
      if (run.length >= 2) runs.push(run.map(unrotate));
    }
    return runs;
  }

  // -------- サテン --------
  if (mode === "satin") {
    for (const chain of chains) {
      const run: Pt[] = [];
      let dir = 1;
      for (const seg of chain) {
        const y = minY + (seg.row + 0.5) * scanSpacing;
        const width = seg.x1 - seg.x0;
        if (width <= maxSatinLen) {
          // 1針でクロスするサテン縫い
          if (dir > 0) {
            run.push([seg.x0, y]);
            run.push([seg.x1, y]);
          } else {
            run.push([seg.x1, y]);
            run.push([seg.x0, y]);
          }
        } else {
          // 幅が広すぎる行は tatami 方式で分割
          const pts = rowStitches(seg.x0, seg.x1, o.stitchLen, seg.row);
          if (dir < 0) pts.reverse();
          for (const x of pts) run.push([x, y]);
        }
        dir = -dir;
      }
      if (run.length >= 2) runs.push(run.map(unrotate));
    }
    return runs;
  }

  // -------- タタミ (デフォルト) --------
  for (const chain of chains) {
    let run: Pt[] = [];
    const flushRun = () => {
      if (run.length >= 2) runs.push(run.map(unrotate));
      run = [];
    };
    let dir = 1;
    for (const seg of chain) {
      const y = minY + (seg.row + 0.5) * o.spacing;
      const pts = rowStitches(seg.x0, seg.x1, o.stitchLen, seg.row);
      if (dir < 0) pts.reverse();
      if (run.length > 0) {
        const [lx, ly] = run[run.length - 1];
        const dx = pts[0] - lx;
        const dy = y - ly;
        const d = Math.hypot(dx, dy);
        const n = Math.ceil(d / o.stitchLen);
        const mids: Pt[] = [];
        let escapes = false;
        for (let i = 1; i < n; i++) {
          const mx = lx + (dx * i) / n;
          const my = ly + (dy * i) / n;
          if (!pointInLoops(rot, mx, my)) {
            escapes = true;
            break;
          }
          mids.push([mx, my]);
        }
        if (escapes) flushRun();
        else run.push(...mids);
      }
      for (const x of pts) run.push([x, y]);
      dir = -dir;
    }
    flushRun();
  }
  return runs;
}

/** 偶奇規則による内外判定 */
function pointInLoops(loops: Pt[][], x: number, y: number): boolean {
  let inside = false;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const [x0, y0] = loop[i];
      const [x1, y1] = loop[(i + 1) % loop.length];
      if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
        const xi = x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
        if (xi > x) inside = !inside;
      }
    }
  }
  return inside;
}

/** 1行分の針落ち x 座標。絶対グリッドに揃え、奇数行は半ピッチずらす (レンガ状のタタミ模様) */
function rowStitches(x0: number, x1: number, stitchLen: number, row: number): number[] {
  const offset = row % 2 === 1 ? stitchLen / 2 : 0;
  const pts: number[] = [x0];
  let k = Math.floor((x0 - offset) / stitchLen) + 1;
  for (; k * stitchLen + offset < x1 - 1e-9; k++) {
    const x = k * stitchLen + offset;
    if (x > x0 + 1e-9) pts.push(x);
  }
  pts.push(x1);
  const out: number[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1];
    if (pts[i] - prev < 2 && pts[i + 1] - prev <= stitchLen) continue;
    out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  if (out.length >= 3) {
    const a = out[out.length - 3];
    const b = out[out.length - 2];
    const c = out[out.length - 1];
    if (c - b < 2 && c - a <= stitchLen) out.splice(out.length - 2, 1);
  }
  return out;
}
