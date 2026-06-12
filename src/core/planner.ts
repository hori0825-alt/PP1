// 縫い計画 (Planner): オブジェクト列 → ステッチ列へのコンパイル。
//  - オブジェクト内部では絶対に糸切りしない (1オブジェクト = 連続ステッチ列)
//  - オブジェクト間は Closest Join (端点反転・閉ループ回転) + 隠れ経路つなぎ
//  - 隠れ経路 = 同色の内側 or 後で縫う色の上 (Travel on Edge 相当の迂回BFS付き)
//  - 糸切りは auto / always / never をオブジェクト単位で制御
//  - 色替え時は必ず糸切り

import { COLOR_CHANGE, END, JUMP, Pattern, STITCH, TRIM } from "../embroidery/pattern";
import { nearestPecThread, PEC_THREADS } from "../embroidery/pecThreads";
import type { Thread } from "../embroidery/pattern";
import { fillLoops } from "../digitize/fill";
import { runningStitch } from "../digitize/outline";
import { loopPerimeter, majorAxisInfo, orderRunsNearest, skeletonRunFromMask } from "../digitize/pipeline";
import type { Pt } from "../digitize/contour";
import type { QuantizeResult } from "../digitize/quantize";
import type { EmbObject, GlobalSettings } from "./object";
import type { Transform } from "./objectizer";

export type JoinType = "start" | "walk" | "jump" | "trim" | "color";

export interface Segment {
  objectId: string;
  /** pattern.stitches 内の範囲 [from, to) */
  from: number;
  to: number;
  stitches: number;
  /** このオブジェクトへの移動方法 */
  joinType: JoinType;
  joinDistMm: number;
  start: Pt;
  end: Pt;
  colorIndex: number;
}

export interface PlanStats {
  stitches: number;
  trims: number;
  jumps: number;
  colorChanges: number;
  colors: number;
  widthMm: number;
  heightMm: number;
  estMinutes: number;
  maxJoinMm: number;
  avgJoinMm: number;
}

export interface Plan {
  pattern: Pattern;
  segments: Segment[];
  stats: PlanStats;
  threads: Thread[];
  /** center() で適用したオフセット (px座標との対応用) */
  offset: { dx: number; dy: number };
}

/** オブジェクト1つぶんの run 群を生成する (糸切りなしで縫える単位) */
export function generateObjectRuns(
  obj: EmbObject,
  g: GlobalSettings,
  t: Transform,
  mmPerPx: number,
): Pt[][] {
  const toUnits = ([x, y]: Pt): Pt => [(x - t.cx) * t.scale, (y - t.cy) * t.scale];
  const s = obj.settings;
  const runs: Pt[][] = [];

  if ((s.kind === "satin" || s.kind === "centerline") && obj.mask) {
    const r = skeletonRunFromMask(
      obj.mask.data,
      obj.mask.w,
      obj.mask.h,
      obj.mask.x0,
      obj.mask.y0,
      {
        satinMaxWidthMm: g.satinMaxWidthMm,
        centerlineMaxWidthMm: g.centerlineMaxWidthMm,
        satinSpacingMm: s.satinSpacingMm ?? g.satinSpacingMm,
        outlineStitchMm: g.outlineStitchMm,
      },
      mmPerPx,
      toUnits,
      s.kind,
    );
    if (r) {
      runs.push(r.run);
      return runs;
    }
    // スケルトンが取れない場合はタタミにフォールバック
  }

  const loops = obj.ringsPx.map((ring) => ring.map(toUnits));
  let angle = ((s.angleDeg ?? g.angleDeg) * Math.PI) / 180;
  if (s.angleDeg === null) {
    const info = majorAxisInfo(loops[0]);
    if (info.ratio > 4) angle = info.angle + Math.PI / 2;
  }
  runs.push(
    ...fillLoops(loops, {
      spacing: (s.rowSpacingMm ?? g.rowSpacingMm) * 10,
      stitchLen: g.stitchLenMm * 10,
      angle,
      mode: "tatami",
    }),
  );
  if (s.outline ?? g.outline) {
    for (const loop of loops) {
      if (loopPerimeter(loop) < 50) continue;
      const run = runningStitch(loop, g.outlineStitchMm * 10);
      if (run.length >= 2) runs.push(run);
    }
  }
  // 極小 run の除去
  return runs.filter((run) => {
    if (run.length > 3) return true;
    let L = 0;
    for (let i = 1; i < run.length; i++) {
      L += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
    }
    return L > 20;
  });
}

/**
 * 縫い順 (order) に従ってオブジェクト群をステッチ列へコンパイルする。
 */
