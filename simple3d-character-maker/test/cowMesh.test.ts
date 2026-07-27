import { describe, expect, it } from 'vitest';
import { buildCowMesh } from '../src/geometry/cowMesh';
import { analyzeTopology } from '../src/inspect/topology';
import { createDefaultCowParams } from '../src/presets/cow';

describe('buildCowMesh', () => {
  const cow = createDefaultCowParams();
  const set = buildCowMesh(cow);

  it.each([
    ['body', set.body],
    ['spots', set.spots],
    ['horns', set.horns],
    ['nose', set.nose],
    ['eyes', set.eyes],
  ] as const)('%s group is watertight with consistent normals', (_name, group) => {
    const stats = analyzeTopology(group.geometry);
    expect(stats.boundaryEdgeCount).toBe(0);
    expect(stats.nonManifoldEdgeCount).toBe(0);
    expect(stats.inconsistentNormalEdgeCount).toBe(0);
  });

  it('places the body group above the ground (z >= 0)', () => {
    set.body.geometry.computeBoundingBox();
    const bbox = set.body.geometry.boundingBox!;
    expect(bbox.min.z).toBeGreaterThanOrEqual(-0.01);
  });

  it('places the head and tail on opposite sides along Y (front/back axis)', () => {
    set.body.geometry.computeBoundingBox();
    const bbox = set.body.geometry.boundingBox!;
    // 胴体は Y 軸中心に配置され、頭側は Y- 方向、しっぽ側は Y+ 方向に伸びる想定。
    // 頭・胴体半分だけで少なくとも20mm程度、しっぽだけで10mm程度は張り出すはず。
    expect(bbox.min.y).toBeLessThan(-20);
    expect(bbox.max.y).toBeGreaterThan(10);
  });

  it('does not report leg/tail radius warnings for the default preset', () => {
    expect(set.body.warnings).toEqual([]);
  });
});
