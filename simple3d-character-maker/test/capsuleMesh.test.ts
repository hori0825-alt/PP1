import { describe, expect, it } from 'vitest';
import { buildCapsuleMesh } from '../src/geometry/capsuleMesh';
import { analyzeTopology } from '../src/inspect/topology';
import type { BodySection } from '../src/core/params';

const roundSections: BodySection[] = [
  { t: 0, z: 0, rx: 1, ry: 1, cx: 0, cy: 0, n: 2.2 },
  { t: 0.3, z: 10, rx: 10, ry: 8, cx: 0, cy: 0, n: 2 },
  { t: 0.5, z: 15, rx: 12, ry: 10, cx: 0, cy: 0, n: 2 },
  { t: 0.7, z: 20, rx: 10, ry: 8, cx: 0, cy: 0, n: 2 },
  { t: 1, z: 30, rx: 1, ry: 1, cx: 0, cy: 0, n: 2.2 },
];

describe('buildCapsuleMesh', () => {
  it('is watertight and has a single connected component with consistent normals', () => {
    const { geometry } = buildCapsuleMesh({
      sections: roundSections,
      radialSegments: 32,
      heightSamples: 24,
    });
    const stats = analyzeTopology(geometry);
    expect(stats.boundaryEdgeCount).toBe(0);
    expect(stats.nonManifoldEdgeCount).toBe(0);
    expect(stats.inconsistentNormalEdgeCount).toBe(0);
    expect(stats.connectedComponentCount).toBe(1);
  });

  it('closes both ends to a single point (unlike bodyMesh which flattens the bottom)', () => {
    const { geometry } = buildCapsuleMesh({
      sections: roundSections,
      radialSegments: 16,
      heightSamples: 12,
    });
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox!;
    expect(bbox.min.z).toBeCloseTo(0, 3);
    expect(bbox.max.z).toBeCloseTo(30, 3);
  });
});
