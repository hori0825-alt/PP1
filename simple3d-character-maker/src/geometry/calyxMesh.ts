import * as THREE from 'three';
import type { BodySection, CalyxParams } from '../core/params';
import { buildBodySurface } from './surface';
import { fixOutwardWinding } from './meshUtils';

export interface CalyxMeshResult {
  geometry: THREE.BufferGeometry;
  warnings: string[];
}

const DEG2RAD = Math.PI / 180;
const DOME_RINGS = 6;
const DOME_SEGMENTS = 64;
// 谷（裂片の間）でも盛り上がりを完全にゼロにはせず、土台の厚みを残す。
const VALLEY_HEIGHT_FRAC = 0.35;
// スカラップの尖り具合（1=正弦的な丸み、大きいほど山頂が平らで谷が鋭くなる）。
const LOBE_SHARPNESS = 1.15;

interface LeafAngle {
  angleRad: number; // 0..2π 昇順
  radius: number; // この裂片の先端までの半径 mm（中心軸から）
  height: number; // この裂片位置での盛り上がり高さ mm
  embed: number; // この裂片位置での埋め込み量 mm
}

/**
 * ヘタ（花冠）を生成する（開発指示書 6.2節）。
 * 参考画像のヘタは、個々の花びらが別々の丸い塊としてではなく、本体の首の上に
 * 載る「1枚の連続した、ふちが波打つ丸いキャップ」として見える。首よりも
 * はっきり外側まで張り出し（実測で首幅の約1.6倍）、外周が5箇所で丸く
 * 尖った星型（スカラップ）になっている。そこで、中心軸からの半径と盛り上がり
 * 高さの両方を方位角φの関数として連続的に変化させた、1枚のドーム状サーフェス
 * として生成する（裂片ごとに独立したボール状の盛り上がりにはしない）。
 * レイキャストは使わず本体表面関数を直接評価するため、本体の断面パラメータを
 * 変更すると自動的に追従する。
 */
