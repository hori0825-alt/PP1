import * as THREE from 'three';
import type { BodySection, EyeParams, MouthParams } from '../core/params';
import { buildBodySurface } from './surface';
import {
  appendGridShell,
  appendLensShellOnSurface,
  fixOutwardWinding,
  surfaceNormalVec3,
  surfacePointVec3,
  tangentPlaneToSurface,
  type GridShellPoint,
} from './meshUtils';

export interface FaceMeshResult {
  geometry: THREE.BufferGeometry;
  warnings: string[];
}

const DEG2RAD = Math.PI / 180;
// -Y が正面（3.2節）。顔のパーツはすべてこの方位角を中心に配置する。
const FRONT_THETA = -Math.PI / 2;
// 目・口は本体表面へのわずかな埋め込みで薄いシェルを閉じる（指示書に明記の無い実装上の定数）。
const FACE_EMBED_MM = 0.3;

/** 目を生成する（開発指示書 6.4節）。左右対称に本体表面へ配置し、法線方向へ盛り上げる。 */
export function buildEyeMesh(
  eyes: EyeParams,
  bodySections: readonly BodySection[],
): FaceMeshResult {
  const warnings: string[] = [];
  const surface = buildBodySurface(bodySections);

  const positions: number[] = [];
  const indices: number[] = [];

  const centerT = eyes.height;
  const bodyRadius = Math.max((surface.rx(centerT) + surface.ry(centerT)) / 2, 0.5);
  const halfAngle = eyes.spacing / 2 / bodyRadius;

  for (const side of [-1, 1]) {
    const centerTheta = FRONT_THETA + side * halfAngle;
    const tiltRad = side * eyes.tilt * DEG2RAD; // 左右対称になるよう傾きの符号を反転
    appendLensShellOnSurface(
      surface,
      centerT,
      centerTheta,
      tiltRad,
      eyes.sizeX,
      eyes.sizeY,
      eyes.relief,
      FACE_EMBED_MM,
      positions,
      indices,
    );
  }

  fixOutwardWinding(positions, indices);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  return { geometry, warnings };
}

const MOUTH_SAMPLES = 16;

/** 口を生成する（開発指示書 6.4節）。2次ベジェで小さな上向きカーブを作る。 */
export function buildMouthMesh(
  mouth: MouthParams,
  bodySections: readonly BodySection[],
): FaceMeshResult {
  const warnings: string[] = [];
  const geometry = new THREE.BufferGeometry();

  if (mouth.preset === 'none') {
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    geometry.setIndex([]);
    return { geometry, warnings };
  }

  // TODO(6.4節): relief < 0（彫り込み）は Phase 1 では見た目のみとし、
  // 実際のジオメトリ凹みは作らない（ブーリアン減算は Phase 1.5）。
  const geometricRelief = Math.max(mouth.relief, 0);

  const surface = buildBodySurface(bodySections);
  const centerT = mouth.height;
  const centerTheta = FRONT_THETA;

  // curveHeight > 0 で中央が下がる「笑顔」のカーブになるよう、中央制御点は -y 側に置く
  // （ローカル座標の +y は本体の上方向＝顔の中では眉側にあたるため）。
  const p0 = new THREE.Vector2(-mouth.width / 2, 0);
  const p1 = new THREE.Vector2(0, -mouth.curveHeight);
  const p2 = new THREE.Vector2(mouth.width / 2, 0);

  function bezierPoint(s: number): THREE.Vector2 {
    const inv = 1 - s;
    return new THREE.Vector2(
      inv * inv * p0.x + 2 * inv * s * p1.x + s * s * p2.x,
      inv * inv * p0.y + 2 * inv * s * p1.y + s * s * p2.y,
    );
  }
  function bezierTangent(s: number): THREE.Vector2 {
    return new THREE.Vector2(
      2 * (1 - s) * (p1.x - p0.x) + 2 * s * (p2.x - p1.x),
      2 * (1 - s) * (p1.y - p0.y) + 2 * s * (p2.y - p1.y),
    ).normalize();
  }

  const grid: GridShellPoint[][] = [];
  for (let ui = 0; ui <= MOUTH_SAMPLES; ui++) {
    const s = ui / MOUTH_SAMPLES;
    const center2D = bezierPoint(s);
    const tangent = bezierTangent(s);
    const perp = new THREE.Vector2(-tangent.y, tangent.x);

    const row: GridShellPoint[] = [];
    for (const v of [-1, 1]) {
      const dx = center2D.x + v * (mouth.thickness / 2) * perp.x;
      const dy = center2D.y + v * (mouth.thickness / 2) * perp.y;
      const { t, theta } = tangentPlaneToSurface(surface, centerT, centerTheta, dx, dy);
      const p = surfacePointVec3(surface, t, theta);
      const n = surfaceNormalVec3(surface, t, theta);
      const outer = p.clone().addScaledVector(n, geometricRelief);
      const inner = p.clone().addScaledVector(n, -FACE_EMBED_MM);
      row.push({ outer, inner });
    }
    grid.push(row);
  }

  const positions: number[] = [];
  const indices: number[] = [];
  appendGridShell(grid, positions, indices);
  fixOutwardWinding(positions, indices);

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  return { geometry, warnings };
}
