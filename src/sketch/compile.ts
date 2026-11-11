// PP1 Sketch のコンパイラ: SketchDoc → StitchPlan (+ 縫い順の一覧)。
//
// 縫い順のルール:
//   1. レイヤー順 = 縫い順 (下のレイヤーから縫う)。重ね順を壊さないため絶対に入れ替えない
//   2. レイヤー内 (order=auto) は同じ色をまとめ、針の現在位置から近い順に並べる
//      (直前のレイヤーの最後の色を最初に縫い、色替えを1回減らす)
//   3. 線は入り口に近い端から縫い始める (必要なら逆向きに縫う)
//   4. 1つの部品 (線/面) の中では絶対に糸切りしない
//   5. 部品間の渡りは「隠れる経路」(後で縫う面の下 / 同じ色の上) ならつなぎ縫い、
//      隠れないなら設定に従い渡り糸 or 糸切り

import { mm } from "../core/constants";
import { countStitches, countTrims } from "../core/plan";
import type { Region } from "../core/region";
import type { ColorBlock, Point, StitchPlan, StitchRun } from "../core/types";
import { postprocessRun } from "../stitch/postprocess";
import { runningStitch } from "../stitch/running";
import { resamplePolyline, satinAlongPath } from "../stitch/satin";
import { tatamiFill } from "../stitch/tatami";
import { insetPath } from "../stitch/underlay";
import {
  bbox,
  dist,
  distToPolyline,
  nearestVertex,
  pointInShape,
  polylineLength,
  rotateRing,
  signedAreaMm,
  splitAtCorners,
} from "./geom";
import {
  colorKey,
  resolveStrokeStyle,
  isStitchEl,
  type StitchEl as Element,
  type FillEl,
  type Layer,
  type SketchDoc,
  type SketchSettings,
  type StrokeEl,
  type ThreadRef,
  type Vec,
} from "./model";

export type JoinKind = "start" | "color" | "walk" | "jump" | "trim";

export interface SeqItem {
  elementId: string;
  layerId: string;
  layerName: string;
  kind: "stroke" | "fill" | "stitches";
  /** 表示用の縫い方 (ランニング / 3重 / サテン / タタミ) */
  styleLabel: string;
  color: ThreadRef;
  stitches: number;
  /** この部品へ来るときの渡り方 */
  join: JoinKind;
  joinMm: number;
  /** 平坦化したステッチ列 (flattenPlan) での範囲 [from, to) */
  from: number;
  to: number;
}

export interface CompileStats {
  stitches: number;
  colors: number;
  colorChanges: number;
  trims: number;
  jumps: number;
  walks: number;
  widthMm: number;
  heightMm: number;
  minutes: number;
  longestJumpMm: number;
}

export interface CompileResult {
  plan: StitchPlan;
  seq: SeqItem[];
  stats: CompileStats;
  warnings: string[];
}

// ------------------------------------------------------------------ 縫い順

interface Unit {
  el: Element;
  layer: Layer;
  /** 入り口 (mm) */
  entry: Vec;
  /** 予想される出口 (mm) */
  exit: Vec;
  /** 線を逆向きに縫う */
  reversed: boolean;
  /** 閉じた線の開始頂点 */
  rotate: number;
}

function hasContent(el: Element): boolean {
  if (el.kind === "stitches") return el.points.length >= 2;
  return el.kind === "stroke" ? el.points.length >= 1 : el.outer.length >= 3;
}

/** 現在位置 p から見た、部品の最良の入り口と出口 */
function bestEntry(el: Element, p: Vec | null, layer: Layer): Unit {
  // 縫い目は元の順番どおりに縫う (向きは変えない)
  if (el.kind === "stitches") {
    return { el, layer, entry: el.points[0], exit: el.points[el.points.length - 1], reversed: false, rotate: 0 };
  }
  if (el.kind === "stroke") {
    const pts = el.points;
    if (el.closed && pts.length >= 3) {
      const k = p ? nearestVertex(pts, p) : 0;
      return { el, layer, entry: pts[k], exit: pts[k], reversed: false, rotate: k };
    }
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (p && dist(p, b) < dist(p, a)) {
      return { el, layer, entry: b, exit: a, reversed: true, rotate: 0 };
    }
    return { el, layer, entry: a, exit: b, reversed: false, rotate: 0 };
  }
  const k = p ? nearestVertex(el.outer, p) : 0;
  return { el, layer, entry: el.outer[k], exit: el.outer[k], reversed: false, rotate: k };
}