export function buildCalyxMesh(
  calyx: CalyxParams,
  bodySections: readonly BodySection[],
): CalyxMeshResult {
  const warnings: string[] = [];
  const surface = buildBodySurface(bodySections);

  for (const leaf of calyx.leaves) {
    if (leaf.embed < 0.8) {
      warnings.push(`ヘタの埋め込み量が推奨範囲(0.8〜1.5mm)未満です: ${leaf.embed.toFixed(2)}mm`);
    }
  }

  const baseT = calyx.baseT;
  const centerAxis = new THREE.Vector3(surface.cx(baseT), surface.cy(baseT), surface.z(baseT));
  const neckRadius = Math.max((surface.rx(baseT) + surface.ry(baseT)) / 2, 1);

  // 裂片同士の谷（キャップの一番くびれた部分）の半径。首よりわずかに大きく
  // 保ち、裂片の張り出し量(length)の平均で少し広げる。
  const avgLength =
    calyx.leaves.reduce((sum, l) => sum + l.length, 0) / Math.max(calyx.leaves.length, 1);
  const valleyRadius = neckRadius * 1.15 + avgLength * 0.5;

  const avgThickness =
    calyx.leaves.reduce((sum, l) => sum + l.thickness, 0) / Math.max(calyx.leaves.length, 1);
  const avgEmbed =
    calyx.leaves.reduce((sum, l) => sum + l.embed, 0) / Math.max(calyx.leaves.length, 1);

  // 裂片を角度順に並べ、隣り合う裂片間を波型に補間するための配列を作る
  // （最後に先頭を +2π して周回を閉じる）。
  const sorted: LeafAngle[] = calyx.leaves
    .map((l) => ({
      angleRad: ((l.angle % 360) + 360) % 360 * DEG2RAD,
      radius: Math.max(l.width, valleyRadius + 0.5),
      height: l.thickness,
      embed: l.embed,
    }))
    .sort((a, b) => a.angleRad - b.angleRad);
  if (sorted.length > 0) {
    const first = sorted[0]!;
    sorted.push({ ...first, angleRad: first.angleRad + Math.PI * 2 });
  }

  function profileAt(phiRad: number): { radius: number; height: number; embed: number } {
    if (sorted.length <= 1) {
      return { radius: valleyRadius, height: avgThickness, embed: avgEmbed };
    }
    // phi を最初の裂片角度を基準に [0, 2π) の範囲へ正規化する
    let phi = phiRad;
    const base = sorted[0]!.angleRad;
    while (phi < base) phi += Math.PI * 2;
    while (phi >= base + Math.PI * 2) phi -= Math.PI * 2;

    let i = 0;
    while (i < sorted.length - 2 && sorted[i + 1]!.angleRad <= phi) i++;
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const span = Math.max(b.angleRad - a.angleRad, 1e-6);
    const frac = Math.min(Math.max((phi - a.angleRad) / span, 0), 1);

    // frac=0 と frac=1（各裂片の頂点）で1、frac=0.5（谷）で0になる丸い波形
    const shape = Math.pow(Math.abs(Math.cos(Math.PI * frac)), LOBE_SHARPNESS);
    const peakRadius = a.radius + (b.radius - a.radius) * frac;
    const peakHeight = a.height + (b.height - a.height) * frac;
    const peakEmbed = a.embed + (b.embed - a.embed) * frac;

    return {
      radius: valleyRadius + (peakRadius - valleyRadius) * shape,
      height: peakHeight * (VALLEY_HEIGHT_FRAC + (1 - VALLEY_HEIGHT_FRAC) * shape),
      embed: peakEmbed,
    };
  }

  const positions: number[] = [];
  const indices: number[] = [];

  const baseIndex = 0;
  const outerCount = 1 + DOME_RINGS * DOME_SEGMENTS;
  const outerIndex = (k: number, j: number): number =>
    k === 0 ? baseIndex : baseIndex + 1 + (k - 1) * DOME_SEGMENTS + (j % DOME_SEGMENTS);
  const innerBase = baseIndex + outerCount;
  const innerIndex = (k: number, j: number): number =>
    k === 0 ? innerBase : innerBase + 1 + (k - 1) * DOME_SEGMENTS + (j % DOME_SEGMENTS);

  const outerPts: THREE.Vector3[] = [];
  const innerPts: THREE.Vector3[] = [];

  // 中心（頂上）の1点：全方位で共有する山頂の高さは、全裂片の平均高さとする
  {
    const p = centerAxis.clone().add(new THREE.Vector3(0, 0, avgThickness));
    outerPts.push(p);
    innerPts.push(p.clone().add(new THREE.Vector3(0, 0, -avgEmbed)));
  }

  for (let k = 1; k <= DOME_RINGS; k++) {
    const rFrac = k / DOME_RINGS;
    for (let j = 0; j < DOME_SEGMENTS; j++) {
      const phiRad = (j / DOME_SEGMENTS) * Math.PI * 2;
      const { radius, height, embed } = profileAt(phiRad);
      const actualR = rFrac * radius;
      const z = height * Math.cos((rFrac * Math.PI) / 2);
      const p = centerAxis
        .clone()
        .add(new THREE.Vector3(actualR * Math.cos(phiRad), actualR * Math.sin(phiRad), z));
      outerPts.push(p);
      innerPts.push(p.clone().add(new THREE.Vector3(0, 0, -embed)));
    }
  }

  for (const p of outerPts) positions.push(p.x, p.y, p.z);
  for (const p of innerPts) positions.push(p.x, p.y, p.z);

  // 外側の面：中心からのファン + リング間のクアッド
  for (let j = 0; j < DOME_SEGMENTS; j++) {
    indices.push(outerIndex(0, 0), outerIndex(1, j), outerIndex(1, j + 1));
  }
  for (let k = 1; k < DOME_RINGS; k++) {
    for (let j = 0; j < DOME_SEGMENTS; j++) {
      const a = outerIndex(k, j);
      const b = outerIndex(k + 1, j);
      const c = outerIndex(k + 1, j + 1);
      const d = outerIndex(k, j + 1);
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  // 内側の面（裏面）：逆向きの巻き順
  for (let j = 0; j < DOME_SEGMENTS; j++) {
    indices.push(innerIndex(0, 0), innerIndex(1, j + 1), innerIndex(1, j));
  }
  for (let k = 1; k < DOME_RINGS; k++) {
    for (let j = 0; j < DOME_SEGMENTS; j++) {
      const a = innerIndex(k, j);
      const b = innerIndex(k + 1, j);
      const c = innerIndex(k + 1, j + 1);
      const d = innerIndex(k, j + 1);
      indices.push(a, d, b);
      indices.push(b, d, c);
    }
  }

  // 外周（最外リング）で外側と内側をつなぐ側壁
  for (let j = 0; j < DOME_SEGMENTS; j++) {
    const oa = outerIndex(DOME_RINGS, j);
    const ob = outerIndex(DOME_RINGS, j + 1);
    const ia = innerIndex(DOME_RINGS, j);
    const ib = innerIndex(DOME_RINGS, j + 1);
    indices.push(ob, oa, ia);
    indices.push(ob, ia, ib);
  }

  fixOutwardWinding(positions, indices);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  return { geometry, warnings };
}
