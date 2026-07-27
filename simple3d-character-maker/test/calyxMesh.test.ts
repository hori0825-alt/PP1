import { describe, expect, it } from 'vitest';
import { buildCalyxMesh } from '../src/geometry/calyxMesh';
import { analyzeTopology } from '../src/inspect/topology';
import {
  defaultCalyxParams,
  defaultBodyParams,
  eggplantBodySections,
} from '../src/presets/eggplant';

describe('buildCalyxMesh (eggplant preset)', () => {
  it('produces a watertight shell for all 5 leaves (0 boundary / non-manifold edges)', () => {
    const { geometry } = buildCalyxMesh(defaultCalyxParams, eggplantBodySections);
    const stats = analyzeTopology(geometry);
    expect(stats.boundaryEdgeCount).toBe(0);
    expect(stats.nonManifoldEdgeCount).toBe(0);
  });

  it('warns when a leaf embed is below the recommended 0.8mm minimum', () => {
    const calyx = {
      ...defaultCalyxParams,
      leaves: defaultCalyxParams.leaves.map((l) => ({ ...l, embed: 0.5 })),
    };
    const { warnings } = buildCalyxMesh(calyx, eggplantBodySections);
    expect(warnings.some((w) => w.includes('埋め込み'))).toBe(true);
  });

  it('follows the body surface when body sections change (radial footprint tracks the neck radius)', () => {
    const { geometry: geomA } = buildCalyxMesh(defaultCalyxParams, eggplantBodySections);
    geomA.computeBoundingBox();
    const widthA = geomA.boundingBox!.max.x - geomA.boundingBox!.min.x;

    const widerSections = eggplantBodySections.map((s) => ({
      ...s,
      rx: s.rx * 1.5,
      ry: s.ry * 1.5,
    }));
    const { geometry: geomB } = buildCalyxMesh(defaultCalyxParams, widerSections);
    geomB.computeBoundingBox();
    const widthB = geomB.boundingBox!.max.x - geomB.boundingBox!.min.x;

    // 本体を太くすると同じ baseT でも首の半径が変わるため、ヘタの外周（谷の半径）も
    // 追従して広がるはず（ドームの盛り上がり高さ自体は首の太さに依存しない設計）。
    expect(widthB).toBeGreaterThan(widthA);
  });

  it('keeps the default body totalHeight consistent for reference', () => {
    expect(defaultBodyParams.totalHeight).toBe(42);
  });
});