function entryDistance(el: Element, p: Vec): number {
  if (el.kind === "stitches") return dist(p, el.points[0]);
  if (el.kind === "stroke") {
    const pts = el.points;
    if (el.closed) return distToPolyline(p, pts, true);
    return Math.min(dist(p, pts[0]), dist(p, pts[pts.length - 1]));
  }
  return distToPolyline(p, el.outer, true);
}

/** レイヤー群から縫う順番 (Unit 列) を決める */
export function planOrder(layers: Layer[]): Unit[] {
  const units: Unit[] = [];
  let pos: Vec | null = null;
  let lastColor: string | null = null;

  for (const layer of layers) {
    if (!layer.visible) continue;
    const els = layer.elements.filter(isStitchEl).filter(hasContent);
    if (els.length === 0) continue;

    if (layer.order === "manual") {
      for (const el of els) {
        const u = bestEntry(el, pos, layer);
        units.push(u);
        pos = u.exit;
        lastColor = colorKey(el.color);
      }
      continue;
    }

    // 同じレイヤー内では「面」を先、「線」を後に縫う (線が面に埋もれないように)。
    // それぞれの中で色ごとにまとめる (初出順。直前の色があれば先頭へ)
    for (const kind of ["fill", "stitches", "stroke"] as const) {
      const group = els.filter((e) => e.kind === kind);
      if (group.length === 0) continue;
      const colorOrder: string[] = [];
      for (const el of group) {
        const k = colorKey(el.color);
        if (!colorOrder.includes(k)) colorOrder.push(k);
      }
      if (lastColor && colorOrder.includes(lastColor)) {
        colorOrder.splice(colorOrder.indexOf(lastColor), 1);
        colorOrder.unshift(lastColor);
      }
      for (const ck of colorOrder) {
        const remaining = group.filter((e) => colorKey(e.color) === ck);
        while (remaining.length > 0) {
        let bi = 0;
        if (pos) {
          let bd = Infinity;
          for (let i = 0; i < remaining.length; i++) {
            const d = entryDistance(remaining[i], pos);
            if (d < bd) {
              bd = d;
              bi = i;
            }
          }
        }
          const el = remaining.splice(bi, 1)[0];
          const u = bestEntry(el, pos, layer);
          units.push(u);
          pos = u.exit;
        }
        lastColor = ck;
      }
    }
  }
  return units;
}

// ------------------------------------------------------------------ 生成

const toU = (v: Vec): Point => ({ x: Math.round(mm(v.x)), y: Math.round(mm(v.y)) });
const toMm = (p: Point): Vec => ({ x: p.x / 10, y: p.y / 10 });

/** 線を縫う。返り値の run は全て同じ部品 (糸切りなしで連続) */
function stitchStroke(u: Unit, s: SketchSettings, warnings: string[]): StitchRun[] {
  const el = u.el as StrokeEl;
  let pts = el.points;
  if (el.closed && pts.length >= 3) {
    const r = rotateRing(pts, u.rotate);
    pts = [...r, r[0]];
  } else if (u.reversed) {
    pts = [...pts].reverse();
  }
  // 点 (タップ) は小さな線分として扱う
  if (pts.length === 1 || polylineLength(pts) < 0.3) {
    const c = pts[0];
    const h = Math.max(0.3, el.width * 0.3);
    pts = [
      { x: c.x - h, y: c.y },
      { x: c.x + h, y: c.y },
    ];
  }
  const path = pts.map(toU);
  const style = resolveStrokeStyle(el);

  if (style === "running") {
    return runningStitch(path, { stitchLength: mm(s.runLen) }).runs;
  }

  if (style === "triple") {
    // ビーン縫い: 1針ごとに 前→戻り→前 と3回通す (出口は終点のまま)
    const res = resamplePolyline(path, mm(s.runLen)).map((p) => ({
      x: Math.round(p.x),
      y: Math.round(p.y),
    }));
    const out: Point[] = [res[0]];
    for (let i = 1; i < res.length; i++) out.push(res[i], res[i - 1], res[i]);
    return [{ stitches: out, connection: "trim" }];
  }

  // サテン
  const runs: StitchRun[] = [];
  const width = Math.min(el.width, 7);
  if (el.width > 7) warnings.push(`線の太さ ${el.width.toFixed(1)}mm はサテン上限 7mm を超えるため 7mm で縫います (太い部分は「塗り」を推奨)`);
  if (s.underlay && width >= 1.5) {
    // 中心下縫い: 行って戻る (出口が入り口に戻るので、本縫いが入り口から始められる)
    runs.push(...runningStitch(path, { stitchLength: mm(2.5), double: true }).runs);
  }
  // 引き縮み補正 +0.15mm
  const satinW = mm(width + 0.15);
  for (const part of splitAtCorners(pts, 75)) {
    const res = satinAlongPath(part.map(toU), satinW, mm(s.satinSpacing), mm(8));
    runs.push(...res.runs);
  }
  return runs;
}

