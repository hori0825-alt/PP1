import * as THREE from 'three';
import type { BodySection } from '../core/params';
import { buildBodySurface } from './surface';
import { fixOutwardWinding } from './meshUtils';

export interface CapsuleMeshResult {
  geometry: THREE.BufferGeometry;
  warnings: string[];
}

export interface CapsuleMeshParams {
  sections: BodySection[];
  radialSegments: number;
  heightSamples: number;
}

/**
 * 断面表現 S(t, θ) を使い、両端を1点に収束させて閉じる「カプセル」形状を作る
 * （牛の胴体・頭のように、底面接地を必要としない浮いたパーツ用）。
 * ロジックは geometry/bodyMesh.ts の上端処理と同じもので、底面のフラット化のみ省く。
 * 生成後にワールド座標系へ配置するのは呼び出し側の責務とする（ローカル軸は
 * S(t, θ) の定義通り、t=0→1 が Z 軸方向）。
 */
export function buildCapsuleMesh(params: CapsuleMeshParams): CapsuleMeshResult {
  const warnings: string[] = [];
  const surface = buildBodySurface(params.sections);
  const radialSegments = Math.max(6, Math.floor(params.radialSegments));
  const heightSamples = Math.max(3, Math.floor(params.heightSamples));

  const ringCount = heightSamples - 1;
  const ringTs: number[] = [];
  for (let i = 0; i < ringCount; i++) {
    ringTs.push(i / (ringCount - 1));
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

  // 上端（t=1側）：1点に収束
  {
    const apexIndex = positions.length / 3;
    positions.push(surface.cx(1), surface.cy(1), surface.z(1));
    const topRingStart = ringVertexStart[ringCount - 1]!;
    for (let j = 0; j < radialSegments; j++) {
      const jn = (j + 1) % radialSegments;
      indices.push(topRingStart + jn, topRingStart + j, apexIndex);
    }
  }

  // 下端（t=0側）：1点に収束
  {
    const baseIndex = positions.length / 3;
    positions.push(surface.cx(0), surface.cy(0), surface.z(0));
    const bottomRingStart = ringVertexStart[0]!;
    for (let j = 0; j < radialSegments; j++) {
      const jn = (j + 1) % radialSegments;
      indices.push(bottomRingStart + j, bottomRingStart + jn, baseIndex);
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
    warnings.push(`パーツの三角形数が目安(10,000)を超えています: ${triCount}`);
  }

  return { geometry, warnings };
}

/** buildBodySurface をそのまま外部（脚・角・耳などの付着位置計算）で使えるように再輸出する。 */
export { buildBodySurface };
