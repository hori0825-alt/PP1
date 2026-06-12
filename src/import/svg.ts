// SVG 読み込み (DOM 非依存の軽量パーサー)。
// 対応: path / rect / circle / ellipse / polygon / polyline / line / g
//       fill 色、transform (matrix/translate/scale/rotate)、ベジェ・円弧の平坦化
// 出力: fill を持つ閉じた形状 → Region (外周 + 穴)。
// 読み込み後に全体を 100mm 枠 (または指定サイズ) に収めて中心配置する。

import { mm } from "../core/constants";
import { pointInPolygon, selfIntersects, signedArea } from "../core/geometry";
import type { Region } from "../core/region";
import type { Point, ThreadColor } from "../core/types";

// ---------------------------------------------------------------------------
// 軽量 XML パーサー (SVG の部分集合に十分)
// ---------------------------------------------------------------------------

export interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
}

export function parseXml(text: string): XmlElement {
  // コメント・宣言・DOCTYPE・CDATA を除去
  const src = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");

  const root: XmlElement = { tag: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const tagRe = /<\/?([a-zA-Z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src)) !== null) {
    const [whole, tag, attrText, selfClose] = m;
    if (whole.startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrText)) !== null) {
      attrs[am[1]] = am[3] ?? am[4] ?? "";
    }
    const el: XmlElement = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root;
}

// ---------------------------------------------------------------------------
// transform / 色のパース
// ---------------------------------------------------------------------------

/** 2x3 アフィン行列 [a b c d e f]: x' = a*x + c*y + e, y' = b*x + d*y + f */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyMatrix(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

function parseTransform(text: string | undefined): Matrix {
  if (!text) return IDENTITY;
  let m: Matrix = IDENTITY;
  const fnRe = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let fm: RegExpExecArray | null;
  while ((fm = fnRe.exec(text)) !== null) {
    const args = fm[2].split(/[\s,]+/).filter((s) => s.length > 0).map(Number);
    switch (fm[1]) {
      case "matrix":
        if (args.length === 6) m = multiply(m, args as Matrix);
        break;
      case "translate":
        m = multiply(m, [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0]);
        break;
      case "scale":
        m = multiply(m, [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0]);
        break;
      case "rotate": {
        const rad = ((args[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const cx = args[1] ?? 0;
        const cy = args[2] ?? 0;
        m = multiply(m, [1, 0, 0, 1, cx, cy]);
        m = multiply(m, [cos, sin, -sin, cos, 0, 0]);
        m = multiply(m, [1, 0, 0, 1, -cx, -cy]);
        break;
      }
    }
  }
  return m;
}

const NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  pink: [255, 192, 203],
  brown: [165, 42, 42],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
};

export function parseColor(text: string | undefined): ThreadColor | null {
  if (!text) return null;
  const s = text.trim().toLowerCase();
  if (s === "none" || s === "transparent") return null;
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16));
    return { r, g, b };
  }
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) {
    return {
      r: parseInt(m[1].slice(0, 2), 16),
      g: parseInt(m[1].slice(2, 4), 16),
      b: parseInt(m[1].slice(4, 6), 16),
    };
  }
  m = /^rgb\s*\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*\)$/.exec(s);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
  const named = NAMED_COLORS[s];
  if (named) return { r: named[0], g: named[1], b: named[2] };
  return { r: 0, g: 0, b: 0 }; // 不明な色は黒扱い
}

// ---------------------------------------------------------------------------
// パスデータ (d 属性) のパース・平坦化
// ---------------------------------------------------------------------------

const CURVE_SEGMENTS = 24;

