// Branching: 複数の線 (ランニング/サテンライン) を一筆書きに近づける接続。
//
// 端点を共有する線群をグラフ化し、DFS で全ての線を辿る。
// 行き止まりからは「すでに縫った線の上を辿って戻る」(再走行) ことで
// 連結した線群全体を糸切りなしの1本の Run にする (刺繍の標準手法)。
// 離れた線群 (別の連結成分) の間だけ距離に応じて jump / trim する。

import { RUNNING_DEFAULT_LEN, mm } from "../core/constants";
import type { Point, StitchRun } from "../core/types";
import { resamplePolyline } from "../stitch/satin";
import type { ConnectOptions } from "./connect";
import { decideConnection } from "./connect";

/** 端点のクラスタリング許容距離 (これ以内の端点は同一頂点とみなす) */
const JOIN_TOLERANCE = mm(0.5);

export interface BranchStep {
  /** 入力 paths のインデックス */
  index: number;
  /** true なら線を逆向きに縫う */
  reversed: boolean;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * 線群の縫い順だけを決める単純な貪欲法 (再走行なし)。
 * 現在位置から最も近い端点を持つ線を選び、その端点側から縫う。
 */
export function branchOrder(paths: Point[][], start: Point | null = null): BranchStep[] {
  const n = paths.length;
  const used = new Array<boolean>(n).fill(false);
  const steps: BranchStep[] = [];
  let cur = start;

  for (let k = 0; k < n; k++) {
    let best = -1;
    let bestReversed = false;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (used[i] || paths[i].length < 2) continue;
      const head = paths[i][0];
      const tail = paths[i][paths[i].length - 1];
      const dHead = cur === null ? 0 : dist(cur, head);
      const dTail = cur === null ? 0 : dist(cur, tail);
      if (dHead < bestD) {
        bestD = dHead;
        best = i;
        bestReversed = false;
      }
      if (dTail < bestD) {
        bestD = dTail;
        best = i;
        bestReversed = true;
      }
    }
    if (best === -1) break;
    used[best] = true;
    steps.push({ index: best, reversed: bestReversed });
    const p = paths[best];
    cur = bestReversed ? p[0] : p[p.length - 1];
  }
  return steps;
}

// --- グラフ構築 (端点クラスタリング) ---

interface Edge {
  index: number;
  a: number; // 頂点 ID (path の先頭)
  b: number; // 頂点 ID (path の末尾)
  used: boolean;
}

interface Graph {
  vertices: Point[];
  edges: Edge[];
  /** 頂点 ID → 接続エッジ */
  incident: Edge[][];
}

function buildGraph(paths: Point[][]): Graph {
  const vertices: Point[] = [];
  const vertexOf = (p: Point): number => {
    for (let i = 0; i < vertices.length; i++) {
      if (dist(vertices[i], p) <= JOIN_TOLERANCE) return i;
    }
    vertices.push(p);
    return vertices.length - 1;
  };
  const edges: Edge[] = [];
  for (let i = 0; i < paths.length; i++) {
    if (paths[i].length < 2) continue;
    edges.push({
      index: i,
      a: vertexOf(paths[i][0]),
      b: vertexOf(paths[i][paths[i].length - 1]),
      used: false,
    });
  }
  const incident: Edge[][] = vertices.map(() => []);
  for (const e of edges) {
    incident[e.a].push(e);
    if (e.b !== e.a) incident[e.b].push(e);
  }
  return { vertices, edges, incident };
}

export interface DigitizeLinesOptions extends ConnectOptions {
  stitchLength?: number;
  start?: Point | null;
}

/**
 * 線群をランニングステッチの Run 列に変換する (Branching 適用済み)。
 * - 端点を共有する線群 (連結成分) → 再走行を含む1本の連続 Run
 * - 成分間の接続は decideConnection (近距離 jump / 遠距離のみ trim)
 */
export function digitizeLines(paths: Point[][], options: DigitizeLinesOptions = {}): StitchRun[] {
  const stitchLength = options.stitchLength ?? RUNNING_DEFAULT_LEN;
  const graph = buildGraph(paths);

  // 連結成分を求める
  const compOf = new Array<number>(graph.vertices.length).fill(-1);
  let compCount = 0;
  for (let v = 0; v < graph.vertices.length; v++) {
    if (compOf[v] !== -1) continue;
    const id = compCount++;
    const stack = [v];
    compOf[v] = id;
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      for (const e of graph.incident[cur]) {
        for (const w of [e.a, e.b]) {
          if (compOf[w] === -1) {
            compOf[w] = id;
            stack.push(w);
          }
        }
      }
    }
  }

  let remaining = graph.edges.length;

  /** 1つの連結成分を DFS で辿り、再走行込みの折れ線を作る */
  const walkComponent = (startVertex: number): Point[] => {
    const walk: Point[] = [graph.vertices[startVertex]];
    const dfs = (v: number): void => {
      // 近い順ではなく接続順で十分 (全エッジを縫うことが目的)
      for (const e of graph.incident[v]) {
        if (e.used) continue;
        e.used = true;
        remaining--;
        const forward = e.a === v;
        const pathPts = forward ? paths[e.index] : [...paths[e.index]].reverse();
        for (let i = 1; i < pathPts.length; i++) walk.push(pathPts[i]);
        const other = forward ? e.b : e.a;
        dfs(other);
        // まだ縫っていない線が残っている場合のみ、縫った線を辿って戻る
        if (remaining > 0) {
          const back = [...pathPts].reverse();
          for (let i = 1; i < back.length; i++) walk.push(back[i]);
        }
      }
    };
    dfs(startVertex);
    return walk;
  };

  // 成分の縫い順: start から近い順
  const runs: StitchRun[] = [];
  let prevEnd: Point | null = options.start ?? null;
  const done = new Set<number>();

  for (let k = 0; k < compCount; k++) {
    // 次に縫う成分と開始頂点 = prevEnd に最も近い未処理頂点
    let bestV = -1;
    let bestD = Infinity;
    for (let v = 0; v < graph.vertices.length; v++) {
      if (done.has(compOf[v])) continue;
      if (graph.incident[v].length === 0) continue;
      const d = prevEnd === null ? 0 : dist(prevEnd, graph.vertices[v]);
      if (d < bestD) {
        bestD = d;
        bestV = v;
      }
    }
    if (bestV === -1) break;
    done.add(compOf[bestV]);

    const walk = walkComponent(bestV);
    if (walk.length < 2) continue;
    const stitches = resamplePolyline(walk, stitchLength).map((p) => ({
      x: Math.round(p.x),
      y: Math.round(p.y),
    }));
    runs.push({
      stitches,
      connection: decideConnection(prevEnd, stitches[0], false, options),
    });
    prevEnd = stitches[stitches.length - 1];
  }
  return runs;
}
