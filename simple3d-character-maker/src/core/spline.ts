/**
 * 断面制御点の Catmull-Rom 補間（開発指示書 6.1節）。
 * 断面は t（高さ方向の正規化位置）で非一様に配置されるため、
 * Barry–Goldman のピラミッド法による非一様 Catmull-Rom を用いる。
 * 純関数のみで構成し、副作用を持たない。
 */

export interface ScalarKnot {
  t: number;
  value: number;
}

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

function phantomBefore(p0: ScalarKnot, p1: ScalarKnot): ScalarKnot {
  return { t: p0.t - (p1.t - p0.t), value: p0.value - (p1.value - p0.value) };
}

function phantomAfter(pPrev: ScalarKnot, pLast: ScalarKnot): ScalarKnot {
  return {
    t: pLast.t + (pLast.t - pPrev.t),
    value: pLast.value + (pLast.value - pPrev.value),
  };
}

function findSegment(knots: ScalarKnot[], t: number): number {
  const n = knots.length;
  if (t <= knots[0]!.t) return 0;
  if (t >= knots[n - 1]!.t) return n - 2;
  for (let k = 0; k < n - 1; k++) {
    if (t >= knots[k]!.t && t <= knots[k + 1]!.t) return k;
  }
  return n - 2;
}

/**
 * 非一様 Catmull-Rom 補間で t における値を求める。
 * knots は t の昇順であること（最低 2 点）。
 */
export function catmullRomScalar(knots: ScalarKnot[], t: number): number {
  if (knots.length === 0) {
    throw new Error('catmullRomScalar: knots must not be empty');
  }
  if (knots.length === 1) {
    return knots[0]!.value;
  }

  const n = knots.length;
  const i = findSegment(knots, t);

  const p1 = knots[i]!;
  const p2 = knots[i + 1]!;
  const p0 = i - 1 >= 0 ? knots[i - 1]! : phantomBefore(p1, p2);
  const p3 = i + 2 <= n - 1 ? knots[i + 2]! : phantomAfter(p1, p2);

  // 区間が退化している（同一 t が連続する）場合は線形補間にフォールバックする。
  if (p2.t - p1.t < 1e-9) {
    return p1.value;
  }

  const tc = Math.min(Math.max(t, p1.t), p2.t);

  const d01 = p1.t - p0.t || 1e-9;
  const d12 = p2.t - p1.t || 1e-9;
  const d23 = p3.t - p2.t || 1e-9;

  const a1 = lerp(p0.value, p1.value, (tc - p0.t) / d01);
  const a2 = lerp(p1.value, p2.value, (tc - p1.t) / d12);
  const a3 = lerp(p2.value, p3.value, (tc - p2.t) / d23);

  const d02 = p2.t - p0.t || 1e-9;
  const d13 = p3.t - p1.t || 1e-9;

  const b1 = lerp(a1, a2, (tc - p0.t) / d02);
  const b2 = lerp(a2, a3, (tc - p1.t) / d13);

  return lerp(b1, b2, (tc - p1.t) / d12);
}

/** 複数の (t, value) 系列から、任意の t で評価できる補間関数を作る。 */
export function makeCatmullRomInterpolator(ts: number[], values: number[]): (t: number) => number {
  if (ts.length !== values.length) {
    throw new Error('makeCatmullRomInterpolator: ts and values length mismatch');
  }
  const knots: ScalarKnot[] = ts.map((t, idx) => ({ t, value: values[idx]! }));
  return (t: number) => catmullRomScalar(knots, t);
}
