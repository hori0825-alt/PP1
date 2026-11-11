// 縫い目 (針の位置の列) から、元の線・面を推定して編集できる部品に戻す。
//
// 編集用データのない PES (以前の版で書き出したもの・他のソフトのもの) を開いたとき用。
// 針の並び方の特徴で見分ける:
//   - サテン:   幅いっぱいの往復 (折り返し) が連続する          → 太さ付きの線
//   - 3重ぬい:  前→後→前 と同じ所を3回通る                      → 3重の線
//   - タタミ:   行の往復で面を埋める (折り返しの間に直進がある)  → 面 (輪郭は縫い目を塗って求める)
//   - ランニング: 一方向に進む                                   → 細い線
// 下縫い・つなぎ縫い (後で縫う面や線の下に隠れるランニング) と止め縫いは取り除く。
// どれにも当てはまらないものは「縫い目」のまま残す。

import { dilate, smoothRing, stampCapsule, traceLoops } from "./bucket";
import { stripLockStitches } from "./edit";
import { dist, distToPolyline, pointInRing, pointInShape, signedAreaMm, simplify } from "./geom";
import { uid, type FillEl, type StitchEl, type StitchesEl, type StrokeEl, type ThreadRef, type Vec } from "./model";

type Label = "R" | "Z" | "S";

/** 各頂点の曲がり方: R = 同じ所へ戻る (3重・往復), Z = 折り返し, S = それ以外 */
function labels(p: Vec[]): Label[] {
  const out: Label[] = ["S"];
  for (let i = 1; i < p.length - 1; i++) {
    if (dist(p[i - 1], p[i + 1]) < 0.25) {
      out.push("R");
      continue;
    }
    const ax = p[i].x - p[i - 1].x;
    const ay = p[i].y - p[i - 1].y;
    const bx = p[i + 1].x - p[i].x;
    const by = p[i + 1].y - p[i].y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    out.push(la > 1e-6 && lb > 1e-6 && (ax * bx + ay * by) / (la * lb) < -0.5 ? "Z" : "S");
  }
  out.push("S");
  return out;
}

interface Segment {
  kind: "satin" | "triple" | "other";
  /** 針の位置 (端を含む) */
  pts: Vec[];
}

/** 1本の連続した縫い目を、サテン / 3重 / その他 の区間に分ける */
function segment(p: Vec[]): Segment[] {
  const L = labels(p);
  const n = p.length;
  const kind: ("satin" | "triple" | null)[] = new Array(n).fill(null);

  // サテン: 折り返しが 5回以上続き、振り幅が 0.6mm 以上。
  // カーブの内側では針が同じ所に集まり「戻る (R)」に見えるので、それも折り返しとして数える
  const zig = (k: number) => (L[k] === "Z" || L[k] === "R") && dist(p[k], p[k + 1]) >= 0.6 && dist(p[k - 1], p[k]) >= 0.6;
  for (let i = 1; i < n - 1; ) {
    if (!zig(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n - 1 && zig(j)) j++;
    if (j - i >= 5) for (let k = i - 1; k <= j; k++) kind[k] = "satin";
    i = Math.max(j, i + 1);
  }
  // 3重ぬい: 「同じ所へ戻る (R)」が2つ続く所 (前→後→前)。短い線でも見つけられるよう、
  // R の連続のまわりを3重の区間とし、近い区間どうしはつなげる
  for (let k = 1; k < n - 2; k++) {
    if (kind[k] || kind[k + 1]) continue;
    if (L[k] === "R" && L[k + 1] === "R") {
      for (let m = Math.max(0, k - 1); m <= Math.min(n - 1, k + 3); m++) if (!kind[m]) kind[m] = "triple";
    }
  }
  for (let k = 1; k < n - 1; k++) {
    // 3重の区間に挟まれた 1〜2点のすき間を埋める
    if (kind[k] === null && kind[k - 1] === "triple") {
      const nxt = kind[k + 1] === "triple" ? k + 1 : kind[k + 2] === "triple" ? k + 2 : -1;
      if (nxt > 0) for (let m = k; m < nxt; m++) kind[m] = "triple";
    }
  }

  const segs: Segment[] = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || kind[i] !== kind[start]) {
      // 区間の境目の点は両方の区間で共有する (つながりを保つ)
      const pts = p.slice(Math.max(0, start - (start > 0 ? 1 : 0)), i);
      if (pts.length >= 2) segs.push({ kind: kind[start] ?? "other", pts });
      start = i;
    }
  }
  return segs;
}

function polyLen(p: Vec[]): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]);
  return L;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function movingAverage(p: Vec[], k: number): Vec[] {
  return p.map((_, i) => {
    let sx = 0;
    let sy = 0;
    let c = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(p.length - 1, i + k); j++) {
      sx += p[j].x;
      sy += p[j].y;
      c++;
    }
    return { x: sx / c, y: sy / c };
  });
}

