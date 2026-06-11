// 細い線領域のスケルトン (中心線) ベースのステッチ生成。
// Ink/Stitch の auto-route satin / centerline と同じ考え方:
//   1. 領域マスクを細線化 (Zhang-Suen) して中心線ネットワークを得る
//   2. ネットワークをグラフ化 (端点・分岐点をノード、間の画素列をエッジ)
//   3. DFS で全エッジを「行き=アンダーパス (渡り縫い)、帰り=本縫い」の
//      一筆書きルートにする → 連結した線は糸切りゼロで縫える
//   4. 本縫いはサテン (距離変換による局所幅 + 局所方向のジグザグ) または
//      ランニング (センターライン)

export type Px = [number, number];

// ----------------------------------------------------------- 細線化と距離変換

/** Zhang-Suen 細線化。mask は 0/1、結果も 0/1 (中心線のみ1) */
export function thinMask(mask: Uint8Array, w: number, h: number): Uint8Array {
  const img = mask.slice();
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x];
  const toDelete: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      toDelete.length = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!img[y * w + x]) continue;
          const p2 = at(x, y - 1);
          const p3 = at(x + 1, y - 1);
          const p4 = at(x + 1, y);
          const p5 = at(x + 1, y + 1);
          const p6 = at(x, y + 1);
          const p7 = at(x - 1, y + 1);
          const p8 = at(x - 1, y);
          const p9 = at(x - 1, y - 1);
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let i = 0; i < 8; i++) if (seq[i] === 0 && seq[i + 1] === 1) a++;
          if (a !== 1) continue;
          if (pass === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          }
          toDelete.push(y * w + x);
        }
      }
      if (toDelete.length > 0) {
        changed = true;
        for (const i of toDelete) img[i] = 0;
      }
    }
  }
  return img;
}

/** チャンファー距離変換 (3-4)。境界からの距離 ≈ 値/3 px */
export function distanceTransform(mask: Uint8Array, w: number, h: number): Int32Array {
  const INF = 1 << 29;
  const dt = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) dt[i] = mask[i] ? INF : 0;
  // 前方パス
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dt[i] === 0) continue;
      let v = dt[i];
      if (x > 0) v = Math.min(v, dt[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, dt[i - w] + 3);
        if (x > 0) v = Math.min(v, dt[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, dt[i - w + 1] + 4);
      }
      dt[i] = v;
    }
  }
  // 後方パス
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (dt[i] === 0) continue;
      let v = dt[i];
      if (x < w - 1) v = Math.min(v, dt[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, dt[i + w] + 3);
        if (x < w - 1) v = Math.min(v, dt[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, dt[i + w - 1] + 4);
      }
      dt[i] = v;
    }
  }
  return dt;
}

// ----------------------------------------------------------- グラフ化とルート

export interface SkeletonEdge {
  a: number; // ノード画素のインデックス
  b: number;
  path: Px[]; // a → b の画素列 (両端含む)
}

const N8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/** スケルトン画素をノード (端点・分岐点) とエッジに分解する */
export function skeletonGraph(
  skel: Uint8Array,
  w: number,
  h: number,
): { edges: SkeletonEdge[]; nodes: Set<number> } {
  const deg = new Map<number, number>();
  const pixels: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!skel[y * w + x]) continue;
      pixels.push(y * w + x);
      let d = 0;
      for (const [dx, dy] of N8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && skel[ny * w + nx]) d++;
      }
      deg.set(y * w + x, d);
    }
  }

  const nodes = new Set<number>();
  for (const p of pixels) {
    const d = deg.get(p)!;
    if (d !== 2) nodes.add(p); // 端点 (≤1) と分岐点 (≥3)
  }

  const edges: SkeletonEdge[] = [];
  const usedStep = new Set<string>(); // "min|max" 形式の移動済みペア
  const stepKey = (p: number, q: number) => (p < q ? `${p}|${q}` : `${q}|${p}`);
  const neighborsOf = (p: number): number[] => {
    const x = p % w;
    const y = (p / w) | 0;
    const out: number[] = [];
    for (const [dx, dy] of N8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && skel[ny * w + nx]) out.push(ny * w + nx);
    }
    return out;
  };
  const toPx = (p: number): Px => [p % w, (p / w) | 0];

  // ノードから伸びる鎖をたどる
  for (const start of nodes) {
    for (const first of neighborsOf(start)) {
      if (usedStep.has(stepKey(start, first))) continue;
      const path: Px[] = [toPx(start)];
      usedStep.add(stepKey(start, first));
      let prev = start;
      let cur = first;
      path.push(toPx(cur));
      while (!nodes.has(cur)) {
        const next = neighborsOf(cur).find(
          (n) => n !== prev && !usedStep.has(stepKey(cur, n)),
        );
        if (next === undefined) break; // 行き止まり (理論上ノードのはず)
        usedStep.add(stepKey(cur, next));
        prev = cur;
        cur = next;
        path.push(toPx(cur));
      }
      edges.push({ a: start, b: cur, path });
    }
  }

  // ノードを持たない純粋なループ (輪) を拾う
  for (const p of pixels) {
    if (nodes.has(p)) continue;
    const nbs = neighborsOf(p);
    const unvisited = nbs.filter((n) => !usedStep.has(stepKey(p, n)));
    if (unvisited.length !== 2) continue; // すでにエッジに取り込まれている
    nodes.add(p);
    const path: Px[] = [toPx(p)];
    usedStep.add(stepKey(p, unvisited[0]));
    let prev = p;
    let cur = unvisited[0];
    path.push(toPx(cur));
    while (cur !== p) {
      const next = neighborsOf(cur).find((n) => n !== prev);
      if (next === undefined) break;
      usedStep.add(stepKey(cur, next));
      prev = cur;
      cur = next;
      path.push(toPx(cur));
    }
    edges.push({ a: p, b: p, path });
  }

  return { edges, nodes };
}

