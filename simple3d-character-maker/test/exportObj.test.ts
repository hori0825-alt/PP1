import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildMtlText, exportObjText, postProcessObj } from '../src/export/obj';

function makeTriangleMesh(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setIndex([0, 1, 2]);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
}

describe('postProcessObj', () => {
  it('inserts mtllib at the top and usemtl before the first face line', () => {
    const raw = ['# comment', 'o body', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3'].join('\n');
    const result = postProcessObj(raw);
    const lines = result.split('\n');
    expect(lines[0]).toBe('mtllib model.mtl');
    const usemtlIndex = lines.indexOf('usemtl simple3d_main');
    const faceIndex = lines.findIndex((l) => l.startsWith('f '));
    expect(usemtlIndex).toBeGreaterThan(-1);
    expect(usemtlIndex).toBeLessThan(faceIndex);
  });
});

describe('exportObjText', () => {
  it('produces an OBJ with mtllib/usemtl for a real geometry', () => {
    const group = new THREE.Group();
    group.add(makeTriangleMesh());
    const obj = exportObjText(group);
    expect(obj).toContain('mtllib model.mtl');
    expect(obj).toContain('usemtl simple3d_main');
    expect(obj).toMatch(/^f /m);
  });
});

describe('buildMtlText', () => {
  it('references texture.png and the shared material name', () => {
    const mtl = buildMtlText();
    expect(mtl).toContain('newmtl simple3d_main');
    expect(mtl).toContain('map_Kd texture.png');
  });
});