function toRegion(el: FillEl): Region {
  const outer = signedAreaMm(el.outer) > 0 ? el.outer : [...el.outer].reverse();
  const holes = el.holes
    .filter((h) => h.length >= 3)
    .map((h) => (signedAreaMm(h) < 0 ? h : [...h].reverse()));
  return {
    outer: outer.map(toU),
    holes: holes.map((h) => h.map(toU)),
    color: { r: el.color.r, g: el.color.g, b: el.color.b },
  };
}

/** 面を縫う */
function stitchFill(
  u: Unit,
  s: SketchSettings,
  startNear: Point | null,
  exitNear: Point | null,
  warnings: string[],
): StitchRun[] {
  const el = u.el as FillEl;
  const region = toRegion(el);
  const runs: StitchRun[] = [];
  let start = startNear;
  const areaMm2 = Math.abs(signedAreaMm(el.outer));

  if (s.underlay && areaMm2 > 25) {
    // エッジ下縫い: 外周の内側 0.8mm を一周 (入り口に近い点から)
    const inset = insetPath(region.outer, mm(0.8));
    const k = start ? nearestVertex(inset.map(toMm), toMm(start)) : 0;
    const ring = rotateRing(inset, k);
    const r = runningStitch(ring, { stitchLength: mm(2.5) }, true);
    runs.push(...r.runs);
    const last = r.runs[r.runs.length - 1]?.stitches;
    if (last && last.length > 0) start = last[last.length - 1];
  }

  const angle = el.angleDeg ?? s.fillAngle;
  const t = tatamiFill(
    region,
    { angleDeg: angle, rowSpacing: mm(s.fillSpacing), stitchLength: mm(s.fillStitchLen) },
    start,
    exitNear,
  );
  if (t.runs.length > 0 && t.runs.some((r) => r.stitches.length >= 2)) {
    runs.push(...t.runs);
  } else {
    // 細すぎてタタミにならない → 輪郭のランニング
    warnings.push("小さすぎる面をランニングで縫います");
    runs.push(...runningStitch(region.outer, { stitchLength: mm(1.5) }, true).runs);
  }
  return runs;
}

// ------------------------------------------------------------------ 隠れ判定

interface Cover {
  el: Element;
  box: { minX: number; minY: number; maxX: number; maxY: number };
  /** 縫い順での位置 */
  index: number;
}

function buildCovers(units: Unit[]): Cover[] {
  return units.map((u, index) => {
    const el = u.el;
    const pts = el.kind === "fill" ? el.outer : el.points;
    const b = bbox(pts);
    const pad = el.kind === "stroke" ? el.width / 2 : 0;
    return {
      el,
      index,
      box: { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad },
    };
  });
}

