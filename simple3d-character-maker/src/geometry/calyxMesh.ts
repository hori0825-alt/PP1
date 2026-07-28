import * as THREE from 'three';
import type { BodySection, CalyxParams } from '../core/params';
import { buildBodySurface } from './surface';
import { fixOutwardWinding } from './meshUtils';

export interface CalyxMeshResult {
  geometry: THREE.BufferGeometry;
  warnings: string[];
}

const DEG2RAD = Math.PI / 180;
const DOME_RINGS = 5;
const DOME_SEGMENTS = 20;

/**
 * ワールド空間の任意の点を中心にした、丸いドーム状の盛り上がり（花びら1枚や
 * 中央の土台に使う）を positions/indices へ追加する。本体表面には縛られず、
 * 独立した閉じた立体として生成する（本体との位置関係は呼び出し側が center で
 * 指定する）。
 */
function appendWorldDome(
  center: THREE.Vector3,
  radius: number,
  height: number,
  embedDepth: number,
  positions: number[],
  indices: number[],
): void {
  const baseIndex = positions.length / 3;
  const outerCount = 1 + DOME_RINGS * DOME_SEGMENTS;
  const outerIndex = (k: number, j: number): number =>
    k === 0 ? baseIndex : baseIndex + 1 + (k - 1) * DOME_SEGMENTS + (j % DOME_SEGMENTS);
  const innerBase = baseIndex + outerCount;
  const innerIndex = (k: number, j: number): number =>
    k === 0 ? innerBase : innerBase + 1 + (k - 1) * DOME_SEGMENTS + (j % DOME_SEGMENTS);

  function surfacePoint(rFrac: number, phiRad: number): THREE.Vector3 {
    const actualR = rFrac * radius;
    const z = height * Math.cos((rFrac * Math.PI) / 2); // 中心で height、外周で0
    return center.clone().add(new THREE.Vector3(actualR * Math.cos(phiRad), actualR * Math.sin(phiRad), z));
  }

  const outerPts: THREE.Vector3[] = [];
  const innerPts: THREE.Vector3[] = [];
  {
    const p = surfacePoint(0, 0);
    outerPts.push(p);
    innerPts.push(p.clone().addScaledVector(new THREE.Vector3(0, 0, 1), -embedDepth));
  }
  for (let k = 1; k <= DOME_RINGS; k++) {
    const rFrac = k / DOME_RINGS;
    for (let j = 0; j < DOME_SEGMENTS; j++) {
      const phiRad = (j / DOME_SEGMENTS) * Math.PI * 2;
      const p = surfacePoint(rFrac, phiRad);
      outerPts.push(p);
      innerPts.push(p.clone().addScaledVector(new THREE.Vector3(0, 0, 1), -embedDepth));
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
}

/**
 * ヘタ（花冠）を生成する（開発指示書 6.2節）。
 * 参考画像は、個々の花びらが本体表面に薄く貼り付いた形ではなく、それぞれが
 * 丸みのある独立した盛り上がり（コロンとした裂片）として、本体の首の実際の
 * 半径より外側まではっきり張り出して見える。そのため本体上の1点（首の中心軸）
 * を基準に、（1）土台となる小さな丸いドームと、（2）各裂片(leaf)ごとに
 * 独立した丸いドーム状の盛り上がりを、少し重なり合うよう配置して合成する
 * （ブーリアン結合はせず、この方式では重なりを許容する）。
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
  const valleyRadius = neckRadius + 0.5;
  const avgThickness =
    calyx.leaves.reduce((sum, l) => sum + l.thickness, 0) / Math.max(calyx.leaves.length, 1);
  const avgEmbed =
    calyx.leaves.reduce((sum, l) => sum + l.embed, 0) / Math.max(calyx.leaves.length, 1);

  const positions: number[] = [];
  const indices: number[] = [];

  // 隣り合う裂片どうしが確実に重なり合うよう、裂片の等角度間隔（想定）から
  // 必要な半径を逆算する。裂片同士が重ならないと谷の部分に本体が
  // 露出した隙間ができてしまうため、少し余裕(15%)を持たせて重ねる。
  const leafCount = Math.max(calyx.leaves.length, 1);
  const angleStepRad = (2 * Math.PI) / leafCount;

  // 土台（裂片どうしの谷を埋める丸い台座）。裂片の中心距離まで届かせておくことで、
  // 裂片の盛り上がりが浅い部分でも本体が露出しないようにする。
  const avgLength =
    calyx.leaves.reduce((sum, l) => sum + l.length, 0) / Math.max(calyx.leaves.length, 1);
  const cupRadius = valleyRadius + avgLength * 0.5;
  appendWorldDome(centerAxis, cupRadius, avgThickness * 0.5, avgEmbed, positions, indices);

  // 各裂片：首の外側に少しずつ間隔を空けて配置した、丸い盛り上がり
  for (const leaf of calyx.leaves) {
    const angleRad = leaf.angle * DEG2RAD;
    const petalCenterDist = valleyRadius + leaf.length * 0.5;
    const petalCenter = centerAxis
      .clone()
      .add(
        new THREE.Vector3(
          petalCenterDist * Math.cos(angleRad),
          petalCenterDist * Math.sin(angleRad),
          0,
        ),
      );
    // width は裂片の見た目の大きさ(半径mm)を直接指定する。ただし隣の裂片との
    // 間に隙間ができないよう、等角度間隔から逆算した最小半径を下回らせない。
    const minOverlapRadius = petalCenterDist * Math.sin(angleStepRad / 2) * 1.15;
    const petalRadius = Math.max(leaf.width, minOverlapRadius, 1);
    appendWorldDome(petalCenter, petalRadius, leaf.thickness, leaf.embed, positions, indices);
  }

  fixOutwardWinding(positions, indices);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  return { geometry, warnings };
}
