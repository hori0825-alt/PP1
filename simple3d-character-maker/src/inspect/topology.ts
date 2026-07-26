import * as THREE from 'three';

export interface TopologyStats {
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
  triangleCount: number;
}

function vertexKey(positions: ArrayLike<number>, index: number, precision = 4): string {
  const x = positions[index * 3]!.toFixed(precision);
  const y = positions[index * 3 + 1]!.toFixed(precision);
  const z = positions[index * 3 + 2]!.toFixed(precision);
  return `${x},${y},${z}`;
}

/**
 * インデックス付きジオメトリのエッジ共有数を数える。
 * 座標が一致する頂点は（インデックスが異なっていても）同一頂点として溶接して扱うため、
 * UV 分割などによる頂点複製があっても正しく境界・非多様体を判定できる。
 */
export function analyzeTopology(geometry: THREE.BufferGeometry): TopologyStats {
  const index = geometry.getIndex();
  if (!index) {
    throw new Error('analyzeTopology: geometry must be indexed');
  }
  const position = geometry.getAttribute('position');
  if (!position) {
    throw new Error('analyzeTopology: geometry must have a position attribute');
  }
  const positions = position.array as ArrayLike<number>;
  const indices = index.array;

  const vertexKeys: string[] = new Array(position.count);
  for (let i = 0; i < position.count; i++) {
    vertexKeys[i] = vertexKey(positions, i);
  }

  const edgeCounts = new Map<string, number>();
  const triangleCount = indices.length / 3;
  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3]!;
    const b = indices[t * 3 + 1]!;
    const c = indices[t * 3 + 2]!;
    const ka = vertexKeys[a]!;
    const kb = vertexKeys[b]!;
    const kc = vertexKeys[c]!;
    const pairs: Array<[string, string]> = [
      [ka, kb],
      [kb, kc],
      [kc, ka],
    ];
    for (const [p, q] of pairs) {
      const key = p < q ? `${p}|${q}` : `${q}|${p}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  for (const count of edgeCounts.values()) {
    if (count === 1) boundaryEdgeCount++;
    else if (count > 2) nonManifoldEdgeCount++;
  }

  return { boundaryEdgeCount, nonManifoldEdgeCount, triangleCount };
}
