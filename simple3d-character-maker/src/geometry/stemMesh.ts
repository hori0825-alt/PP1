import * as THREE from 'three';
import type { BodySection, StemParams } from '../core/params';
import { buildBodySurface } from './surface';
import { buildTaperedCylinder, fixOutwardWinding } from './meshUtils';

export interface StemMeshResult {
  geometry: THREE.BufferGeometry;
  warnings: string[];
}

const DEG2RAD = Math.PI / 180;
const RADIAL_SEGMENTS = 16;
const HEIGHT_SEGMENTS = 6;
const IRREGULARITY_MM = 0.15; // 上下面・側面のわずかな不均一さ

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

  // 参考画像の茎はまっすぐな棒ではなく、根元からやや起き上がり先端に向けて
  // 一方向へ丸くカーブする「コンマ」状の形をしている。2段のテーパー円柱を
  // 繋いで折れ線近似することで、そのカーブを再現する（牛のしっぽと同じ手法）。
  const tiltRad = stem.tilt * DEG2RAD;
  const dir1 = new THREE.Vector3(Math.sin(tiltRad), 0, Math.cos(tiltRad));
  const dir2 = new THREE.Vector3(
    Math.sin(tiltRad + 42 * DEG2RAD),
    0,
    Math.cos(tiltRad + 42 * DEG2RAD),
  );

  const seg1Length = stem.length * 0.55;
  const seg2Length = stem.length * 0.45;
  const jointRadius = stem.radius * 0.8;
  const tipRadius = stem.radius * 0.5;

  const seg1 = buildTaperedCylinder({
    origin: apex,
    direction: dir1,
    length: seg1Length,
    radiusStart: stem.radius,
    radiusEnd: jointRadius,
    embed: stem.embed,
    squash: stem.squash,
    distortion: stem.distortion,
    irregularityMm: IRREGULARITY_MM,
    radialSegments: RADIAL_SEGMENTS,
    heightSegments: Math.ceil(HEIGHT_SEGMENTS / 2),
  });
  fixOutwardWinding(seg1.positions, seg1.indices);

  const jointWorld = apex.clone().addScaledVector(dir1, seg1Length);
  const seg2 = buildTaperedCylinder({
    origin: jointWorld,
    direction: dir2,
    length: seg2Length,
    radiusStart: jointRadius,
    radiusEnd: tipRadius,
    embed: jointRadius, // 関節が途切れて見えないよう前セグメントへ食い込ませる
    squash: stem.squash,
    distortion: stem.distortion,
    irregularityMm: IRREGULARITY_MM,
    radialSegments: RADIAL_SEGMENTS,
    heightSegments: Math.ceil(HEIGHT_SEGMENTS / 2),
  });
  fixOutwardWinding(seg2.positions, seg2.indices);

  const positions: number[] = [];
  const indices: number[] = [];
  for (const seg of [seg1, seg2]) {
    const offset = positions.length / 3;
    positions.push(...seg.positions);
    indices.push(...seg.indices.map((i) => i + offset));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  return { geometry, warnings };
}
