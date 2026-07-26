import { describe, expect, it } from 'vitest';
import { computeCalibrationScale } from '../src/viewer/overlay';

describe('computeCalibrationScale', () => {
  it('computes scale from two UV points and a known real-world length', () => {
    // 画像は 200x100px。UV (0.25,0.5) と (0.75,0.5) は 100px = 100mm 分離れている。
    const { scale } = computeCalibrationScale({ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }, 200, 100, 50);
    // 実寸50mmを100px(=100mm相当)の距離に合わせるので scale=0.5
    expect(scale).toBeCloseTo(0.5, 6);
  });

  it('throws when the two points are (nearly) identical', () => {
    expect(() => computeCalibrationScale({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 200, 100, 50)).toThrow();
  });
});
