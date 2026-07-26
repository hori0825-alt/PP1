import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { analyzeTopology } from '../src/inspect/topology';

function makeGeometry(positions: number[], indices: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

// 外向き法線で正しく巻かれた正四面体（頂点0を原点、他3点で底面を形成）
function tetrahedron(offset: [number, number, number] = [0, 0, 0]): { positions: number[]; indices: number[] } {
  const [ox, oy, oz] = offset;
  const p = [
    [0, 0, 1],
    [1, 0, 0],
    [-0.5, 0.87, 0],
    [-0.5, -0.87, 0],
  ].map(([x, y, z]) => [x! + ox, y! + oy, z! + oz]);
  const positions = p.flat();
  // 外向きになるよう手作業で確認済みの巻き順
  const indices = [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2];
  return { positions, indices };
}

describe('analyzeTopology', () => {
  it('reports a single closed component with no defects for a valid tetrahedron', () => {
    const { positions, indices } = tetrahedron();
    const geometry = makeGeometry(positions, indices);
    const stats = analyzeTopology(geometry);
    expect(stats.connectedComponentCount).toBe(1);
    expect(stats.boundaryEdgeCount).toBe(0);
    expect(stats.nonManifoldEdgeCount).toBe(0);
    expect(stats.degenerateTriangleCount).toBe(0);
    expect(stats.triangleCount).toBe(4);
  });

  it('counts two disjoint tetrahedra as two connected components', () => {
    const a = tetrahedron([0, 0, 0]);
    const b = tetrahedron([10, 0, 0]);
    const positions = [...a.positions, ...b.positions];
    const indices = [...a.indices, ...b.indices.map((i) => i + 4)];
    const geometry = makeGeometry(positions, indices);
    const stats = analyzeTopology(geometry);
    expect(stats.connectedComponentCount).toBe(2);
    expect(stats.boundaryEdgeCount).toBe(0);
  });

  it('detects an open (non-watertight) mesh as boundary edges', () => {
    // 四面体から1面を欠いた「開いた」メッシュ
    const { positions, indices } = tetrahedron();
    const openIndices = indices.slice(0, 9); // 3面だけ（4面目を欠く）
    const geometry = makeGeometry(positions, openIndices);
    const stats = analyzeTopology(geometry);
    expect(stats.boundaryEdgeCount).toBeGreaterThan(0);
  });

  it('detects an inconsistently wound (flipped) neighboring face', () => {
    const { positions, indices } = tetrahedron();
    // 最後の面の頂点順序を反転させ、隣接面と巻き順が矛盾するようにする
    const flipped = [...indices];
    const lastFaceStart = flipped.length - 3;
    const tmp = flipped[lastFaceStart + 1]!;
    flipped[lastFaceStart + 1] = flipped[lastFaceStart + 2]!;
    flipped[lastFaceStart + 2] = tmp;
    const geometry = makeGeometry(positions, flipped);
    const stats = analyzeTopology(geometry);
    expect(stats.inconsistentNormalEdgeCount).toBeGreaterThan(0);
  });

  it('detects a degenerate (near-zero-area) triangle', () => {
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0.0000001];
    // 三角形1: 通常。三角形2: 3点がほぼ同一直線上（面積がほぼ0）
    const indices = [0, 1, 2, 0, 1, 3];
    const geometry = makeGeometry(positions, indices);
    const stats = analyzeTopology(geometry);
    expect(stats.degenerateTriangleCount).toBeGreaterThan(0);
  });
});
