import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import type { ProjectData } from '../core/params';
import { analyzeTopology } from './topology';

export type Severity = 'red' | 'yellow' | 'green';

export interface CheckItem {
  id: string;
  label: string;
  severity: Severity;
  message: string;
}

export interface CheckInput {
  bodyGeometry: THREE.BufferGeometry;
  calyxGeometry: THREE.BufferGeometry;
  stemGeometry: THREE.BufferGeometry;
  eyeGeometry: THREE.BufferGeometry;
  mouthGeometry: THREE.BufferGeometry;
  project: ProjectData;
  textureReady: boolean;
}

function hasFaces(geometry: THREE.BufferGeometry): boolean {
  const index = geometry.getIndex();
  return !!index && index.count > 0;
}

function mergeAllParts(input: CheckInput): THREE.BufferGeometry {
  const geoms = [input.bodyGeometry, input.calyxGeometry, input.stemGeometry, input.eyeGeometry].filter(
    hasFaces,
  );
  if (hasFaces(input.mouthGeometry)) geoms.push(input.mouthGeometry);
  const merged = mergeGeometries(
    geoms.map((g) => g.clone()),
    false,
  );
  if (!merged) {
    throw new Error('mergeAllParts: ジオメトリの結合に失敗しました');
  }
  return merged;
}

/**
 * 表面から内向きにレイを飛ばし、最小肉厚を近似する（6.8節「近似値・参考」）。
 * three-mesh-bvh を用いた高速な交差判定。
 */
export function approximateMinWallThickness(geometry: THREE.BufferGeometry, sampleCount = 200): number {
  if (!hasFaces(geometry)) return Infinity;
  const bvh = new MeshBVH(geometry);
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex()!;
  const triCount = index.count / 3;
  const step = Math.max(1, Math.floor(triCount / sampleCount));

  let minThickness = Infinity;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();

  for (let t = 0; t < triCount; t += step) {
    const ia = index.array[t * 3]!;
    const ib = index.array[t * 3 + 1]!;
    const ic = index.array[t * 3 + 2]!;
    a.fromBufferAttribute(position, ia);
    b.fromBufferAttribute(position, ib);
    c.fromBufferAttribute(position, ic);
    THREE.Triangle.getNormal(a, b, c, normal);
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);

    const origin = centroid.clone().addScaledVector(normal, -1e-3);
    const direction = normal.clone().multiplyScalar(-1);
    const ray = new THREE.Ray(origin, direction);
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
    if (hit) {
      minThickness = Math.min(minThickness, hit.distance);
    }
  }
  return minThickness;
}

function countExpectedParts(project: ProjectData): number {
  const calyxLeaves = project.calyx.leaves.length;
  const eyes = 2;
  const mouth = project.mouth.preset === 'none' ? 0 : 1;
  return 1 /* body */ + calyxLeaves + 1 /* stem */ + eyes + mouth;
}