export function compilePlan(
  objects: EmbObject[],
  order: string[],
  g: GlobalSettings,
  quant: QuantizeResult,
  t: Transform,
  mmPerPx: number,
): Plan {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const seq = order
    .map((id) => byId.get(id))
    .filter((o): o is EmbObject => !!o && o.settings.visible);

  // スレッド: 縫い順での色の初出順
  const colorSeq: number[] = [];
  for (const o of seq) if (!colorSeq.includes(o.paletteIndex)) colorSeq.push(o.paletteIndex);
  const sewRank = new Map<number, number>();
  colorSeq.forEach((c, i) => sewRank.set(c, i));
  const usedPec = new Set<number>();
  const threads: Thread[] = colorSeq.map((c) => {
    const pal = quant.palette[c] ?? { r: 0, g: 0, b: 0, count: 0 };
    const th = nearestPecThread(pal.r, pal.g, pal.b, usedPec);
    usedPec.add(th.pecIndex);
    return th;
  });

  const pattern = new Pattern();
  const segments: Segment[] = [];
  const connectUnits = g.trimDistanceMm * 10;
  const walkPitch = Math.max(10, g.stitchLenMm * 10);
  const TINY = 15;

  // 隠れ経路判定 (自分の色 + 後で縫う色の上)
  const labelHiddenFor = (c: number) => {
    const myRank = sewRank.get(c) ?? 0;
    return (lab: number): boolean => {
      if (lab === c) return true;
      const r = sewRank.get(lab);
      return r !== undefined && r > myRank;
    };
  };
  const hiddenAtFor = (labelHidden: (l: number) => boolean) => {
    return (px: number, py: number): boolean => {
      const xi = Math.min(quant.width - 1, Math.max(0, Math.round(px)));
      const yi = Math.min(quant.height - 1, Math.max(0, Math.round(py)));
      const w = quant.width;
      const L = quant.labels;
      if (labelHidden(L[yi * w + xi])) return true;
      return (
        (xi > 0 && labelHidden(L[yi * w + xi - 1])) ||
        (xi < w - 1 && labelHidden(L[yi * w + xi + 1])) ||
        (yi > 0 && labelHidden(L[(yi - 1) * w + xi])) ||
        (yi < quant.height - 1 && labelHidden(L[(yi + 1) * w + xi]))
      );
    };
  };

  let prevColor = -1;
  let totalJoin = 0;
  let joinCount = 0;
  let maxJoin = 0;

  for (const obj of seq) {
    const c = obj.paletteIndex;
    const hiddenAt = hiddenAtFor(labelHiddenFor(c));
    const hiddenPath = (ax: number, ay: number, bx: number, by: number): boolean => {
      const d = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(d / 8));
      for (let i = 0; i <= n; i++) {
        const ux = ax + ((bx - ax) * i) / n;
        const uy = ay + ((by - ay) * i) / n;
        if (!hiddenAt(ux / t.scale + t.cx, uy / t.scale + t.cy)) return false;
      }
      return true;
    };
    const hiddenRoute = (ax: number, ay: number, bx: number, by: number): Pt[] | null => {
      const stepPx = 3;
      const pax = ax / t.scale + t.cx;
      const pay = ay / t.scale + t.cy;
      const pbx = bx / t.scale + t.cx;
      const pby = by / t.scale + t.cy;
      const margin = stepPx * 20;
      const x0 = Math.max(0, Math.min(pax, pbx) - margin);
      const y0 = Math.max(0, Math.min(pay, pby) - margin);
      const x1 = Math.min(quant.width - 1, Math.max(pax, pbx) + margin);
      const y1 = Math.min(quant.height - 1, Math.max(pay, pby) + margin);
      const cols = Math.floor((x1 - x0) / stepPx) + 1;
      const rows = Math.floor((y1 - y0) / stepPx) + 1;
      if (cols * rows > 80000 || cols < 1 || rows < 1) return null;
      const cellOk = (cxI: number, cyI: number): boolean =>
        hiddenAt(x0 + cxI * stepPx, y0 + cyI * stepPx);
      const cellOf = (px: number, py: number): [number, number] => [
        Math.max(0, Math.min(cols - 1, Math.round((px - x0) / stepPx))),
        Math.max(0, Math.min(rows - 1, Math.round((py - y0) / stepPx))),
      ];
      const [sx_, sy_] = cellOf(pax, pay);
      const [gx, gy] = cellOf(pbx, pby);
      const parent = new Int32Array(cols * rows).fill(-2);
      const queue: number[] = [sy_ * cols + sx_];
      parent[sy_ * cols + sx_] = -1;
      const goalIdx = gy * cols + gx;
      let found = parent[goalIdx] !== -2;
      for (let qi = 0; qi < queue.length && !found; qi++) {
        const cur = queue[qi];
        const cxI = cur % cols;
        const cyI = (cur / cols) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cxI + dx;
          const ny = cyI + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          if (parent[ni] !== -2) continue;
          if (!cellOk(nx, ny)) {
            parent[ni] = -3;
            continue;
          }
          parent[ni] = cur;
          if (ni === goalIdx) {
            found = true;
            break;
          }
          queue.push(ni);
        }
      }
      if (!found) return null;
      const cells: Pt[] = [];
      for (let i = goalIdx; i !== -1; i = parent[i]) {
        cells.push([
          (x0 + (i % cols) * stepPx - t.cx) * t.scale,
          (y0 + ((i / cols) | 0) * stepPx - t.cy) * t.scale,
        ]);
        if (cells.length > cols * rows) return null;
      }
      cells.reverse();
      const pts: Pt[] = [[ax, ay], ...cells, [bx, by]];
      const simplified: Pt[] = [pts[0]];
      let i0 = 0;
      while (i0 < pts.length - 1) {
        let j = pts.length - 1;
        for (; j > i0 + 1; j--) {
          if (hiddenPath(pts[i0][0], pts[i0][1], pts[j][0], pts[j][1])) break;
        }
        simplified.push(pts[j]);
        i0 = j;
      }
      let len = 0;
      for (let k = 1; k < simplified.length; k++) {
        len += Math.hypot(
          simplified[k][0] - simplified[k - 1][0],
          simplified[k][1] - simplified[k - 1][1],
        );
      }
      if (len > connectUnits * 1.8) return null;
      return simplified;
    };

    // オブジェクトの run 生成 + Closest Join (内部の並べ替え)
    const last = pattern.stitches[pattern.stitches.length - 1];
    const curPos: Pt | null = last ? [last.x, last.y] : null;
    let runs = generateObjectRuns(obj, g, t, mmPerPx);
    if (runs.length === 0) continue;
    runs = orderRunsNearest(runs, curPos);

    let joinType: JoinType = "start";
    let joinDistMm = 0;

    // 色替え
    if (prevColor >= 0 && prevColor !== c) {
      pattern.add(TRIM, last!.x, last!.y);
      pattern.add(COLOR_CHANGE, last!.x, last!.y);
      pattern.add(JUMP, runs[0][0][0], runs[0][0][1]);
      joinType = "color";
      joinDistMm = Math.hypot(runs[0][0][0] - last!.x, runs[0][0][1] - last!.y) / 10;
    } else if (!last) {
      pattern.add(JUMP, runs[0][0][0], runs[0][0][1]);
      joinType = "start";
    } else {
      // 同色オブジェクト間の接続
      const [sx, sy] = runs[0][0];
      const d = Math.hypot(sx - last.x, sy - last.y);
      joinDistMm = d / 10;
      const mode = obj.settings.trimMode === "auto" ? g.trimMode : obj.settings.trimMode;
      const walkTo = (waypoints: Pt[]) => {
        let [px, py] = [last.x, last.y];
        for (const [wx, wy] of waypoints) {
          const dd = Math.hypot(wx - px, wy - py);
          const n = Math.ceil(dd / walkPitch);
          for (let i = 1; i <= n; i++) {
            pattern.add(STITCH, px + ((wx - px) * i) / n, py + ((wy - py) * i) / n);
          }
          px = wx;
          py = wy;
        }
      };
      if (mode === "always" && d > 1) {
        pattern.add(TRIM, last.x, last.y);
        pattern.add(JUMP, sx, sy);
        joinType = "trim";
      } else if (mode === "never") {
        if (d <= connectUnits) {
          walkTo([[sx, sy]]);
          joinType = "walk";
        } else {
          pattern.add(JUMP, sx, sy); // 糸切りなしのジャンプ (渡り糸が残る)
          joinType = "jump";
        }
      } else {
        // auto
        if (d <= TINY || (d <= connectUnits && hiddenPath(last.x, last.y, sx, sy))) {
          walkTo([[sx, sy]]);
          joinType = "walk";
        } else if (d <= connectUnits) {
          const route = hiddenRoute(last.x, last.y, sx, sy);
          if (route) {
            walkTo(route.slice(1));
            joinType = "walk";
          } else if (d > 1) {
            pattern.add(TRIM, last.x, last.y);
            pattern.add(JUMP, sx, sy);
            joinType = "trim";
          }
        } else if (d > 1) {
          pattern.add(TRIM, last.x, last.y);
          pattern.add(JUMP, sx, sy);
          joinType = "trim";
        }
      }
    }

    // セグメント開始 = 接続 (糸切り・色替え・つなぎ縫い) の後。
    // これによりオブジェクト範囲 [from, to) 内には糸切りが一切入らない
    const from = pattern.stitches.length;

    // オブジェクト内: run間は隠れていれば walk、必要なら糸切りなしで接続。
    // オブジェクト = 連続体なので run 間も糸切りしない (面縫い中の糸切り禁止)
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      if (r > 0) {
        const prev = pattern.stitches[pattern.stitches.length - 1];
        const [sx, sy] = run[0];
        const d = Math.hypot(sx - prev.x, sy - prev.y);
        const n = Math.ceil(d / walkPitch);
        for (let i = 1; i < n; i++) {
          pattern.add(STITCH, prev.x + ((sx - prev.x) * i) / n, prev.y + ((sy - prev.y) * i) / n);
        }
      }
      for (const [x, y] of run) pattern.add(STITCH, x, y);
    }

    const to = pattern.stitches.length;
    let stitchCount = 0;
    for (let i = from; i < to; i++) if (pattern.stitches[i].cmd === STITCH) stitchCount++;
    segments.push({
      objectId: obj.id,
      from,
      to,
      stitches: stitchCount,
      joinType,
      joinDistMm: Math.round(joinDistMm * 10) / 10,
      start: [pattern.stitches[from]?.x ?? 0, pattern.stitches[from]?.y ?? 0],
      end: [pattern.stitches[to - 1]?.x ?? 0, pattern.stitches[to - 1]?.y ?? 0],
      colorIndex: sewRank.get(c) ?? 0,
    });
    if (joinType !== "start" && joinType !== "color") {
      totalJoin += joinDistMm;
      joinCount++;
      maxJoin = Math.max(maxJoin, joinDistMm);
    }
    prevColor = c;
  }

  if (pattern.stitches.length > 0) {
    const last = pattern.stitches[pattern.stitches.length - 1];
    pattern.add(END, last.x, last.y);
  } else {
    pattern.add(END, 0, 0);
  }
  pattern.threads = threads.length > 0 ? threads : [PEC_THREADS[19]];
  const offset = pattern.center();
  for (const s of pattern.stitches) {
    s.x = Math.round(s.x);
    s.y = Math.round(s.y);
  }
  // segments の座標も補正
  for (const seg of segments) {
    seg.start = [Math.round(seg.start[0] + offset.dx), Math.round(seg.start[1] + offset.dy)];
    seg.end = [Math.round(seg.end[0] + offset.dx), Math.round(seg.end[1] + offset.dy)];
  }

  const b = pattern.bounds();
  const stitches = pattern.countStitches();
  const stats: PlanStats = {
    stitches,
    trims: pattern.countTrims(),
    jumps: pattern.countJumps(),
    colorChanges: pattern.countColorChanges(),
    colors: threads.length,
    widthMm: (b.maxX - b.minX) / 10,
    heightMm: (b.maxY - b.minY) / 10,
    estMinutes: Math.round((stitches / 400) * 10) / 10,
    maxJoinMm: Math.round(maxJoin * 10) / 10,
    avgJoinMm: joinCount > 0 ? Math.round((totalJoin / joinCount) * 10) / 10 : 0,
  };

  return { pattern, segments, stats, threads, offset };
}

