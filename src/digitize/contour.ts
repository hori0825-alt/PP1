// ラベルマップから指定色の輪郭ループ (外周 + 穴) を抽出する。
// ピクセル境界に沿った有向エッジ (内部が左側) を繋いでループ化し、
// Douglas-Peucker で簡略化する。偶奇規則で塗りつぶせる形で返す。

export type Pt = [number, number];

/** target ラベルの領域輪郭をループの配列として返す (座標はピクセル単位) */
export function traceContours(
  labels: Int32Array,
  w: number,
  h: number,
  target: number,
): Pt[][] {
  const inside = (x: number, y: number): boolean => {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    return labels[y * w + x] === target;
  };

  // 頂点キー → その頂点から出るエッジの終点リスト
  // 頂点格子は (w+1) x (h+1)
  const W = w + 1;
  const edges = new Map<number, number[]>();
  const key = (x: number, y: number) => y * W + x;
  const addEdge = (x0: number, y0: number, x1: number, y1: number) => {
    const k = key(x0, y0);
    const list = edges.get(k);
    if (list) list.push(key(x1, y1));
    else edges.set(k, [key(x1, y1)]);
  };

  // 内部を左に見る向きの有向エッジを集める
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) addEdge(x, y, x + 1, y); // 上辺 →
      if (!inside(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1); // 右辺 ↓
      if (!inside(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1); // 下辺 ←
      if (!inside(x - 1, y)) addEdge(x, y + 1, x, y); // 左辺 ↑
    }
  }

  const loops: Pt[][] = [];
  for (const [startKey, targets] of edges) {
    while (targets.length > 0) {
      // ループを 1 本たどる
      const loop: Pt[] = [];
      let curKey = startKey;
      let nextKey = targets.pop()!;
      let prevKey = curKey;
      loop.push([curKey % W, (curKey / W) | 0]);
      while (nextKey !== startKey) {
        loop.push([nextKey % W, (nextKey / W) | 0]);
        const cands = edges.get(nextKey);
        if (!cands || cands.length === 0) break; // 不整合 (理論上起きない)
        let chosen: number;
        if (cands.length === 1) {
          chosen = cands.pop()!;
        } else {
          // 角で2本出ている場合は左折優先で自己交差を避ける
          chosen = pickLeftTurn(prevKey, nextKey, cands, W);
        }
        prevKey = nextKey;
        nextKey = chosen;
      }
      if (loop.length >= 4) loops.push(loop);
      // startKey のリストが空になったら map 上は残っていても無視される
    }
  }
  return loops;
}

function pickLeftTurn(prevKey: number, curKey: number, cands: number[], W: number): number {
  const cx = curKey % W;
  const cy = (curKey / W) | 0;
  const px = prevKey % W;
  const py = (prevKey / W) | 0;
  const inDx = cx - px;
  const inDy = cy - py;
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < cands.length; i++) {
    const nx = cands[i] % W;
    const ny = ((cands[i] / W) | 0) - cy;
    const outDx = nx - cx;
    const outDy = ny;
    // 内部側へ曲がる方 (cross > 0) を優先すると接触角でループが分離する
    const cross = inDx * outDy - inDy * outDx;
    const dot = inDx * outDx + inDy * outDy;
    const score = cross * 2 + dot;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  const chosen = cands[bestIdx];
  cands.splice(bestIdx, 1);
  return chosen;
}

/** 折れ線の簡略化 (連続同一・一直線の点を除去してから Douglas-Peucker) */
export function simplifyLoop(loop: Pt[], epsilon: number): Pt[] {
  if (loop.length <= 4) return loop;
  // 一直線上の中間点を除去
  const collinear: Pt[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[(i + loop.length - 1) % loop.length];
    const b = loop[i];
    const c = loop[(i + 1) % loop.length];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cross !== 0) collinear.push(b);
  }
  if (collinear.length < 3) return loop;
  const out = douglasPeucker(collinear.concat([collinear[0]]), epsilon);
  out.pop(); // 閉じる用に重複させた終点を除去
  return out.length >= 3 ? out : collinear;
}

function douglasPeucker(pts: Pt[], eps: number): Pt[] {
  if (pts.length <= 2) return pts.slice();
  let maxD = -1;
  let maxI = 0;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1e-9;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dx * (pts[i][1] - ay) - dy * (pts[i][0] - ax)) / len;
    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const left = douglasPeucker(pts.slice(0, maxI + 1), eps);
  const right = douglasPeucker(pts.slice(maxI), eps);
  return left.slice(0, -1).concat(right);
}

/** 符号付き面積 (ピクセル座標、y軸下向き) */
export function loopArea(loop: Pt[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % loop.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}