export interface RouteMove {
  /** 向き付けされた画素列 */
  path: Px[];
  /** true = 行き (アンダーパス / 渡り縫い)、false = 帰り (本縫い) */
  underpath: boolean;
}

/**
 * 全エッジを一筆書きでなぞるルートを返す。
 * 各エッジは「行き (アンダーパス) → 部分木を処理 → 帰り (本縫い)」の
 * ちょうど2回ずつ通る。開始ノードに戻って終わる。
 */
export function routeSkeleton(edges: SkeletonEdge[], nodes: Set<number>): RouteMove[] {
  if (edges.length === 0) return [];
  const adj = new Map<number, SkeletonEdge[]>();
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a)!.push(e);
    if (e.b !== e.a) adj.get(e.b)!.push(e);
  }
  // 端点 (次数1) があればそこから開始 (見た目が自然)
  let start = edges[0].a;
  for (const n of nodes) {
    if ((adj.get(n)?.length ?? 0) === 1) {
      start = n;
      break;
    }
  }

  const moves: RouteMove[] = [];
  const visited = new Set<SkeletonEdge>();
  // 明示的スタックで DFS (深い鎖でも安全)
  const dfs = (node: number): void => {
    for (const e of adj.get(node) ?? []) {
      if (visited.has(e)) continue;
      visited.add(e);
      const forward = e.a === node ? e.path : [...e.path].reverse();
      const other = e.a === node ? e.b : e.a;
      moves.push({ path: forward, underpath: true });
      if (other !== node) dfs(other);
      moves.push({ path: [...forward].reverse(), underpath: false });
    }
  };
  dfs(start);
  return moves;
}

// ----------------------------------------------------------- ステッチ生成

/** 折れ線を一定ピッチで再サンプリング (両端を含む) */
export function resamplePath(path: Px[], step: number): Px[] {
  if (path.length === 0) return [];
  const out: Px[] = [path[0]];
  let carry = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const [x0, y0] = path[i];
    const [x1, y1] = path[i + 1];
    const segLen = Math.hypot(x1 - x0, y1 - y0);
    if (segLen < 1e-9) continue;
    let d = step - carry;
    while (d < segLen) {
      const t = d / segLen;
      out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      d += step;
    }
    carry = segLen - (d - step);
  }
  const last = path[path.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.25) {
    out.push(last);
  } else {
    out[out.length - 1] = last;
  }
  return out;
}

/** 折れ線の移動平均平滑化 (端点は固定)。スケルトンのピクセル階段を均す */
export function smoothPolyline(path: Px[], passes: number): Px[] {
  let pts = path;
  for (let p = 0; p < passes; p++) {
    if (pts.length < 3) break;
    const out: Px[] = [pts[0]];
    for (let i = 1; i + 1 < pts.length; i++) {
      out.push([
        (pts[i - 1][0] + pts[i][0] * 2 + pts[i + 1][0]) / 4,
        (pts[i - 1][1] + pts[i][1] * 2 + pts[i + 1][1]) / 4,
      ]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

export interface SkeletonStitchOptions {
  /** 本縫いの種類 */
  mode: "satin" | "centerline";
  /** サテンのジグザグ間隔 (px) */
  satinStepPx: number;
  /** アンダーパス / センターラインの針目 (px) */
  runStepPx: number;
  /** 距離変換 (局所半幅 = dt/3 px)。satin で必須 */
  dt: Int32Array;
  w: number;
  /** サテン半幅の上限 (px) */
  maxHalfWidthPx: number;
}

/**
 * ルートから1本の連続したステッチ列 (px 座標) を生成する。
 * 行き=中心線上のランニング (後でサテンに覆われる)、帰り=本縫い。
 */
export function stitchRoute(moves: RouteMove[], o: SkeletonStitchOptions): Px[] {
  const out: Px[] = [];
  const push = (p: Px) => {
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.05) return;
    out.push(p);
  };

  for (const move of moves) {
    if (move.underpath || o.mode === "centerline") {
      // ランニング (アンダーパス / センターライン往復)
      const pts = smoothPolyline(resamplePath(smoothPolyline(move.path, 2), o.runStepPx), 1);
      for (const p of pts) push(p);
      continue;
    }
    // サテン: 局所幅・局所方向のジグザグ。
    // 中心線を平滑化してからサンプリングし、接線は±2点の窓で取って
    // ピクセル階段による法線の乱れ (ガタつき) を防ぐ
    const center = smoothPolyline(move.path, 3);
    const pts = resamplePath(center, o.satinStepPx);
    let side = 1;
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      const [px0, py0] = pts[Math.max(0, i - 2)];
      const [px1, py1] = pts[Math.min(pts.length - 1, i + 2)];
      let tx = px1 - px0;
      let ty = py1 - py0;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const nx = -ty;
      const ny = tx;
      const xi = Math.max(0, Math.min(o.w - 1, Math.round(x)));
      const yi = Math.max(0, Math.round(y));
      const idx = yi * o.w + xi;
      const hwRaw = idx < o.dt.length ? o.dt[idx] / 3 : 1;
      // +0.5px は端まで糸が届くようにする補正 (簡易の引き縮み補正)
      const hw = Math.min(o.maxHalfWidthPx, Math.max(0.6, hwRaw + 0.5));
      push([x + nx * hw * side, y + ny * hw * side]);
      side = -side;
    }
  }
  return out;
}
