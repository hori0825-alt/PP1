import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { exportStlBinary } from '../src/export/stl';

function makeTriangleMesh(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  );
  geometry.setIndex([0, 1, 2]);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
}

describe('exportStlBinary', () => {
  it('produces a binary STL with the expected byte length (80 header + 4 count + 50*N)', () => {
    const group = new THREE.Group();
    group.add(makeTriangleMesh());
    const buffer = exportStlBinary(group);

    const view = new DataView(buffer);
    const triangleCount = view.getUint32(80, true);
    expect(triangleCount).toBe(1);
    expect(buffer.byteLength).toBe(80 + 4 + 50 * triangleCount);
  });
});