function satinStroke(pts: Vec[], color: ThreadRef): StrokeEl | null {
  if (pts.length < 4) return null;
  const mids: Vec[] = [];
  const widths: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    mids.push({ x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2 });
    widths.push(dist(pts[i - 1], pts[i]));
  }
  // 書き出し時の引き縮み補正 (+0.15mm) を戻す
  const width = Math.round(Math.max(1.4, median(widths) - 0.15) * 10) / 10;
  let center = simplify(movingAverage(mids, 2), 0.08);
  const closed = center.length > 3 && dist(center[0], center[center.length - 1]) < Math.max(1, width * 0.6);
  if (closed) center = center.slice(0, -1);
  if (center.length < 2) return null;
  return { kind: "stroke", id: uid(), points: center, closed, width, style: "auto", color };
}

function tripleStroke(pts: Vec[], color: ThreadRef): StrokeEl | null {
  // 前→後→前 の戻りを除き、初めて通る点だけを順に残す
  const path: Vec[] = [];
  for (const q of pts) {
    if (path.slice(-3).some((r) => dist(r, q) < 0.15)) continue;
    path.push(q);
  }
  const s = simplify(path, 0.05);
  if (s.length < 2) return null;
  return { kind: "stroke", id: uid(), points: s, closed: false, width: 1.0, style: "auto", color };
}

function runningStroke(pts: Vec[], color: ThreadRef): StrokeEl | null {
  const s = simplify(pts, 0.05);
  if (s.length < 2) return null;
  const closed = s.length > 3 && dist(s[0], s[s.length - 1]) < 0.3;
  return { kind: "stroke", id: uid(), points: closed ? s.slice(0, -1) : s, closed, width: 0.5, style: "auto", color };
}

/** タタミのように面を埋める縫い目か */
function looksLikeFill(pts: Vec[]): boolean {
  const L = labels(pts);
  const z = L.filter((x) => x === "Z").length;
  let len = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (i) len += dist(pts[i - 1], pts[i]);
    minX = Math.min(minX, pts[i].x);
    minY = Math.min(minY, pts[i].y);
    maxX = Math.max(maxX, pts[i].x);
    maxY = Math.max(maxY, pts[i].y);
  }
  const diag = Math.max(0.5, Math.hypot(maxX - minX, maxY - minY));
  // 小さな面 (行が数本) も見つけられるように、折り返し3回以上・道のりが外寸の3倍以上
  return z >= 3 && len / diag > 3;
}

/** 面を埋める縫い目を塗りつぶし、輪郭 (外周 + 穴) を求める */
function fillsFromStitches(pts: Vec[], color: ThreadRef): FillEl[] {
  const res = 0.1;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const margin = 1.5;
  const size = Math.max(maxX - minX, maxY - minY) + margin * 2;
  const N = Math.min(1600, Math.ceil(size / res));
  const cell = size / N;
  const ox = minX - margin;
  const oy = minY - margin;
  const grid = new Uint8Array(N * N);
  const cx = (v: number) => (v - ox) / cell;
  const cy = (v: number) => (v - oy) / cell;
  // 糸の幅ぶん (行の間隔 0.5mm まで埋まる) で描く
  const r = 0.26 / cell;
  for (let i = 1; i < pts.length; i++) stampCapsule(grid, N, cx(pts[i - 1].x), cy(pts[i - 1].y), cx(pts[i].x), cy(pts[i].y), r);
  // 閉じる (行のすき間を埋める) → 開く (つなぎ縫いのような細い線を消す)
  const k = Math.max(1, Math.round(0.3 / cell));
  const closed = erode(dilate(grid, N, k, null), N, k);
  const o = Math.max(1, Math.round(0.45 / cell));
  // 最後に糸の太さぶん内側へ戻す (針の位置 = 面の縁)
  const opened = erode(dilate(erode(closed, N, o), N, o, null), N, Math.max(1, Math.round(0.22 / cell)));
  const loops = traceLoops(opened, N);
  const rings = loops
    .map((loop) => {
      const mm = loop.map(([x, y]) => ({ x: x * cell + ox, y: y * cell + oy }));
      // 編集しやすいよう、形を保てる範囲で点を減らす
      const sm = smoothRing(mm);
      const ring = simplify([...sm, sm[0]], 0.08).slice(0, -1);
      return { ring: ring.length >= 3 ? ring : sm, area: signedAreaMm(mm) };
    })
    .filter((q) => q.ring.length >= 3);
  const outers = rings.filter((q) => q.area > 1);
  const holes = rings.filter((q) => q.area < -0.5);
  return outers.map((o2) => ({
    kind: "fill",
    id: uid(),
    outer: o2.ring,
    holes: holes.filter((h) => pointInRing(h.ring[0], o2.ring)).map((h) => h.ring),
    angleDeg: rowAngle(pts),
    color,
  }));
}