/**
 * 針数上限を超える場合に密度を段階的に緩めて再コンパイルする。
 */
export function compileWithLimit(
  objects: EmbObject[],
  order: string[],
  g: GlobalSettings,
  quant: QuantizeResult,
  t: Transform,
  mmPerPx: number,
): { plan: Plan; adjusted: GlobalSettings | null; overLimit: boolean } {
  let plan = compilePlan(objects, order, g, quant, t, mmPerPx);
  if (g.maxStitches <= 0 || plan.stats.stitches <= g.maxStitches) {
    return { plan, adjusted: null, overLimit: false };
  }
  let cur = { ...g };
  let adjusted = false;
  for (let iter = 0; iter < 6 && plan.stats.stitches > g.maxStitches; iter++) {
    const ratio = (plan.stats.stitches / g.maxStitches) * 1.05;
    const nextRow = Math.min(1.2, cur.rowSpacingMm * ratio);
    const nextSatin = Math.min(0.6, cur.satinSpacingMm * ratio);
    let nextLen = cur.stitchLenMm;
    if (nextRow === cur.rowSpacingMm && nextSatin === cur.satinSpacingMm) {
      nextLen = Math.min(6, cur.stitchLenMm * 1.3);
      if (nextLen === cur.stitchLenMm) break;
    }
    cur = { ...cur, rowSpacingMm: nextRow, satinSpacingMm: nextSatin, stitchLenMm: nextLen };
    adjusted = true;
    plan = compilePlan(objects, order, cur, quant, t, mmPerPx);
  }
  return {
    plan,
    adjusted: adjusted ? cur : null,
    overLimit: plan.stats.stitches > g.maxStitches,
  };
}