function flattenCubic(p0: Point, p1: Point, p2: Point, p3: Point, out: Point[]): void {
  for (let i = 1; i <= CURVE_SEGMENTS; i++) {
    const t = i / CURVE_SEGMENTS;
    const u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
}

function flattenQuadratic(p0: Point, p1: Point, p2: Point, out: Point[]): void {
  for (let i = 1; i <= CURVE_SEGMENTS; i++) {
    const t = i / CURVE_SEGMENTS;
    const u = 1 - t;
    out.push({
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
    });
  }
}

/** SVG 円弧 (A コマンド) を端点パラメータから平坦化する */
function flattenArc(
  p0: Point,
  rx: number,
  ry: number,
  rotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Point,
  out: Point[],
): void {
  if (rx === 0 || ry === 0 || (p0.x === p1.x && p0.y === p1.y)) {
    out.push(p1);
    return;
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx2 = (p0.x - p1.x) / 2;
  const dy2 = (p0.y - p1.y) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (p0.x + p1.x) / 2;
  const cy = sinP * cxp + cosP * cyp + (p0.y + p1.y) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const n = Math.max(2, Math.ceil((Math.abs(dTheta) / (2 * Math.PI)) * CURVE_SEGMENTS * 2));
  for (let i = 1; i <= n; i++) {
    const t = theta1 + (dTheta * i) / n;
    out.push({
      x: cx + rx * Math.cos(t) * cosP - ry * Math.sin(t) * sinP,
      y: cy + rx * Math.cos(t) * sinP + ry * Math.sin(t) * cosP,
    });
  }
}

interface SubPath {
  points: Point[];
  closed: boolean;
}

/** d 属性をサブパス群に平坦化する */
export function parsePathData(d: string): SubPath[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const subpaths: SubPath[] = [];
  let current: Point[] = [];
  let closed = false;
  let pos: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let lastCubicCtrl: Point | null = null;
  let lastQuadCtrl: Point | null = null;
  let i = 0;
  let cmd = "";

  const num = (): number => Number(tokens[i++]);
  const flush = (): void => {
    if (current.length >= 2) subpaths.push({ points: current, closed });
    current = [];
    closed = false;
  };

  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[a-zA-Z]$/.test(t)) {
      cmd = t;
      i++;
    }
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();
    if (c !== "C" && c !== "S") lastCubicCtrl = null;
    if (c !== "Q" && c !== "T") lastQuadCtrl = null;

    switch (c) {
      case "M": {
        flush();
        const x = num();
        const y = num();
        pos = rel ? { x: pos.x + x, y: pos.y + y } : { x, y };
        start = pos;
        current = [pos];
        cmd = rel ? "l" : "L"; // 後続座標は暗黙の lineto
        break;
      }
      case "L": {
        const x = num();
        const y = num();
        pos = rel ? { x: pos.x + x, y: pos.y + y } : { x, y };
        current.push(pos);
        break;
      }
      case "H": {
        const x = num();
        pos = { x: rel ? pos.x + x : x, y: pos.y };
        current.push(pos);
        break;
      }
      case "V": {
        const y = num();
        pos = { x: pos.x, y: rel ? pos.y + y : y };
        current.push(pos);
        break;
      }
      case "C": {
        const c1 = { x: num(), y: num() };
        const c2 = { x: num(), y: num() };
        const end = { x: num(), y: num() };
        const p1 = rel ? { x: pos.x + c1.x, y: pos.y + c1.y } : c1;
        const p2 = rel ? { x: pos.x + c2.x, y: pos.y + c2.y } : c2;
        const p3 = rel ? { x: pos.x + end.x, y: pos.y + end.y } : end;
        flattenCubic(pos, p1, p2, p3, current);
        lastCubicCtrl = p2;
        pos = p3;
        break;
      }
      case "S": {
        const c2 = { x: num(), y: num() };
        const end = { x: num(), y: num() };
        const p2 = rel ? { x: pos.x + c2.x, y: pos.y + c2.y } : c2;
        const p3 = rel ? { x: pos.x + end.x, y: pos.y + end.y } : end;
        const p1 = lastCubicCtrl
          ? { x: 2 * pos.x - lastCubicCtrl.x, y: 2 * pos.y - lastCubicCtrl.y }
          : pos;
        flattenCubic(pos, p1, p2, p3, current);
        lastCubicCtrl = p2;
        pos = p3;
        break;
      }
      case "Q": {
        const c1 = { x: num(), y: num() };
        const end = { x: num(), y: num() };
        const p1 = rel ? { x: pos.x + c1.x, y: pos.y + c1.y } : c1;
        const p2 = rel ? { x: pos.x + end.x, y: pos.y + end.y } : end;
        flattenQuadratic(pos, p1, p2, current);
        lastQuadCtrl = p1;
        pos = p2;
        break;
      }
      case "T": {
        const end = { x: num(), y: num() };
        const p2 = rel ? { x: pos.x + end.x, y: pos.y + end.y } : end;
        const p1: Point = lastQuadCtrl
          ? { x: 2 * pos.x - lastQuadCtrl.x, y: 2 * pos.y - lastQuadCtrl.y }
          : pos;
        flattenQuadratic(pos, p1, p2, current);
        lastQuadCtrl = p1;
        pos = p2;
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num() !== 0;
        const sweep = num() !== 0;
        const end = { x: num(), y: num() };
        const p1 = rel ? { x: pos.x + end.x, y: pos.y + end.y } : end;
        flattenArc(pos, rx, ry, rot, large, sweep, p1, current);
        pos = p1;
        break;
      }
      case "Z": {
        closed = true;
        pos = start;
        flush();
        break;
      }
      default:
        i++; // 未知コマンドはスキップ
    }
  }
  flush();
  return subpaths;
}

// ---------------------------------------------------------------------------
// 図形要素 → サブパス
// ---------------------------------------------------------------------------

function ellipsePath(cx: number, cy: number, rx: number, ry: number): Point[] {
  const n = 48;
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return pts;
}

