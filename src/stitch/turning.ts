// ターニングステッチ (流れる方向のタタミ)。
//
// 2本以上の「方向線」から角度フィールド θ(x,y) を作り、その等位線
// (iso-phase 等高線) を縫い目の行として使う。これにより葉や花弁のように
// 縫い目の向きが滑らかに流れる。
//
// 手法:
//   1. 位相場 φ(p) を作る。各方向線 i は中心 C から見た法線方向 n_i を持ち、
//      φ_i(p) = (p - C)·n_i。距離による重みで φ_i を空間補間して φ を得る。
//      (方向線が全て平行なら φ は線形 = 通常タタミと同じ向きの直線行になる)
//   2. グリッド上で φ をサンプルし、marching squares で
//      レベル k·rowSpacing の等高線を抽出する (= 行間隔 rowSpacing の縫い目行)。
//   3. 各行を stitchLength で再サンプルし、行から行へ縁を渡って 1本の連続 Run にする。
//
// 穴あき領域: 穴の部分は insideRegion で除外されるため、等高線は穴を避けて
// 自然に分断される。分断されたフラグメントは最近傍順で繋いで1本の Run にする。
// 退化時は呼び出し側でタタミにフォールバックする。

import { polygonCentroid, pointInPolygon, pointSegmentDistance } from "../core/geometry";
import type { DirectionLine, Region } from "../core/region";
import type { Point, StitchRun } from "../core/types";
import type { GeneratorResult, TatamiParams } from "./types";

function lineAngle(l: DirectionLine): number {
  return Math.atan2(l.b.y - l.a.y, l.b.x - l.a.x);
}

/** 折れ線を最大 step 間隔で再サンプル (両端含む) */
function resample(path: Point[], step: number): Point[] {
  if (path.length === 0) return [];
  const out: Point[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= n; k++) {
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
  }
  return out;
}

/** 領域内部 (外周内かつ穴の外) か */
function insideRegion(region: Region, p: Point): boolean {
  if (!pointInPolygon(p, region.outer)) return false;
  for (const h of region.holes) if (pointInPolygon(p, h)) return false;
  return true;
}

interface Segment {
  a: Point;
  b: Point;
}

// marching squares: コーナー TL,TR,BR,BL の (>=L) ビットごとに結ぶエッジ対。
// エッジ番号 0=top(TL-TR) 1=right(TR-BR) 2=bottom(BR-BL) 3=left(BL-TL)。
const MS_TABLE: number[][] = [
  [], [3, 0], [0, 1], [3, 1], [1, 2], [3, 0, 1, 2], [0, 2], [3, 2],
  [2, 3], [2, 0], [0, 1, 2, 3], [2, 1], [1, 3], [1, 0], [0, 3], [],
];

