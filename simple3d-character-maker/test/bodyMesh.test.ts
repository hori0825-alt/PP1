import { describe, expect, it } from 'vitest';
import { buildBodyMesh } from '../src/geometry/bodyMesh';
import { analyzeTopology } from '../src/inspect/topology';
import { defaultBodyParams } from '../src/presets/eggplant';

describe('buildBodyMesh (eggplant preset)', () => {
  it('produces a watertight mesh (0 boundary edges, 0 non-manifold edges)', () => {
    const { geometry } = buildBodyMesh(defaultBodyParams);
    const stats = analyzeTopology(geometry);
    expect(stats.boundaryEdgeCount).toBe(0);
    expect(stats.nonManifoldEdgeCount).toBe(0);
  });

  it('sits on the ground plane (bbox.min.z === 0) and matches total height', () => {
    const { geometry } = buildBodyMesh(defaultBodyParams);
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox!;
    expect(bbox.min.z).toBeCloseTo(0, 3);
    expect(bbox.max.z).toBeCloseTo(defaultBodyParams.totalHeight, 1);
  });

  it('keeps triangle count within the target range for default settings', () => {
    const { geometry } = buildBodyMesh(defaultBodyParams);
    const triCount = geometry.getIndex()!.count / 3;
    expect(triCount).toBeGreaterThan(1000);
    expect(triCount).toBeLessThan(12000);
  });

  it('warns when triangle count target is exceeded', () => {
    const params = {
      ...defaultBodyParams,
      radialSegments: 200,
      heightSamples: 200,
    };
    const { warnings } = buildBodyMesh(params);
    expect(warnings.some((w) => w.includes('三角形数'))).toBe(true);
  });
});
