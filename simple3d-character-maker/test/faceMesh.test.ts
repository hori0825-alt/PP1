import { describe, expect, it } from 'vitest';
import { buildEyeMesh, buildMouthMesh } from '../src/geometry/faceMesh';
import { analyzeTopology } from '../src/inspect/topology';
import {
  defaultEyeParams,
  defaultMouthParams,
  eggplantBodySections,
} from '../src/presets/eggplant';

describe('buildEyeMesh (eggplant preset)', () => {
  it('produces a watertight shell for both eyes', () => {
    const { geometry } = buildEyeMesh(defaultEyeParams, eggplantBodySections);
    const stats = analyzeTopology(geometry);
    expect(stats.boundaryEdgeCount).toBe(0);
    expect(stats.nonManifoldEdgeCount).toBe(0);
  });

  it('places the two eyes symmetrically around the front (x mirrored)', () => {
    const { geometry } = buildEyeMesh(defaultEyeParams, eggplantBodySections);
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox!;
    expect(bbox.min.x).toBeCloseTo(-bbox.max.x, 1);
  });
});

describe('buildMouthMesh (eggplant preset)', () => {
  it('produces a watertight ribbon for the soft preset', () => {
    const { geometry } = buildMouthMesh(defaultMouthParams, eggplantBodySections);
    const stats = analyzeTopology(geometry);
    expect(stats.boundaryEdgeCount).toBe(0);
    expect(stats.nonManifoldEdgeCount).toBe(0);
  });

  it('produces an empty geometry for preset "none"', () => {
    const { geometry } = buildMouthMesh(
      { ...defaultMouthParams, preset: 'none' },
      eggplantBodySections,
    );
    expect(geometry.getIndex()!.count).toBe(0);
  });

  it('does not add geometric relief for negative relief (visual-only carve in Phase 1)', () => {
    const flat = buildMouthMesh({ ...defaultMouthParams, relief: 0 }, eggplantBodySections);
    const carved = buildMouthMesh({ ...defaultMouthParams, relief: -0.5 }, eggplantBodySections);
    flat.geometry.computeBoundingBox();
    carved.geometry.computeBoundingBox();
    // Phase 1 では relief<0 は見た目のみ（幾何形状は relief=0 と同じ扱い）
    expect(carved.geometry.boundingBox!.max.z).toBeCloseTo(flat.geometry.boundingBox!.max.z, 3);
  });
});
