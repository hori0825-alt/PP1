import * as THREE from 'three';
import type { BodyParams } from '../core/params';
import { buildBodySurface } from './surface';
import { fixOutwardWinding } from './meshUtils';

export interface BodyMeshResult {
  geometry: THREE.BufferGeometry;
  warnings: string[];
}

/** z(t) が単調増加であることを前提に、二分探索で z(t) = targetZ となる t を求める。 */
function findTForZ(zFn: (t: number) => number, targetZ: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (zFn(mid) < targetZ) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * 本体メッシュを生成する（開発指示書 6.1節）。
 * - 上端は 1 点に収束させて閉じる。
 * - 底面は Z = flatBottomHeight 以下を平面でカットし、円板でフタをしてウォータータイトにする。
 * - 生成後、符号付き体積で全体の巻き順を検証し、必要なら反転して常に外向き法線にする。
 */
export function buildBodyMesh(params: BodyParams): BodyMeshResult {
  const warnings: string[] = [];
  const surface = buildBodySurface(params.sections);
  const radialSegments = Math.max(8, Math.floor(params.radialSegments));
  const heightSamples = Math.max(3, Math.floor(params.heightSamples));

  const z0 = surface.z(0);
  const z1 = surface.z(1);
  const flatZ = Math.min(Math.max(params.flatBottomHeight, z0), z1);
  const needsSkirt = flatZ > z0 + 1e-6;
  const tFlat = needsSkirt ? findTForZ((t) => surface.z(t), flatZ) : 0;

  const ringCount = heightSamples - 1; // 最後の 1 つは頂点(apex)に置き換えるため
  const ringTs: number[] = [];
  for (let i = 0; i < ringCount; i++) {
    const u = i / (ringCount - 1);
    ringTs.push(tFlat + u * (1 - tFlat));
  }

  const positions: number[] = [];
  const indices: number[] = [];

  const ringVertexStart: number[] = [];
  for (let i = 0; i < ringCount; i++) {
    ringVertexStart.push(positions.length / 3);
    const t = ringTs[i]!;
    for (let j = 0; j < radialSegments; j++) {
      const theta = (j / radialSegments) * Math.PI * 2;
      const p = surface.point(t, theta);
      positions.push(p.x, p.y, p.z);
    }
  }

  // 側面（隣接リング間のクアッド）
  for (let i = 0; i < ringCount - 1; i++) {
    const startA = ringVertexStart[i]!;
    const startB = ringVertexStart[i + 1]!;
    for (let j = 0; j < radialSegments; j++) {
      const jn = (j + 1) % radialSegments;
      const a = startA + j;
      const b = startB + j;
      const c = startB + jn;
      const d = startA + jn;
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  // 上端：1 点に収束させて閉じる
  const apexIndex = positions.length / 3;
  positions.push(surface.cx(1), surface.cy(1), surface.z(1));
  {
    const topRingStart = ringVertexStart[ringCount - 1]!;
    for (let j = 0; j < radialSegments; j++) {
      const jn = (j + 1) % radialSegments;
      indices.push(topRingStart + jn, topRingStart + j, apexIndex);
    }
  }

  // 底面：flatBottomHeight 以下を平面カット + 円板でフタ
  if (needsSkirt) {
    const ring0Start = ringVertexStart[0]!;
    const skirtStart = positions.length / 3;
    for (let j = 0; j < radialSegments; j++) {
      const x = positions[(ring0Start + j) * 3]!;
      const y = positions[(ring0Start + j) * 3 + 1]!;
      positions.push(x, y, 0);
    }
    for (let j = 0; j < radialSegments; j++) {
      const jn = (j + 1) % radialSegments;
      const a = skirtStart + j;
      const b = ring0Start + j;
      const c = ring0Start + jn;
      const d = skirtStart + jn;
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
    const centerIndex = positions.length / 3;
    positions.push(surface.cx(tFlat), surface.cy(tFlat), 0);
    for (let j = 0; j < radialSegments; j++) {
      const jn = (j + 1) % radialSegments;
      indices.push(skirtStart + j, skirtStart + jn, centerIndex);
    }
  } else {
    const ring0Start = ringVertexStart[0]!;
    const centerIndex = positions.length / 3;
    positions.push(surface.cx(tFlat), surface.cy(tFlat), 0);
    for (let j = 0; j < radialSegments; j++) {
      const jn = (j + 1) % radialSegments;
      indices.push(ring0Start + j, ring0Start + jn, centerIndex);
    }
  }

  fixOutwardWinding(positions, indices);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  const triCount = indices.length / 3;
  if (triCount > 10000) {
    warnings.push(`本体の三角形数が目安(10,000)を超えています: ${triCount} 枚`);
  }

  return { geometry, warnings };
}