export function turningFill(
  region: Region,
  params: TatamiParams,
  lines: DirectionLine[],
  startNear: Point | null = null,
  exitNear: Point | null = null,
): GeneratorResult {
  const warnings: string[] = [];
  if (lines.length < 2) {
    return { runs: [], warnings: ["ターニング: 2本以上の方向線が必要"] };
  }

  const C = polygonCentroid(region.outer);
  const normals = lines.map((l) => {
    const t = lineAngle(l);
    return { x: Math.sin(t), y: -Math.cos(t) };
  });
  const eps = (params.rowSpacing * 3) ** 2;

  // 位相場 φ(p): 各方向線の位相を距離重みで補間する
  const phase = (p: Point): number => {
    let num = 0;
    let den = 0;
    for (let i = 0; i < lines.length; i++) {
      const d2 = pointSegmentDistance(p, lines[i].a, lines[i].b) ** 2;
      const w = 1 / (d2 + eps);
      const phi = (p.x - C.x) * normals[i].x + (p.y - C.y) * normals[i].y;
      num += w * phi;
      den += w;
    }
    return den > 0 ? num / den : 0;
  };

  // --- グリッドで φ をサンプル ---
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of region.outer) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const g = Math.max(2, params.rowSpacing); // グリッド間隔
  minX -= g;
  minY -= g;
  maxX += g;
  maxY += g;
  const nx = Math.min(400, Math.max(2, Math.ceil((maxX - minX) / g)));
  const ny = Math.min(400, Math.max(2, Math.ceil((maxY - minY) / g)));
  const dx = (maxX - minX) / nx;
  const dy = (maxY - minY) / ny;

  const val: number[][] = [];
  let phiMin = Infinity;
  let phiMax = -Infinity;
  for (let j = 0; j <= ny; j++) {
    const row: number[] = [];
    for (let i = 0; i <= nx; i++) {
      const v = phase({ x: minX + i * dx, y: minY + j * dy });
      row.push(v);
      if (v < phiMin) phiMin = v;
      if (v > phiMax) phiMax = v;
    }
    val.push(row);
  }
  if (!Number.isFinite(phiMin) || phiMax - phiMin < 1e-6) {
    return { runs: [], warnings: ["ターニング: 位相場が退化"] };
  }

  // --- レベルごとに等高線セグメントを抽出 (marching squares) ---
  const spacing = params.rowSpacing;
  const interp = (
    ax: number, ay: number, av: number,
    bx: number, by: number, bv: number, L: number,
  ): Point => {
    const t = Math.abs(bv - av) < 1e-9 ? 0.5 : (L - av) / (bv - av);
    return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
  };

  const levelStart = Math.ceil(phiMin / spacing);
  const levelEnd = Math.floor(phiMax / spacing);
  const rows: Point[][] = []; // 各行 (= 1レベルの 1本の折れ線)

  for (let lev = levelStart; lev <= levelEnd; lev++) {
    const L = lev * spacing;
    const segs: Segment[] = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x0 = minX + i * dx;
        const y0 = minY + j * dy;
        const x1 = x0 + dx;
        const y1 = y0 + dy;
        const vTL = val[j][i];
        const vTR = val[j][i + 1];
        const vBR = val[j + 1][i + 1];
        const vBL = val[j + 1][i];
        let idx = 0;
        if (vTL >= L) idx |= 1;
        if (vTR >= L) idx |= 2;
        if (vBR >= L) idx |= 4;
        if (vBL >= L) idx |= 8;
        const edges = MS_TABLE[idx];
        if (edges.length === 0) continue;
        // エッジ番号 → 交点
        const edgePoint = (e: number): Point => {
          switch (e) {
            case 0: return interp(x0, y0, vTL, x1, y0, vTR, L); // top
            case 1: return interp(x1, y0, vTR, x1, y1, vBR, L); // right
            case 2: return interp(x1, y1, vBR, x0, y1, vBL, L); // bottom
            default: return interp(x0, y1, vBL, x0, y0, vTL, L); // left
          }
        };
        for (let k = 0; k + 1 < edges.length; k += 2) {
          segs.push({ a: edgePoint(edges[k]), b: edgePoint(edges[k + 1]) });
        }
      }
    }
    // 領域内のセグメントだけ残す (中点判定)
    const inSegs = segs.filter((s) =>
      insideRegion(region, { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }),
    );
    // セグメントを端点一致で連結して折れ線群にする
    for (const poly of chainSegments(inSegs, dx + dy)) {
      if (poly.length >= 2) rows.push(poly);
    }
  }

  if (rows.length === 0) return { runs: [], warnings: ["ターニング: 行を生成できません"] };

  // --- 行を最近傍順に並べ替え、1本の連続 Run にする ---
  // 穴や凹面で等高線が分断された場合、レベル昇順だと遠い行に飛ぶ。
  // 最近傍貪欲法で並べ替えると渡り距離を大幅に削減できる。
  const orderedRows = reorderByNearest(rows, startNear);

  const stitches: Point[] = [];
  let cur: Point | null = startNear;
  for (const poly of orderedRows) {
    const sampled = resample(poly, params.stitchLength);
    if (sampled.length === 0) continue;
    const head = sampled[0];
    const tail = sampled[sampled.length - 1];
    let seq = sampled;
    if (cur) {
      const dHead = Math.hypot(head.x - cur.x, head.y - cur.y);
      const dTail = Math.hypot(tail.x - cur.x, tail.y - cur.y);
      if (dTail < dHead) seq = [...sampled].reverse();
    }
    // 前の終点から行頭への渡り (短いはず)。重複点は除く。
    if (cur) {
      const travel = resample([cur, seq[0]], params.stitchLength);
      for (let i = 1; i < travel.length; i++) stitches.push(travel[i]);
    } else {
      stitches.push(seq[0]);
    }
    for (let i = 1; i < seq.length; i++) stitches.push(seq[i]);
    cur = seq[seq.length - 1];
  }

  // 出口へ寄せる (任意): 最後に exitNear 方向へ向かうだけ。簡易のため省略可。
  void exitNear;

  if (stitches.length < 4) return { runs: [], warnings: ["ターニング: ステッチが少なすぎます"] };

  const rounded = stitches.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  return { runs: [{ stitches: rounded, connection: "trim" }], warnings };
}

