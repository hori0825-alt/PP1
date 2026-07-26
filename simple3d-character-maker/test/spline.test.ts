import { describe, expect, it } from 'vitest';
import { catmullRomScalar, makeCatmullRomInterpolator } from '../src/core/spline';

describe('catmullRomScalar', () => {
  it('exactly reproduces values at knot points', () => {
    const knots = [
      { t: 0, value: 1 },
      { t: 0.3, value: 4 },
      { t: 0.6, value: 2 },
      { t: 1, value: 5 },
    ];
    for (const k of knots) {
      expect(catmullRomScalar(knots, k.t)).toBeCloseTo(k.value, 9);
    }
  });

  it('clamps outside the knot range', () => {
    const knots = [
      { t: 0, value: 1 },
      { t: 1, value: 2 },
    ];
    expect(catmullRomScalar(knots, -1)).toBeCloseTo(catmullRomScalar(knots, 0), 6);
    expect(catmullRomScalar(knots, 2)).toBeCloseTo(catmullRomScalar(knots, 1), 6);
  });

  it('interpolates smoothly between two points (falls back to linear-like value)', () => {
    const knots = [
      { t: 0, value: 0 },
      { t: 1, value: 10 },
    ];
    expect(catmullRomScalar(knots, 0.5)).toBeCloseTo(5, 6);
  });
});

describe('makeCatmullRomInterpolator', () => {
  it('builds a function usable for arbitrary t', () => {
    const fn = makeCatmullRomInterpolator([0, 0.5, 1], [1, 2, 1]);
    expect(fn(0)).toBeCloseTo(1, 9);
    expect(fn(0.5)).toBeCloseTo(2, 9);
    expect(fn(1)).toBeCloseTo(1, 9);
  });
});
