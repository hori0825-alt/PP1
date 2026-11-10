// 描いた後の修正操作 (純粋関数)。UI からはこれを呼ぶだけにして、テストできるようにする。
//
//  - 部品の変形: 移動 / 拡大縮小 / 回転 / 反転 / 複製 (コピー&ペースト)
//  - 編集点 (ノード) の操作: 移動 (やわらか変形つき) / 追加 / 削除 / 間引き / 増やす
//
// 線 (StrokeEl) は points が1本のパス、面 (FillEl) は outer と holes の複数の輪。
// どちらも「パス (輪) の配列」として同じように扱う。

import { dist, simplify } from "./geom";
import { uid, type Element, type FillEl, type StrokeEl, type Vec } from "./model";

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 部品の外接矩形 (線は太さぶん広げる) */
export function elementBox(el: Element): Box {
  const pts = el.kind === "stroke" ? el.points : el.outer;
  const pad = el.kind === "stroke" ? el.width / 2 : 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function selectionBox(els: Element[]): Box | null {
  if (els.length === 0) return null;
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const el of els) {
    const e = elementBox(el);
    b.minX = Math.min(b.minX, e.minX);
    b.minY = Math.min(b.minY, e.minY);
    b.maxX = Math.max(b.maxX, e.maxX);
    b.maxY = Math.max(b.maxY, e.maxY);
  }
  return b;
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function cloneElement<T extends Element>(el: T): T {
  return JSON.parse(JSON.stringify(el)) as T;
}

// ------------------------------------------------------------------ 部品の変形

/** すべての点を f で写した新しい部品を返す (id はそのまま) */
export function mapElement(el: Element, f: (v: Vec) => Vec): Element {
  if (el.kind === "stroke") return { ...el, points: el.points.map(f) };
  return { ...el, outer: el.outer.map(f), holes: el.holes.map((h) => h.map(f)) };
}

export const translateFn =
  (dx: number, dy: number) =>
  (v: Vec): Vec => ({ x: v.x + dx, y: v.y + dy });

export const scaleFn =
  (ax: number, ay: number, sx: number, sy: number) =>
  (v: Vec): Vec => ({ x: ax + (v.x - ax) * sx, y: ay + (v.y - ay) * sy });

export const rotateFn = (cx: number, cy: number, rad: number) => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return (v: Vec): Vec => ({ x: cx + (v.x - cx) * c - (v.y - cy) * s, y: cy + (v.x - cx) * s + (v.y - cy) * c });
};

/** 回転: 面に明示の縫い角度があれば、それも一緒に回す */
export function rotateElement(el: Element, cx: number, cy: number, rad: number): Element {
  const out = mapElement(el, rotateFn(cx, cy, rad));
  if (out.kind === "fill" && out.angleDeg !== null) {
    out.angleDeg = norm180(out.angleDeg + (rad * 180) / Math.PI);
  }
  return out;
}

/** 左右反転 (horizontal=true) / 上下反転 */
export function flipElement(el: Element, cx: number, cy: number, horizontal: boolean): Element {
  const out = mapElement(el, horizontal ? scaleFn(cx, cy, -1, 1) : scaleFn(cx, cy, 1, -1));
  if (out.kind === "fill" && out.angleDeg !== null) out.angleDeg = norm180(180 - out.angleDeg);
  return out;
}

function norm180(d: number): number {
  return Math.round(((d % 180) + 180) % 180);
}

/** 新しい id をつけて複製する (ペースト・複製用) */
export function duplicateElements(els: Element[], dx: number, dy: number): Element[] {
  return els.map((el) => ({ ...mapElement(cloneElement(el), translateFn(dx, dy)), id: uid() }));
}

// ------------------------------------------------------------------ 編集点 (ノード)

export interface PathRef {
  /** 点列 */
  pts: Vec[];
  closed: boolean;
}

export interface NodeRef {
  /** 線なら 0。面なら 0 = 外周、1以降 = 穴 */
  ring: number;
  index: number;
}

/** 部品のパス (輪) を列挙する */
export function paths(el: Element): PathRef[] {
  if (el.kind === "stroke") return [{ pts: el.points, closed: el.closed }];
  return [{ pts: el.outer, closed: true }, ...el.holes.map((h) => ({ pts: h, closed: true }))];
}

/** ring 番目のパスを差し替えた新しい部品 */
export function withPath(el: Element, ring: number, pts: Vec[]): Element {
  if (el.kind === "stroke") return { ...el, points: pts };
  if (ring === 0) return { ...el, outer: pts };
  const holes = el.holes.slice();
  holes[ring - 1] = pts;
  return { ...el, holes };
}

function minPoints(el: Element): number {
  return el.kind === "stroke" ? (el.closed ? 3 : 2) : 3;
}

export const nodeKey = (r: NodeRef) => `${r.ring}:${r.index}`;

export function getNode(el: Element, r: NodeRef): Vec | undefined {
  return paths(el)[r.ring]?.pts[r.index];
}

/** p に最も近い編集点 (tol 以内) */
export function nearestNode(el: Element, p: Vec, tol: number): NodeRef | null {
  let best: NodeRef | null = null;
  let bd = tol;
  paths(el).forEach((path, ring) => {
    path.pts.forEach((v, index) => {
      const d = dist(v, p);
      if (d <= bd) {
        bd = d;
        best = { ring, index };
      }
    });
  });
  return best;
}

/**
 * p に最も近い辺 (tol 以内)。返り値の index は「この点の直後に挿入する」位置。
 */