function erode(src: Uint8Array, N: number, r: number): Uint8Array {
  const inv = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) inv[i] = src[i] ? 0 : 1;
  const d = dilate(inv, N, r, null);
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = d[i] ? 0 : 1;
  return out;
}

/** タタミの行の向き (度、0〜179) = 長い針目の向きの最頻値 */
function rowAngle(pts: Vec[]): number | null {
  const bins = new Array(36).fill(0);
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const len = Math.hypot(dx, dy);
    if (len < 1.2) continue;
    const a = ((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180;
    bins[Math.round(a / 5) % 36] += len;
  }
  const best = bins.indexOf(Math.max(...bins));
  return bins[best] > 0 ? best * 5 : null;
}

/** 1本の連続した縫い目を、推定した線・面に変える */
export function reconstructRun(raw: Vec[], color: ThreadRef): StitchEl[] {
  const pts = stripLockStitches(raw.filter((p, i) => i === 0 || dist(p, raw[i - 1]) > 1e-6));
  if (pts.length < 2) return [];
  const out: StitchEl[] = [];
  const keepAsStitches = (seg: Vec[]): StitchesEl => ({ kind: "stitches", id: uid(), points: seg, color });
  for (const seg of segment(pts)) {
    if (seg.kind === "satin") {
      const s = satinStroke(seg.pts, color);
      out.push(s ?? keepAsStitches(seg.pts));
    } else if (seg.kind === "triple") {
      const s = tripleStroke(seg.pts, color);
      out.push(s ?? keepAsStitches(seg.pts));
    } else if (looksLikeFill(seg.pts)) {
      const f = fillsFromStitches(seg.pts, color);
      if (f.length) out.push(...f);
      else out.push(keepAsStitches(seg.pts));
    } else {
      const s = runningStroke(seg.pts, color);
      if (s) out.push(s);
    }
  }
  // 3重の線・太い線の端に残る「行って戻るだけ」の切れ端 (同じ所をなぞるだけの短いランニング) を除く
  const lines = out.filter((e): e is StrokeEl => e.kind === "stroke" && e.width >= 1);
  const cleaned = out.filter((e) => {
    if (e.kind !== "stroke" || e.width >= 1) return true;
    const retrace = e.points.length <= 3 && polyLen(e.points) < 6;
    const onOther = e.points.every((p) => lines.some((l) => distToPolyline(p, l.points, l.closed) <= Math.max(0.35, l.width / 2)));
    return !(retrace && onOther) && !onOther;
  });
  return mergeSatins(cleaned);
}

/** 角で分かれたサテンの続き (端がつながり太さが近い) を1本にまとめる */
function mergeSatins(els: StitchEl[]): StitchEl[] {
  const out: StitchEl[] = [];
  for (const el of els) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === "stroke" &&
      el.kind === "stroke" &&
      !prev.closed &&
      !el.closed &&
      prev.width >= 1.4 &&
      el.width >= 1.4 &&
      Math.abs(prev.width - el.width) <= Math.max(0.3, prev.width * 0.2) &&
      dist(prev.points[prev.points.length - 1], el.points[0]) < Math.max(prev.width, 1.5)
    ) {
      prev.points = [...prev.points, ...el.points.slice(1)];
      continue;
    }
    out.push(el);
  }
  return out;
}

/** 部品が点 p を覆うか (面の内側 / 太い線の幅の内側) */
function covers(el: StitchEl, p: Vec, tol: number): boolean {
  if (el.kind === "fill") return pointInShape(p, el.outer, el.holes) || distToPolyline(p, el.outer, true) <= tol;
  if (el.kind === "stroke" && el.width >= 1.4) return distToPolyline(p, el.points, el.closed) <= el.width / 2 + tol;
  return false;
}

/**
 * 縫う順に並んだ推定結果から、後で縫う面・太い線の下に隠れる細い線
 * (下縫い・つなぎ縫い) を取り除く。上に重ねて縫った細い線 (目や口など) は残る。
 */
export function dropHiddenRunning(seq: StitchEl[]): StitchEl[] {
  return seq.filter((el, i) => {
    if (el.kind !== "stroke" || el.width >= 1.4 || el.style !== "auto") return true;
    if (el.width > 0.8) return true; // 3重ぬいは意図した線
    const later = seq.slice(i + 1);
    const pts = el.points;
    let hidden = 0;
    for (const p of pts) if (later.some((c) => covers(c, p, 0.6))) hidden++;
    return hidden / pts.length < 0.85;
  });
}