/** 行フラグメント群を最近傍貪欲法で並べ替える。穴・凹面での渡り距離を短縮する */
function reorderByNearest(rows: Point[][], startNear: Point | null): Point[][] {
  if (rows.length <= 1) return rows;
  const n = rows.length;
  const used = new Uint8Array(n);
  const ordered: Point[][] = [];

  // startNear に最も近い行を最初に選ぶ
  let bestIdx = 0;
  if (startNear) {
    let bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      const h = rows[i][0];
      const t = rows[i][rows[i].length - 1];
      const d = Math.min(
        (h.x - startNear.x) ** 2 + (h.y - startNear.y) ** 2,
        (t.x - startNear.x) ** 2 + (t.y - startNear.y) ** 2,
      );
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
  }
  used[bestIdx] = 1;
  ordered.push(rows[bestIdx]);

  for (let iter = 1; iter < n; iter++) {
    const last = ordered[ordered.length - 1];
    const tail = last[last.length - 1];
    let bestDist = Infinity;
    let bestI = 0;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const h = rows[i][0];
      const t = rows[i][rows[i].length - 1];
      const d = Math.min(
        (h.x - tail.x) ** 2 + (h.y - tail.y) ** 2,
        (t.x - tail.x) ** 2 + (t.y - tail.y) ** 2,
      );
      if (d < bestDist) { bestDist = d; bestI = i; }
    }
    used[bestI] = 1;
    ordered.push(rows[bestI]);
  }
  return ordered;
}

/** セグメント群を端点一致で連結して折れ線にする (tol 以内を同一点とみなす) */
function chainSegments(segs: Segment[], tol: number): Point[][] {
  if (segs.length === 0) return [];
  const key = (p: Point): string => `${Math.round(p.x / tol)},${Math.round(p.y / tol)}`;
  const used = new Array<boolean>(segs.length).fill(false);
  // 端点 → セグメントの索引
  const map = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const p of [s.a, s.b]) {
      const k = key(p);
      const arr = map.get(k);
      if (arr) arr.push(i);
      else map.set(k, [i]);
    }
  });

  const polys: Point[][] = [];
  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const poly: Point[] = [segs[start].a, segs[start].b];
    // 末尾方向へ伸ばす
    for (;;) {
      const tail = poly[poly.length - 1];
      const cand = (map.get(key(tail)) ?? []).find((i) => !used[i]);
      if (cand === undefined) break;
      used[cand] = true;
      const s = segs[cand];
      const next = key(s.a) === key(tail) ? s.b : s.a;
      poly.push(next);
    }
    // 先頭方向へ伸ばす
    for (;;) {
      const head = poly[0];
      const cand = (map.get(key(head)) ?? []).find((i) => !used[i]);
      if (cand === undefined) break;
      used[cand] = true;
      const s = segs[cand];
      const prev = key(s.a) === key(head) ? s.b : s.a;
      poly.unshift(prev);
    }
    polys.push(poly);
  }
  return polys;
}