export function nearestSegment(el: Element, p: Vec, tol: number): { ring: number; index: number; point: Vec } | null {
  let best: { ring: number; index: number; point: Vec } | null = null;
  let bd = tol;
  paths(el).forEach((path, ring) => {
    const n = path.closed ? path.pts.length : path.pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = path.pts[i];
      const b = path.pts[(i + 1) % path.pts.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
      const q = { x: a.x + dx * t, y: a.y + dy * t };
      const d = dist(p, q);
      if (d <= bd) {
        bd = d;
        best = { ring, index: i, point: q };
      }
    }
  });
  return best;
}

/** 辺の上に編集点を追加する */
export function insertNode(el: Element, ring: number, afterIndex: number, point: Vec): { el: Element; ref: NodeRef } {
  const pts = paths(el)[ring].pts.slice();
  pts.splice(afterIndex + 1, 0, { x: point.x, y: point.y });
  return { el: withPath(el, ring, pts), ref: { ring, index: afterIndex + 1 } };
}

/**
 * 編集点を削除する。パスが短くなりすぎる場合は、削除できる分だけ削除する。
 * 穴は全部の点が消えたら穴ごと消す。
 */
export function deleteNodes(el: Element, refs: NodeRef[]): Element {
  let out = el;
  const byRing = new Map<number, Set<number>>();
  for (const r of refs) {
    if (!byRing.has(r.ring)) byRing.set(r.ring, new Set());
    byRing.get(r.ring)!.add(r.index);
  }
  // 穴は後ろから処理する (添字がずれないように)
  const rings = [...byRing.keys()].sort((a, b) => b - a);
  for (const ring of rings) {
    const pts = paths(out)[ring].pts;
    const del = byRing.get(ring)!;
    const kept = pts.filter((_, i) => !del.has(i));
    if (out.kind === "fill" && ring > 0 && kept.length < 3) {
      const holes = out.holes.filter((_, i) => i !== ring - 1);
      out = { ...out, holes };
      continue;
    }
    if (kept.length >= minPoints(out)) {
      out = withPath(out, ring, kept);
    } else {
      // 最低限の点数を残す (削除指定の中から、残す点を選ぶ)
      const need = minPoints(out) - kept.length;
      const restore = new Set([...del].slice(0, need));
      out = withPath(
        out,
        ring,
        pts.filter((_, i) => !del.has(i) || restore.has(i)),
      );
    }
  }
  return out;
}

/** パス上の各点の累積長 */
function cumulative(pts: Vec[]): number[] {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + dist(pts[i - 1], pts[i]));
  return s;
}

/**
 * 編集点の移動 (やわらか変形)。
 * 選んだ点は (dx, dy) だけ動き、同じパスの近くの点は、パスに沿った距離が
 * radius 以内なら距離に応じて弱めに一緒に動く。手描きの線を滑らかなまま曲げられる。
 * original は「つかみ始めた時点の部品」。毎回ここから計算するので誤差がたまらない。
 */
export function softMoveNodes(original: Element, refs: NodeRef[], dx: number, dy: number, radius: number): Element {
  let out = original;
  const byRing = new Map<number, number[]>();
  for (const r of refs) {
    if (!byRing.has(r.ring)) byRing.set(r.ring, []);
    byRing.get(r.ring)!.push(r.index);
  }
  paths(original).forEach((path, ring) => {
    const sel = byRing.get(ring);
    if (!sel || sel.length === 0) return;
    const pts = path.pts;
    const s = cumulative(pts);
    const total = path.closed ? s[s.length - 1] + dist(pts[pts.length - 1], pts[0]) : s[s.length - 1];
    const selSet = new Set(sel);
    const moved = pts.map((v, j) => {
      let w = 0;
      if (selSet.has(j)) w = 1;
      else if (radius > 0) {
        let d = Infinity;
        for (const k of sel) {
          let dk = Math.abs(s[j] - s[k]);
          if (path.closed) dk = Math.min(dk, total - dk);
          d = Math.min(d, dk);
        }
        if (d < radius) {
          const t = 1 - (d / radius) ** 2;
          w = t * t;
        }
      }
      return w === 0 ? v : { x: v.x + dx * w, y: v.y + dy * w };
    });
    out = withPath(out, ring, moved);
  });
  return out;
}

/** 編集点を間引く (形をなるべく保ちながら、点の数をおよそ半分にする) */
export function decimate(el: Element): Element {
  let out = el;
  paths(el).forEach((path, ring) => {
    const n = path.pts.length;
    const min = ring === 0 ? minPoints(el) : 3;
    if (n <= Math.max(min, 4)) return;
    const target = Math.max(min, Math.floor(n * 0.6));
    let tol = 0.02;
    let best = path.pts;
    for (let it = 0; it < 14; it++) {
      const s = simplifyPath(path, tol);
      if (s.length < min) break;
      best = s;
      if (s.length <= target) break;
      tol *= 1.6;
    }
    out = withPath(out, ring, best);
  });
  return out;
}

function simplifyPath(path: PathRef, tol: number): Vec[] {
  if (!path.closed) return simplify(path.pts, tol);
  const s = simplify([...path.pts, path.pts[0]], tol);
  s.pop();
  return s;
}

/** 編集点を増やす (各辺の中点に点を足す。形は変わらない) */
export function subdivide(el: Element): Element {
  let out = el;
  paths(el).forEach((path, ring) => {
    const pts = path.pts;
    const res: Vec[] = [];
    const n = path.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < pts.length; i++) {
      res.push(pts[i]);
      if (i < n) {
        const b = pts[(i + 1) % pts.length];
        res.push({ x: (pts[i].x + b.x) / 2, y: (pts[i].y + b.y) / 2 });
      }
    }
    out = withPath(out, ring, res);
  });
  return out;
}

export function nodeCount(el: Element): number {
  return paths(el).reduce((s, p) => s + p.pts.length, 0);
}

export type { FillEl, StrokeEl };
