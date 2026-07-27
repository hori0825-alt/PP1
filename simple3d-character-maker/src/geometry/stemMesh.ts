import * as THREE from 'three';
import type { BodySection, StemParams } from '../core/params';
import { buildBodySurface } from './surface';
import { fixOutwardWinding } from './meshUtils';

export interface StemMeshResult {
  geometry: THREE.BufferGeometry;
  warnings: string[];
}

const DEG2RAD = Math.PI / 180;
const RADIAL_SEGMENTS = 16;
const HEIGHT_SEGMENTS = 6;
const IRREGULARITY_MM = 0.15; // 上下面・側面のわずかな不均一さ

function orthonormalBasis(dir: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const helper = Math.abs(dir.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const e1 = new THREE.Vector3().crossVectors(helper, dir).normalize();
  const e2 = new THREE.Vector3().crossVectors(dir, e1).normalize();
  return [e1, e2];
}

// 印刷業者仕様確定値（13節 未決事項#2 回答済み）: 実寸1mm未満（半径0.5mm未満）は
// 折れやすく赤警告。黄警告のしきい値は printSettings.minStemRadiusMm で調整可能。
const CONFIRMED_MIN_RADIUS_MM = 0.5;

/**
 * 茎を生成する（開発指示書 6.3節）。
 * しずく型ではなく、断面に緩やかな歪みを持つ短い崩れた円柱として作る。
 * 下端はヘタ中央（本体の頂点）へ embed mm 埋め込む。
 */
export function buildStemMesh(
  stem: StemParams,
  bodySections: readonly BodySection[],
  minStemRadiusYellowMm = 0.75,
): StemMeshResult {
  const warnings: string[] = [];
  if (stem.radius < CONFIRMED_MIN_RADIUS_MM) {
    warnings.push(
      `茎の半径が印刷業者の確定最小値を下回り危険です（赤警告の目安 ${CONFIRMED_MIN_RADIUS_MM}mm 未満）: ${stem.radius.toFixed(2)}mm`,
    );
  } else if (stem.radius < minStemRadiusYellowMm) {
    warnings.push(
      `茎の半径が推奨最小値を下回っています（黄警告の目安 ${minStemRadiusYellowMm}mm 未満）: ${stem.radius.toFixed(2)}mm`,
    );
  }

  const surface = buildBodySurface(bodySections);
  const apex = new THREE.Vector3(surface.cx(1), surface.cy(1), surface.z(1));

  const tiltRad = stem.tilt * DEG2RAD;
  const dir = new THREE.Vector3(0, -Math.sin(tiltRad), Math.cos(tiltRad)).normalize();
  const [e1, e2] = orthonormalBasis(dir);

  const bottom = apex.clone().addScaledVector(dir, -stem.embed);

  const positions: number[] = [];
  const indices: number[] = [];

  const ringStart: number[] = [];
  for (let i = 0; i <= HEIGHT_SEGMENTS; i++) {
    const hFrac = i / HEIGHT_SEGMENTS;
    const center = bottom.clone().addScaledVector(dir, hFrac * stem.length);
    ringStart.push(positions.length / 3);
    for (let j = 0; j < RADIAL_SEGMENTS; j++) {
      const theta = (j / RADIAL_SEGMENTS) * Math.PI * 2;
      const phase = hFrac * 1.3;
      const rE1 =
        stem.radius * (1 - stem.squash) * (1 + stem.distortion * Math.sin(3 * theta + phase));
      const rE2 = stem.radius * (1 + stem.distortion * Math.sin(3 * theta + phase + 1.0));
      const bump = IRREGULARITY_MM * Math.cos(2 * theta + hFrac * 4.0);

      const p = center
        .clone()
        .addScaledVector(e1, rE1 * Math.cos(theta))
        .addScaledVector(e2, rE2 * Math.sin(theta))
        .addScaledVector(dir, bump);
      positions.push(p.x, p.y, p.z);
    }
  }

  for (let i = 0; i < HEIGHT_SEGMENTS; i++) {
    const startA = ringStart[i]!;
    const startB = ringStart[i + 1]!;
    for (let j = 0; j < RADIAL_SEGMENTS; j++) {
      const jn = (j + 1) % RADIAL_SEGMENTS;
      const a = startA + j;
      const b = startB + j;
      const c = startB + jn;
      const d = startA + jn;
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  // 下端キャップ（本体側。埋め込まれ隠れるがパーツ単体を閉じた立体にする）
  {
    const ring0 = ringStart[0]!;
    const centerIndex = positions.length / 3;
    positions.push(bottom.x, bottom.y, bottom.z);
    for (let j = 0; j < RADIAL_SEGMENTS; j++) {
      const jn = (j + 1) % RADIAL_SEGMENTS;
      indices.push(ring0 + j, ring0 + jn, centerIndex);
    }
  }

  // 上端キャップ（先端）
  {
    const ringTop = ringStart[HEIGHT_SEGMENTS]!;
    const tip = bottom.clone().addScaledVector(dir, stem.length);
    const centerIndex = positions.length / 3;
    positions.push(tip.x, tip.y, tip.z);
    for (let j = 0; j < RADIAL_SEGMENTS; j++) {
      const jn = (j + 1) % RADIAL_SEGMENTS;
      indices.push(ringTop + jn, ringTop + j, centerIndex);
    }
  }

  fixOutwardWinding(positions, indices);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  return { geometry, warnings };
}