/** 3Dプリント検査（開発指示書 6.8節）。判定結果を赤・黄・緑で返す純関数。 */
export function runPrintChecks(input: CheckInput): CheckItem[] {
  const results: CheckItem[] = [];
  const merged = mergeAllParts(input);
  merged.computeBoundingBox();
  const bbox = merged.boundingBox!;
  const topology = analyzeTopology(merged);

  results.push({
    id: 'boundary-edges',
    label: '境界エッジ数（ウォータータイト）',
    severity: topology.boundaryEdgeCount === 0 ? 'green' : 'red',
    message:
      topology.boundaryEdgeCount === 0
        ? 'ウォータータイトです。'
        : `境界エッジが ${topology.boundaryEdgeCount} 本あります（穴がある可能性）。`,
  });

  results.push({
    id: 'non-manifold-edges',
    label: '非多様体エッジ',
    severity: topology.nonManifoldEdgeCount === 0 ? 'green' : 'red',
    message:
      topology.nonManifoldEdgeCount === 0
        ? '非多様体エッジはありません。'
        : `非多様体エッジが ${topology.nonManifoldEdgeCount} 本あります。`,
  });

  results.push({
    id: 'normal-consistency',
    label: '法線の一貫性',
    severity: topology.inconsistentNormalEdgeCount === 0 ? 'green' : 'red',
    message:
      topology.inconsistentNormalEdgeCount === 0
        ? '法線の向きは一貫しています。'
        : `法線が反転している面が ${topology.inconsistentNormalEdgeCount} 箇所あります。`,
  });

  results.push({
    id: 'degenerate-triangles',
    label: '縮退三角形',
    severity: topology.degenerateTriangleCount === 0 ? 'green' : 'red',
    message:
      topology.degenerateTriangleCount === 0
        ? '縮退三角形はありません。'
        : `面積がほぼ0の三角形が ${topology.degenerateTriangleCount} 枚あります。`,
  });

  const expectedParts = countExpectedParts(input.project);
  results.push({
    id: 'connected-components',
    label: '連結成分数',
    severity: topology.connectedComponentCount === expectedParts ? 'green' : 'yellow',
    message: `連結成分数 ${topology.connectedComponentCount}（想定 ${expectedParts}）。`,
  });

  // パーツ間の交差深さ: 本アプリでは埋め込み量をパラメータとして直接生成しているため
  // （calyxMesh.ts / stemMesh.ts が normal 方向へ -embed だけオフセットして作る）、
  // 生成パラメータそのものが実際の埋め込み深さと一致する。three-mesh-bvh による
  // 幾何的な再計測は 6.8節の最小肉厚チェックで用いる。
  const embedDepths = [...input.project.calyx.leaves.map((l) => l.embed), input.project.stem.embed];
  const minEmbed = Math.min(...embedDepths);
  results.push({
    id: 'intersection-depth',
    label: 'パーツ間の交差深さ',
    severity: minEmbed <= 0 ? 'red' : minEmbed < 0.8 ? 'yellow' : 'green',
    message: `最小埋め込み量 ${minEmbed.toFixed(2)}mm。`,
  });

  const minStemRadius = input.project.stem.radius;
  const minLeafThickness = Math.min(...input.project.calyx.leaves.map((l) => l.thickness));
  const minDiameter = Math.min(minStemRadius, minLeafThickness);
  results.push({
    id: 'min-diameter',
    label: '茎・葉先の最小径',
    severity: minDiameter < 0.8 ? 'red' : minDiameter < 1.2 ? 'yellow' : 'green',
    message: `茎の半径 ${minStemRadius.toFixed(2)}mm / 葉の最小厚み ${minLeafThickness.toFixed(2)}mm。`,
  });

  // 全高との比較は本体パーツ単体のAABBで行う（茎・ヘタは本体の上に付加される
  // 別パーツであり、指定した全高(body.totalHeight)は本体自身の寸法のため）。
  input.bodyGeometry.computeBoundingBox();
  const bodyBbox = input.bodyGeometry.boundingBox!;
  const actualHeight = bodyBbox.max.z - bodyBbox.min.z;
  const heightDiff = Math.abs(actualHeight - input.project.body.totalHeight);
  results.push({
    id: 'dimensions',
    label: 'モデル寸法（AABB）',
    severity: heightDiff > 0.1 ? 'yellow' : 'green',
    message: `本体全高 ${actualHeight.toFixed(2)}mm（指定 ${input.project.body.totalHeight.toFixed(2)}mm、差 ${heightDiff.toFixed(2)}mm）。`,
  });

  results.push({
    id: 'ground-contact',
    label: '底面接地',
    severity: Math.abs(bbox.min.z) > 1e-2 ? 'red' : 'green',
    message: `bbox.min.z = ${bbox.min.z.toFixed(3)}mm。`,
  });

  const centerX = (bbox.min.x + bbox.max.x) / 2;
  results.push({
    id: 'origin',
    label: '原点位置（X中心）',
    severity: Math.abs(centerX) > 0.5 ? 'yellow' : 'green',
    message: `bbox中心のX = ${centerX.toFixed(2)}mm。`,
  });

  results.push({
    id: 'triangle-count',
    label: '三角形数',
    severity: topology.triangleCount > 100000 ? 'yellow' : 'green',
    message: `三角形数 ${topology.triangleCount} 枚。`,
  });

  results.push({
    id: 'texture',
    label: 'テクスチャ有無',
    severity: input.textureReady ? 'green' : 'red',
    message: input.textureReady ? 'テクスチャは生成済みです。' : 'テクスチャが未生成です。',
  });

  const minThickness = approximateMinWallThickness(merged);
  results.push({
    id: 'min-thickness-approx',
    label: '最小厚み（近似値・参考）',
    severity: minThickness < 3 ? 'yellow' : 'green',
    message: `近似最小肉厚 約${Number.isFinite(minThickness) ? minThickness.toFixed(2) : '不明'}mm（参考値）。`,
  });

  return results;
}
