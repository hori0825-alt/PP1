import * as THREE from 'three';
import type { BodySection, CalyxLeaf, CalyxParams } from '../core/params';
import { buildBodySurface } from './surface';
import { fixOutwardWinding } from './meshUtils';

export interface CalyxMeshResult {
  geometry: THREE.BufferGeometry;
  warnings: string[];
}

const DEG2RAD = Math.PI / 180;
const RADIAL_RINGS = 6;
const ANGULAR_SEGMENTS = 40;

/** 角度差を -180..180 度の範囲に正規化する（周期境界をまたぐ距離計算用）。 */
function angleDiffDeg(a: number, b: number): number {
  let d = ((a - b + 180) % 360) - 180;
  if (d < -180) d += 360;
  return d;
}

/**
 * 各裂片(leaf)が、自分の中心角度から離れるほど滑らかに0へ減衰する
 * 「盛り上がり」を outward 半径へ加算する。裂片どうしの影響が重なり合うことで、
 * 隣接する盛り上がりが連続的につながったスカラップ形状になる。
 */
function outwardBumpMm(phiDeg: number, leaves: readonly CalyxLeaf[]): number {
  let bump = 0;
  for (const leaf of leaves) {
    const halfWidthDeg = Math.max(leaf.width, 1);
    const d = Math.abs(angleDiffDeg(phiDeg, leaf.angle));
    if (d >= halfWidthDeg) continue;
    const shape = Math.cos((d / halfWidthDeg) * (Math.PI / 2)) ** 2;
    bump += leaf.length * shape;
  }
  return bump;
}

/**
 * ヘタ（花冠）を生成する（開発指示書 6.2節）。
 * 参考画像を計測すると、ヘタは本体の首の実際の半径よりも明らかに外側へ
 * 張り出した、丸みのある連続したスカラップ状のドームになっている。
 * 個々の花びらを本体表面 S(t, θ) 上の別パーツとして置くと本体自身の半径で
 * 頭打ちになり張り出しを表現できないため、本体上の1点（首の中心軸）を
 * 基準にしたワールド空間の平坦な円形ドームとして生成し、外周半径を
 * 各裂片(leaf)の角度・幅・張り出し量の合成で変調してスカラップを作る。
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
  // 谷（裂片と裂片の間のくびれ）は首の実半径に少し余裕を持たせた値にする。
  const valleyRadius = neckRadius + 0.8;
  const avgThickness =
    calyx.leaves.reduce((sum, l) => sum + l.thickness, 0) / Math.max(calyx.leaves.length, 1);
  const avgEmbed =
    calyx.leaves.reduce((sum, l) => sum + l.embed, 0) / Math.max(calyx.leaves.length, 1);

  const xDir = new THREE.Vector3(1, 0, 0);
  const yDir = new THREE.Vector3(0, 1, 0);
  const zDir = new THREE.Vector3(0, 0, 1);

  function edgeRadiusAt(phiDeg: number): number {
    return valleyRadius + outwardBumpMm(phiDeg, calyx.leaves);
  }

  function domeSurfacePoint(rFrac: number, phiDeg: number): { pos: THREE.Vector3; height: number } {
    const phiRad = phiDeg * DEG2RAD;
    const edgeR = edgeRadiusAt(phiDeg);
    const actualR = rFrac * edgeR;
    const domeProfile = Math.cos((rFrac * Math.PI) / 2); // 中心で1、外周で0
    const height = domeProfile * avgThickness;
    const pos = centerAxis
      .clone()
      .addScaledVector(xDir, actualR * Math.cos(phiRad))
      .addScaledVector(yDir, actualR * Math.sin(phiRad))
      .addScaledVector(zDir, height);
    return { pos, height };
  }

  const outerCount = 1 + RADIAL_RINGS * ANGULAR_SEGMENTS;
  const outerIndex = (k: number, j: number): number =>
    k === 0 ? 0 : 1 + (k - 1) * ANGULAR_SEGMENTS + (j % ANGULAR_SEGMENTS);
  const innerBase = outerCount;
  const innerIndex = (k: number, j: number): number =>
    k === 0 ? innerBase : innerBase + 1 + (k - 1) * ANGULAR_SEGMENTS + (j % ANGULAR_SEGMENTS);

  const outerPts: THREE.Vector3[] = [];
  const innerPts: THREE.Vector3[] = [];

  // 中心点（k=0）
  {
    const { pos } = domeSurfacePoint(0, 0);
    outerPts.push(pos);
    innerPts.push(pos.clone().addScaledVector(zDir, -avgEmbed));
  }
  for (let k = 1; k <= RADIAL_RINGS; k++) {
    const rFrac = k / RADIAL_RINGS;
    for (let j = 0; j < ANGULAR_SEGMENTS; j++) {
      const phiDeg = (j / ANGULAR_SEGMENTS) * 360;
      const { pos } = domeSurfacePoint(rFrac, phiDeg);
      outerPts.push(pos);
      // 外周に近づくほど薄くなりすぎないよう、埋め込みは常に一定の深さを保つ
      // （本体表面の曲率にかかわらず確実に食い込ませ、隙間を作らないため）。
      innerPts.push(pos.clone().addScaledVector(zDir, -avgEmbed));
    }
  }

  const positions: number[] = [];
  const indices: number[] = [];
  for (const p of outerPts) positions.push(p.x, p.y, p.z);
  for (const p of innerPts) positions.push(p.x, p.y, p.z);

  // 外側の面：中心からのファン + リング間のクアッド
  for (let j = 0; j < ANGULAR_SEGMENTS; j++) {
    indices.push(outerIndex(0, 0), outerIndex(1, j), outerIndex(1, j + 1));
  }
  for (let k = 1; k < RADIAL_RINGS; k++) {
    for (let j = 0; j < ANGULAR_SEGMENTS; j++) {
      const a = outerIndex(k, j);
      const b = outerIndex(k + 1, j);
      const c = outerIndex(k + 1, j + 1);
      const d = outerIndex(k, j + 1);
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  // 内側の面（裏面）：逆向きの巻き順
  for (let j = 0; j < ANGULAR_SEGMENTS; j++) {
    indices.push(innerIndex(0, 0), innerIndex(1, j + 1), innerIndex(1, j));
  }
  for (let k = 1; k < RADIAL_RINGS; k++) {
    for (let j = 0; j < ANGULAR_SEGMENTS; j++) {
      const a = innerIndex(k, j);
      const b = innerIndex(k + 1, j);
      const c = innerIndex(k + 1, j + 1);
      const d = innerIndex(k, j + 1);
      indices.push(a, d, b);
      indices.push(b, d, c);
    }
  }

  // 外周（最外リング）で外側と内側をつなぐ側壁
  for (let j = 0; j < ANGULAR_SEGMENTS; j++) {
    const oa = outerIndex(RADIAL_RINGS, j);
    const ob = outerIndex(RADIAL_RINGS, j + 1);
    const ia = innerIndex(RADIAL_RINGS, j);
    const ib = innerIndex(RADIAL_RINGS, j + 1);
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