/** 点 p が、index の部品を縫う時点で「隠れる」場所か */
function pointHidden(p: Vec, index: number, color: string, covers: Cover[]): boolean {
  for (const c of covers) {
    const b = c.box;
    if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY) continue;
    const later = c.index > index;
    const sameColor = colorKey(c.el.color) === color;
    if (!later && !sameColor) continue;
    if (c.el.kind === "stitches") {
      // 縫い目は形が分からないので、隠れる場所としては扱わない
      continue;
    } else if (c.el.kind === "fill") {
      if (pointInShape(p, c.el.outer, c.el.holes)) return true;
    } else {
      const style = resolveStrokeStyle(c.el);
      // ランニングの細い線では隠れない
      if (style === "running") continue;
      if (distToPolyline(p, c.el.points, c.el.closed) <= c.el.width / 2) return true;
    }
  }
  return false;
}

function pathHidden(a: Vec, b: Vec, index: number, color: string, covers: Cover[]): boolean {
  const L = dist(a, b);
  const n = Math.max(1, Math.ceil(L / 0.6));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (!pointHidden({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, index, color, covers)) {
      return false;
    }
  }
  return true;
}

// ------------------------------------------------------------------ 本体

export function compileSketch(doc: SketchDoc): CompileResult {
  const s = doc.settings;
  const warnings: string[] = [];
  const units = planOrder(doc.layers);
  const covers = buildCovers(units);

  const blocks: ColorBlock[] = [];
  const seqMeta: (Omit<SeqItem, "stitches" | "from" | "to"> & { objectId: number })[] = [];
  let needle: Point | null = null;
  let curColor: string | null = null;
  let jumps = 0;
  let walks = 0;
  let longestJump = 0;

  units.forEach((u, index) => {
    const el = u.el;
    const ck = colorKey(el.color);
    const next = units[index + 1];
    const exitNear = next ? toU(next.entry) : null;

    let runs =
      el.kind === "stitches"
        ? [{ stitches: el.points.map(toU), connection: "trim" as const }]
        : el.kind === "stroke"
          ? stitchStroke(u, s, warnings)
          : stitchFill(u, s, needle, exitNear, warnings);
    runs = runs.filter((r) => r.stitches.length >= 1);
    if (runs.length === 0) return;

    // 部品内の run は必ず連続 (糸切りなし)。
    // 面の内側を通れる移動は細かいつなぎ縫い、穴をまたぐ移動だけ渡り糸にする
    for (let i = 1; i < runs.length; i++) {
      const prevLast = runs[i - 1].stitches[runs[i - 1].stitches.length - 1];
      const head = runs[i].stitches[0];
      const d = Math.hypot(head.x - prevLast.x, head.y - prevLast.y);
      const inside =
        el.kind !== "fill" || segmentInsideShape(toMm(prevLast), toMm(head), el.outer, el.holes);
      if (d < mm(2)) {
        runs[i] = { ...runs[i], connection: "continuous" };
      } else if (inside) {
        const walk = walkPoints(prevLast, head);
        runs[i] = { ...runs[i], stitches: [...walk, ...runs[i].stitches], connection: "continuous" };
      } else {
        runs[i] = { ...runs[i], connection: "jump" };
      }
    }

    // 部品間の接続
    let join: JoinKind;
    let joinMm = 0;
    const first = runs[0].stitches[0];
    if (curColor !== ck || needle === null) {
      join = needle === null ? "start" : "color";
      blocks.push({
        thread: { r: el.color.r, g: el.color.g, b: el.color.b, name: el.color.name },
        runs: [],
      });
      runs[0] = { ...runs[0], connection: "trim" };
    } else {
      const a = toMm(needle);
      const b = toMm(first);
      joinMm = dist(a, b);
      if (joinMm < 2 || (joinMm <= 60 && pathHidden(a, b, index, ck, covers))) {
        // つなぎ縫い: 経路上に針を落として移動 (隠れる / ごく近い)
        const walk = walkPoints(needle, first);
        runs[0] = { ...runs[0], stitches: [...walk, ...runs[0].stitches], connection: "continuous" };
        join = "walk";
        walks++;
      } else if (s.trimPolicy === "fewer" || (s.trimPolicy === "auto" && joinMm < s.trimDistance)) {
        runs[0] = { ...runs[0], connection: "jump" };
        join = "jump";
        jumps++;
        longestJump = Math.max(longestJump, joinMm);
      } else {
        runs[0] = { ...runs[0], connection: "trim" };
        join = "trim";
      }
    }

    const objectId = index;
    const block = blocks[blocks.length - 1];
    for (const r of runs) {
      block.runs.push(
        postprocessRun({
          ...r,
          objectId,
          stitchType: el.kind === "fill" ? "tatami" : el.kind === "stitches" ? "manual" : "satin",
        }),
      );
    }
    const lastRun = block.runs[block.runs.length - 1];
    needle = lastRun.stitches[lastRun.stitches.length - 1];
    curColor = ck;

    const style =
      el.kind === "fill" ? "タタミ" : el.kind === "stitches" ? "縫い目" : styleLabel(resolveStrokeStyle(el));
    seqMeta.push({
      objectId,
      elementId: el.id,
      layerId: u.layer.id,
      layerName: u.layer.name,
      kind: el.kind,
      styleLabel: style,
      color: el.color,
      join,
      joinMm: Math.round(joinMm * 10) / 10,
    });
  });

  const plan: StitchPlan = { name: asciiName(s.name), blocks: blocks.filter((b) => b.runs.length > 0) };

  // 部品ごとの針数と平坦化インデックス
  const counts = new Map<number, { n: number; from: number; to: number }>();
  let idx = 0;
  for (const b of plan.blocks) {
    for (const r of b.runs) {
      const id = r.objectId ?? -1;
      const c = counts.get(id) ?? { n: 0, from: idx, to: idx };
      c.n += r.stitches.length;
      idx += r.stitches.length;
      c.to = idx;
      counts.set(id, c);
    }
  }
  const seq: SeqItem[] = seqMeta.map(({ objectId, ...m }) => {
    const c = counts.get(objectId) ?? { n: 0, from: 0, to: 0 };
    return { ...m, stitches: c.n, from: c.from, to: c.to };
  });

  // 統計
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of plan.blocks) {
    for (const r of b.runs) {
      for (const p of r.stitches) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
  }
  const stitches = countStitches(plan);
  const stats: CompileStats = {
    stitches,
    colors: new Set(plan.blocks.map((b) => `${b.thread.r},${b.thread.g},${b.thread.b}`)).size,
    colorChanges: Math.max(0, plan.blocks.length - 1),
    trims: countTrims(plan),
    jumps,
    walks,
    widthMm: minX === Infinity ? 0 : (maxX - minX) / 10,
    heightMm: minY === Infinity ? 0 : (maxY - minY) / 10,
    minutes: Math.round((stitches / 400) * 10) / 10,
    longestJumpMm: Math.round(longestJump * 10) / 10,
  };
  return { plan, seq, stats, warnings: [...new Set(warnings)] };
}

