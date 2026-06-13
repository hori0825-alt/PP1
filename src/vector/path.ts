// 編集可能ベクターパス。
// 刺繍領域 (Region) の輪郭を「疎なノード列」として編集する基盤。
// ノードは corner (折れ) / smooth (なめらか) を持ち、描画・刺繍生成時には
// pathToPolyline で稠密なポリラインへ展開する。
//
// 設計: Region.outer のような稠密点列を直接ドラッグ編集すると点が多すぎて
// 扱えないため、編集はノード列で行い、ステッチ生成の直前にポリライン化する。

import type { Point } from "../core/types";

export type NodeType = "corner" | "smooth";

export interface EditNode {
  x: number;
  y: number;
  type: NodeType;
}

export interface EditPath {
  nodes: EditNode[];
  closed: boolean;
}

export function clonePath(path: EditPath): EditPath {
  return { closed: path.closed, nodes: path.nodes.map((n) => ({ ...n })) };
}

// --- ノード操作 (いずれも新しい EditPath を返す。非破壊) ---

/** index の後ろにノードを挿入 */
export function addNode(path: EditPath, index: number, point: Point, type: NodeType = "corner"): EditPath {
  const nodes = path.nodes.map((n) => ({ ...n }));
  nodes.splice(index + 1, 0, { x: point.x, y: point.y, type });
  return { ...path, nodes };
}

/** ノードを削除 (最低2点は残す) */
export function deleteNode(path: EditPath, index: number): EditPath {
  if (path.nodes.length <= 2) return path;
  const nodes = path.nodes.filter((_, i) => i !== index);
  return { ...path, nodes };
}

/** ノードを移動 */
export function moveNode(path: EditPath, index: number, point: Point): EditPath {
  const nodes = path.nodes.map((n, i) => (i === index ? { ...n, x: point.x, y: point.y } : { ...n }));
  return { ...path, nodes };
}

/** ノードの種別 (corner/smooth) を切り替え */
export function setNodeType(path: EditPath, index: number, type: NodeType): EditPath {
  const nodes = path.nodes.map((n, i) => (i === index ? { ...n, type } : { ...n }));
  return { ...path, nodes };
}

/** 全ノードを corner または smooth にする */
export function setAllNodeTypes(path: EditPath, type: NodeType): EditPath {
  return { ...path, nodes: path.nodes.map((n) => ({ ...n, type })) };
}

/**
 * 開いたパスをノード index で2本に分割する (ナイフツール)。
 * 閉パスの場合は index を起点とする1本の開パスにする (break apart)。
 */
export function splitPath(path: EditPath, index: number): EditPath[] {
  if (path.closed) {
    // 閉パス → index から一周する開パス
    const n = path.nodes.length;
    const nodes: EditNode[] = [];
    for (let k = 0; k <= n; k++) nodes.push({ ...path.nodes[(index + k) % n] });
    return [{ nodes, closed: false }];
  }
  if (index <= 0 || index >= path.nodes.length - 1) return [path];
  const a: EditPath = { closed: false, nodes: path.nodes.slice(0, index + 1).map((n) => ({ ...n })) };
  const b: EditPath = { closed: false, nodes: path.nodes.slice(index).map((n) => ({ ...n })) };
  return [a, b];
}

/** 2本の開パスを、近い端点同士でつないで1本にする */
export function joinPaths(a: EditPath, b: EditPath): EditPath {
  const dist = (p: EditNode, q: EditNode): number => Math.hypot(p.x - q.x, p.y - q.y);
  const aHead = a.nodes[0];
  const aTail = a.nodes[a.nodes.length - 1];
  const bHead = b.nodes[0];
  const bTail = b.nodes[b.nodes.length - 1];
  // a の末尾に最も近い b の端点を選んで連結
  const toBHead = dist(aTail, bHead);
  const toBTail = dist(aTail, bTail);
  const bNodes = toBTail < toBHead ? [...b.nodes].reverse() : b.nodes;
  void aHead;
  return { closed: false, nodes: [...a.nodes.map((n) => ({ ...n })), ...bNodes.map((n) => ({ ...n }))] };
}

// --- 展開 (ノード列 → ポリライン) ---

/** Catmull-Rom スプラインの1セグメントを補間 (p1→p2 間) */
function catmullRom(p0: Point, p1: Point, p2: Point, p3: Point, samples: number, out: Point[]): void {
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const t2 = t * t;
    const t3 = t2 * t;
    out.push({
      x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    });
  }
}

/**
 * ノード列を稠密なポリライン (Point[]) に展開する。
 * - corner→corner のセグメントは直線
 * - smooth が絡むセグメントは Catmull-Rom スプライン
 *   (corner ノードに隣接する場合はそのノードを制御点に使い、接線をセグメント内に収める)
 */
export function pathToPolyline(path: EditPath, samplesPerSegment = 8): Point[] {
  const nodes = path.nodes;
  const n = nodes.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: nodes[0].x, y: nodes[0].y }];

  const segCount = path.closed ? n : n - 1;
  const at = (i: number): EditNode => {
    if (path.closed) return nodes[((i % n) + n) % n];
    return nodes[Math.max(0, Math.min(n - 1, i))];
  };

  const out: Point[] = [{ x: nodes[0].x, y: nodes[0].y }];
  for (let s = 0; s < segCount; s++) {
    const p1 = at(s);
    const p2 = at(s + 1);
    if (p1.type === "corner" && p2.type === "corner") {
      out.push({ x: p2.x, y: p2.y });
      continue;
    }
    // 制御点: corner 端ではその端点自身を使い接線を内側に収める
    const p0 = p1.type === "smooth" ? at(s - 1) : p1;
    const p3 = p2.type === "smooth" ? at(s + 2) : p2;
    catmullRom(p0, p1, p2, p3, samplesPerSegment, out);
  }
  return out;
}

/** バウンディングボックス (ヒットテスト・スケール計算用) */
export function pathNodeBounds(path: EditPath): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of path.nodes) {
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.x > maxX) maxX = node.x;
    if (node.y > maxY) maxY = node.y;
  }
  return { minX, minY, maxX, maxY };
}
