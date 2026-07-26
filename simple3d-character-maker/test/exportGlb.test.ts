import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { exportGlbBinary } from '../src/export/glb';

function makeTriangleMesh(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setIndex([0, 1, 2]);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
}

describe('exportGlbBinary', () => {
  it('produces a valid .glb binary with the glTF magic header', async () => {
    const group = new THREE.Group();
    group.add(makeTriangleMesh());
    const buffer = await exportGlbBinary(group, false);

    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    // glTF binary magic is ASCII "glTF" = 0x46546C67 little-endian
    expect(magic).toBe(0x46546c67);
    expect(buffer.byteLength).toBeGreaterThan(20);
  });
});