function shapeSubPaths(el: XmlElement): SubPath[] {
  const a = el.attrs;
  const n = (key: string, def = 0): number => {
    const v = parseFloat(a[key]);
    return Number.isFinite(v) ? v : def;
  };
  switch (el.tag) {
    case "path":
      return a.d ? parsePathData(a.d) : [];
    case "rect": {
      const x = n("x");
      const y = n("y");
      const w = n("width");
      const h = n("height");
      if (w <= 0 || h <= 0) return [];
      return [
        {
          points: [
            { x, y },
            { x: x + w, y },
            { x: x + w, y: y + h },
            { x, y: y + h },
          ],
          closed: true,
        },
      ];
    }
    case "circle":
      return [{ points: ellipsePath(n("cx"), n("cy"), n("r"), n("r")), closed: true }];
    case "ellipse":
      return [{ points: ellipsePath(n("cx"), n("cy"), n("rx"), n("ry")), closed: true }];
    case "polygon":
    case "polyline": {
      const nums = (a.points ?? "").match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
      const pts: Point[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        pts.push({ x: Number(nums[i]), y: Number(nums[i + 1]) });
      }
      return pts.length >= 2 ? [{ points: pts, closed: el.tag === "polygon" }] : [];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// SVG 全体 → Region[]
// ---------------------------------------------------------------------------

interface FilledShape {
  subpaths: Point[][]; // 閉じたサブパスのみ
  color: ThreadColor;
}

function collectShapes(el: XmlElement, matrix: Matrix, inheritedFill: string | undefined, out: FilledShape[]): void {
  for (const child of el.children) {
    const m = multiply(matrix, parseTransform(child.attrs.transform));
    // style 属性内の fill も拾う
    const styleFill = /(?:^|;)\s*fill\s*:\s*([^;]+)/.exec(child.attrs.style ?? "")?.[1];
    const fillText = child.attrs.fill ?? styleFill ?? inheritedFill;

    if (child.tag === "g" || child.tag === "svg") {
      collectShapes(child, m, fillText, out);
      continue;
    }
    const subs = shapeSubPaths(child);
    if (subs.length === 0) continue;
    const color = parseColor(fillText ?? "black");
    if (!color) continue; // fill="none" は領域なし (線のみ。線の刺繍化は後フェーズ)
    const closedSubs = subs
      .filter((s) => s.closed && s.points.length >= 3)
      .map((s) => s.points.map((p) => applyMatrix(m, p)));
    if (closedSubs.length > 0) out.push({ subpaths: closedSubs, color });
  }
}

export interface SvgImportResult {
  regions: Region[];
  /** 元の SVG 座標から内部単位への変換倍率 */
  scale: number;
}

/**
 * SVG テキストを Region 群に変換する。
 * 全形状をまとめて targetUnits (デフォルト 100mm) に収まるよう中心配置でスケールする。
 * サブパスは包含の偶奇 (evenodd) で外周/穴に分類する。
 */
export function importSvg(text: string, targetUnits = mm(100)): SvgImportResult {
  const root = parseXml(text);
  const svg = root.children.find((c) => c.tag === "svg") ?? root;
  const shapes: FilledShape[] = [];
  collectShapes(svg, parseTransform(svg.attrs.transform), undefined, shapes);

  // 全体バウンディングを取り、スケール・中心オフセットを決める
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of shapes) {
    for (const sub of s.subpaths) {
      for (const p of sub) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
  }
  if (shapes.length === 0 || !Number.isFinite(minX)) return { regions: [], scale: 1 };
  const w = Math.max(1e-6, maxX - minX);
  const h = Math.max(1e-6, maxY - minY);
  const scale = targetUnits / Math.max(w, h);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const toUnits = (p: Point): Point => ({ x: (p.x - cx) * scale, y: (p.y - cy) * scale });

  const regions: Region[] = [];
  for (const shape of shapes) {
    const paths = shape.subpaths.map((sub) => sub.map(toUnits));
    // 包含深度: 他のサブパスに含まれる回数。偶数 → 外周、奇数 → 穴
    const depth = paths.map((p, i) => {
      let d = 0;
      for (let j = 0; j < paths.length; j++) {
        if (i !== j && pointInPolygon(p[0], paths[j])) d++;
      }
      return d;
    });
    const outerIdx = paths.map((_, i) => i).filter((i) => depth[i] % 2 === 0);
    for (const oi of outerIdx) {
      // 外周は正方向 (画面座標系で時計回り) に正規化
      const outer = signedArea(paths[oi]) < 0 ? paths[oi].slice().reverse() : paths[oi];
      const holes: Point[][] = [];
      for (let hi = 0; hi < paths.length; hi++) {
        if (depth[hi] % 2 !== 1) continue;
        if (!pointInPolygon(paths[hi][0], paths[oi])) continue;
        // 直接の親 (深度が外周+1) のみをこの外周の穴にする
        if (depth[hi] !== depth[oi] + 1) continue;
        const hole = signedArea(paths[hi]) > 0 ? paths[hi].slice().reverse() : paths[hi];
        holes.push(hole);
      }
      const region: Region = { outer, holes, color: shape.color };
      if (selfIntersects(outer)) region.selfIntersecting = true;
      regions.push(region);
    }
  }
  return { regions, scale };
}
