import * as THREE from 'three';

export interface TopologyStats {
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
  /** 同じ有向エッジが2回以上現れる＝隣接面の巻き順（法線）が一貫していない */
  inconsistentNormalEdgeCount: number;
  degenerateTriangleCount: number;
  connectedComponentCount: number;
  triangleCount: number;
}

function vertexKey(positions: ArrayLike<number>, index: number, precision = 4): string {
  const x = positions[index * 3]!.toFixed(precision);
  const y = positions[index * 3 + 1]!.toFixed(precision);
  const z = positions[index * 3 + 2]!.toFixed(precision);
  return `${x},${y},${z}`;
}

class UnionFind {
  private parent = new Map<string, string>();

  private find(x: string): string {
    let root = x;
    while (true) {
      const p = this.parent.get(root);
      if (p === undefined || p === root) break;
      root = p;
    }
    // 経路圧縮
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  add(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  countComponents(): number {
    const roots = new Set<string>();
    for (const key of this.parent.keys()) roots.add(this.find(key));
    return roots.size;
  }
}

function triangleArea(positions: ArrayLike<number>, ia: number, ib: number, ic: number): number {
  const ax = positions[ia * 3]!;
  const ay = positions[ia * 3 + 1]!;
  const az = positions[ia * 3 + 2]!;
  const bx = positions[ib * 3]!;
  const by = positions[ib * 3 + 1]!;
  const bz = positions[ib * 3 + 2]!;
  const cx = positions[ic * 3]!;
  const cy = positions[ic * 3 + 1]!;
  const cz = positions[ic * 3 + 2]!;

  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;

  const cxp = uy * vz - uz * vy;
  const cyp = uz * vx - ux * vz;
  const czp = ux * vy - uy * vx;
  return 0.5 * Math.hypot(cxp, cyp, czp);
}

/**
 * インデックス付きジオメトリのトポロジーを解析する（開発指示書 6.8節の各判定に使用）。
 * 座標が一致する頂点は（インデックスが異なっていても）同一頂点として溶接して扱う。
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

  const undirectedCounts = new Map<string, number>();
  const directedCounts = new Map<string, number>();
  const uf = new UnionFind();
  let degenerateTriangleCount = 0;

  const triangleCount = indices.length / 3;
  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3]!;
    const b = indices[t * 3 + 1]!;
    const c = indices[t * 3 + 2]!;
    const ka = vertexKeys[a]!;
    const kb = vertexKeys[b]!;
    const kc = vertexKeys[c]!;

    uf.union(ka, kb);
    uf.union(kb, kc);

    const area = triangleArea(positions, a, b, c);
    if (area < 1e-6) degenerateTriangleCount++;

    const directedPairs: Array<[string, string]> = [
      [ka, kb],
      [kb, kc],
      [kc, ka],
    ];
    for (const [p, q] of directedPairs) {
      const dKey = `${p}>${q}`;
      directedCounts.set(dKey, (directedCounts.get(dKey) ?? 0) + 1);
      const uKey = p < q ? `${p}|${q}` : `${q}|${p}`;
      undirectedCounts.set(uKey, (undirectedCounts.get(uKey) ?? 0) + 1);
    }
  }

  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  for (const count of undirectedCounts.values()) {
    if (count === 1) boundaryEdgeCount++;
    else if (count > 2) nonManifoldEdgeCount++;
  }

  let inconsistentNormalEdgeCount = 0;
  for (const count of directedCounts.values()) {
    if (count > 1) inconsistentNormalEdgeCount++;
  }

  return {
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    inconsistentNormalEdgeCount,
    degenerateTriangleCount,
    connectedComponentCount: uf.countComponents(),
    triangleCount,
  };
}
