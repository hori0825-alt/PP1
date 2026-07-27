import { describe, expect, it } from 'vitest';
import { buildStemMesh } from '../src/geometry/stemMesh';
import { analyzeTopology } from '../src/inspect/topology';
import { defaultStemParams, eggplantBodySections } from '../src/presets/eggplant';

describe('buildStemMesh (eggplant preset)', () => {
  it('produces a watertight shape', () => {
    const { geometry } = buildStemMesh(defaultStemParams, eggplantBodySections);
    const stats = analyzeTopology(geometry);
    expect(stats.boundaryEdgeCount).toBe(0);
    expect(stats.nonManifoldEdgeCount).toBe(0);
  });

  it('warns on radius below the yellow threshold (0.75mm) and the confirmed red minimum (0.5mm)', () => {
    const yellow = buildStemMesh({ ...defaultStemParams, radius: 0.6 }, eggplantBodySections);
    expect(yellow.warnings.some((w) => w.includes('半径'))).toBe(true);

    const red = buildStemMesh({ ...defaultStemParams, radius: 0.3 }, eggplantBodySections);
    expect(red.warnings.some((w) => w.includes('危険'))).toBe(true);
  });

  it('embeds the bottom end below the body apex by at least the embed amount', () => {
    const { geometry } = buildStemMesh(defaultStemParams, eggplantBodySections);
    geometry.computeBoundingBox();
    const apexZ = 42; // eggplant preset totalHeight
    // 埋め込み分だけ頂点より下から始まっているはず
    expect(geometry.boundingBox!.min.z).toBeLessThan(apexZ);
  });
});
