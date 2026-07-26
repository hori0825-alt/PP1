import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ATLAS_PATCHES, ATLAS_SIZE, patchCenterUV, patchFillRect } from '../src/texture/atlas';
import { assignSolidUV } from '../src/texture/canvasPainter';

describe('atlas patch layout', () => {
  it('keeps all patches within the atlas bounds and non-overlapping', () => {
    const patches = Object.values(ATLAS_PATCHES);
    for (const p of patches) {
      expect(p.x0).toBeGreaterThanOrEqual(0);
      expect(p.y0).toBeGreaterThanOrEqual(0);
      expect(p.x1).toBeLessThanOrEqual(ATLAS_SIZE);
      expect(p.y1).toBeLessThanOrEqual(ATLAS_SIZE);
    }
    for (let i = 0; i < patches.length; i++) {
      for (let j = i + 1; j < patches.length; j++) {
        const a = patches[i]!;
        const b = patches[j]!;
        const overlapX = a.x0 < b.x1 && b.x0 < a.x1;
        const overlapY = a.y0 < b.y1 && b.y0 < a.y1;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it('computes a patch center UV within the patch (v axis flipped from canvas y)', () => {
    const patch = ATLAS_PATCHES.body;
    const { u, v } = patchCenterUV(patch);
    expect(u).toBeCloseTo(0.25, 6); // (0+1024)/2 / 2048
    expect(v).toBeCloseTo(0.75, 6); // 1 - (0+1024)/2/2048
  });

  it('fill rect leaves an 8px margin inside the patch', () => {
    const rect = patchFillRect(ATLAS_PATCHES.stem);
    const patch = ATLAS_PATCHES.stem;
    expect(rect.x).toBe(patch.x0 + 8);
    expect(rect.y).toBe(patch.y0 + 8);
    expect(rect.width).toBe(patch.x1 - patch.x0 - 16);
    expect(rect.height).toBe(patch.y1 - patch.y0 - 16);
  });
});

describe('assignSolidUV', () => {
  it('sets every vertex UV to the same patch-center value (solid fill)', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3),
    );
    assignSolidUV(geometry, ATLAS_PATCHES.eye);
    const uv = geometry.getAttribute('uv')!;
    const expected = patchCenterUV(ATLAS_PATCHES.eye);
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeCloseTo(expected.u, 6);
      expect(uv.getY(i)).toBeCloseTo(expected.v, 6);
    }
  });
});