/** a→b の間に 2.5mm 間隔で針を落とす (両端は含まない) */
function walkPoints(a: Point, b: Point): Point[] {
  return resamplePolyline([a, b], mm(2.5))
    .slice(1, -1)
    .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
}

function segmentInsideShape(a: Vec, b: Vec, outer: Vec[], holes: Vec[][]): boolean {
  const n = Math.max(1, Math.ceil(dist(a, b) / 0.6));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (!pointInShape({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, outer, holes)) {
      return false;
    }
  }
  return true;
}

function styleLabel(s: string): string {
  return s === "running" ? "ランニング" : s === "triple" ? "3重" : "サテン";
}

function asciiName(name: string): string {
  const a = name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
  return a || "SKETCH";
}

/** ステッチ列を平坦化する (プレビュー/プレイヤー用) */
export interface FlatStitch {
  x: number;
  y: number;
  /** 0=通常 1=渡り糸の着地 2=糸切り後の着地 3=色替え後の着地 */
  move: 0 | 1 | 2 | 3;
  block: number;
}

export function flattenPlan(plan: StitchPlan): FlatStitch[] {
  const out: FlatStitch[] = [];
  plan.blocks.forEach((b, bi) => {
    b.runs.forEach((r, ri) => {
      r.stitches.forEach((p, pi) => {
        let move: FlatStitch["move"] = 0;
        if (pi === 0) {
          if (ri === 0) move = bi === 0 ? 2 : 3;
          else if (r.connection === "trim") move = 2;
          else if (r.connection === "jump") move = 1;
        }
        out.push({ x: p.x, y: p.y, move, block: bi });
      });
    });
  });
  return out;
}
