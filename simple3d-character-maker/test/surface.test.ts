import { describe, expect, it } from 'vitest';
import { buildBodySurface } from '../src/geometry/surface';
import type { BodySection } from '../src/core/params';

function circularSections(radius: number): BodySection[] {
  return [
    { t: 0, z: 0, rx: radius, ry: radius, cx: 0, cy: 0, n: 2 },
    { t: 0.5, z: 25, rx: radius, ry: radius, cx: 0, cy: 0, n: 2 },
    { t: 1, z: 50, rx: radius, ry: radius, cx: 0, cy: 0, n: 2 },
  ];
}

describe('buildBodySurface', () => {
  it('produces a perfect circle in cross-section when n=2 and rx=ry', () => {
    const surface = buildBodySurface(circularSections(10));
    for (let i = 0; i < 16; i++) {
      const theta = (i / 16) * Math.PI * 2;
      const p = surface.point(0.5, theta);
      const dist = Math.hypot(p.x, p.y);
      expect(dist).toBeCloseTo(10, 4);
    }
  });

  it('interpolates z(t) monotonically for monotonically increasing z knots', () => {
    const surface = buildBodySurface(circularSections(10));
    const z0 = surface.z(0);
    const z1 = surface.z(0.5);
    const z2 = surface.z(1);
    expect(z0).toBeLessThan(z1);
    expect(z1).toBeLessThan(z2);
  });

  it('returns a unit-length outward normal', () => {
    const surface = buildBodySurface(circularSections(10));
    const normal = surface.normal(0.5, Math.PI / 4);
    const len = Math.hypot(normal.x, normal.y, normal.z);
    expect(len).toBeCloseTo(1, 3);
    // 半径一定の円断面では、法線はほぼ放射方向（Z成分は小さい）はず。
    expect(Math.abs(normal.z)).toBeLessThan(0.3);
  });

  it('rejects fewer than 2 sections', () => {
    expect(() => buildBodySurface([circularSections(10)[0]!])).toThrow();
  });
});
