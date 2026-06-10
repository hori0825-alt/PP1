// タタミ縫い (走査線塗りつぶし) のステッチ生成。
// 偶奇規則でループ群 (外周+穴) を走査し、行セグメントを縦に連結した
// チェーン単位で蛇行 (サーペンタイン) パスを作る。
// 行ごとに針落ち位置を半ピッチずらしてレンガ状のタタミ模様にする。

import type { Pt } from "./contour";

export interface FillOptions {
  /** 行間隔 (単位: 0.1mm) */
  spacing: number;
  /** 最大ステッチ長 (単位: 0.1mm) */
  stitchLen: number;
  /** 縫い角度 (ラジアン) */
  angle: number;
}

interface Segment {
  x0: number;
  x1: number;
  row: number;
  visited: boolean;
}

/** ループ群を塗りつぶすステッチ列 (run) の配列を返す。run 間は渡り糸 (ジャンプ) でつなぐ */
export function fillLoops(loops: Pt[][], o: FillOptions): Pt[][] {
  if (loops.length === 0) return [];
  const cos = Math.cos(-o.angle);
  const sin = Math.sin(-o.angle);
  const rot: Pt[][] = loops.map((loop) =>
    loop.map(([x, y]): Pt => [x * cos - y * sin, x * sin + y * cos]),
  );

  let minY = Infinity;
  let maxY = -Infinity;
  for (const loop of rot) {
    for (const [, y] of loop) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minY)) return [];

  // 行ごとの交差セグメントを求める
  const rows: Segment[][] = [];
  const rowCount = Math.max(1, Math.floor((maxY - minY) / o.spacing));
  for (let r = 0; r < rowCount; r++) {
    const y = minY + (r + 0.5) * o.spacing;
    const xs: number[] = [];
    for (const loop of rot) {
      for (let i = 0; i < loop.length; i++) {
        const [x0, y0] = loop[i];
        const [x1, y1] = loop[(i + 1) % loop.length];
        // 半開区間規則で頂点の二重カウントを防ぐ
        if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
          xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
        }
      }
    }
    xs.sort((a, b) => a - b);
    const segs: Segment[] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > 1) {
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

  // チェーンごとに蛇行ステッチを生成
  const runs: Pt[][] = [];
  const cosB = Math.cos(o.angle);
  const sinB = Math.sin(o.angle);
  const unrotate = ([x, y]: Pt): Pt => [x * cosB - y * sinB, x * sinB + y * cosB];

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
      // 行から行への移動が長い場合は中間点を打って最大ステッチ長を守る。
      // 中間点が領域外 (穴や凹み) に出るなら縫わずに渡り糸に切り替える。
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
  // 端に寄りすぎた針落ち (<0.2mm) は、間隔が最大ステッチ長を超えない範囲で間引く
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
