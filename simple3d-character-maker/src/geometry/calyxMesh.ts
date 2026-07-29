import * as THREE from 'three';
import type { BodySection, CalyxParams } from '../core/params';
import { buildBodySurface } from './surface';
import { fixOutwardWinding } from './meshUtils';

export interface CalyxMeshResult {
  geometry: THREE.BufferGeometry;
  warnings: string[];
}

const DEG2RAD = Math.PI / 180;
const DOME_RINGS = 8;
const DOME_SEGMENTS = 64;

interface Bump {
  cx: number; // 中心軸からの相対XY位置 mm
  cy: number;
  radius: number; // このドームの半径 mm（この範囲外では寄与ゼロ）
  height: number; // このドーム自身の中心での盛り上がり高さ mm
}

/** ある(x,y)地点での1つのドーム（cos形状）の寄与高さ。範囲外なら0。 */
function bumpHeightAt(bump: Bump, x: number, y: number): number {
  const d = Math.hypot(x - bump.cx, y - bump.cy);
  if (d >= bump.radius) return 0;
  return bump.height * Math.cos(((d / bump.radius) * Math.PI) / 2);
}

/**
 * 中心軸から角度phiの方向へ光線を伸ばしたとき、そのドームの外周円との
 * 交点までの距離（=その方向にドームが届く最大半径）。届かなければ null。
 */
function bumpReachAtAngle(bump: Bump, phiRad: number): number | null {
  const dirX = Math.cos(phiRad);
  const dirY = Math.sin(phiRad);
  const centerDist = Math.hypot(bump.cx, bump.cy);
  const d = bump.cx * dirX + bump.cy * dirY; // 中心からの射影距離
  const perp2 = centerDist * centerDist - d * d; // 光線からドーム中心までの垂直距離の2乗
  const disc = bump.radius * bump.radius - perp2;
  if (disc < 0) return null;
  const reach = d + Math.sqrt(disc);
  return reach > 0 ? reach : null;
}

/**
 * ヘタ（花冠）を生成する（開発指示書 6.2節）。
 * 参考画像のヘタは、正面から見ても5枚の裂片それぞれが個別の丸い盛り上がりの
 * 頂点を持ち、裂片の間で高さが沈み込む「波打つ」輪郭になっている。中心1点だけを
 * 頂上とする円錐状のドームでは、方位角によらず常に中心が最高点になるため、
 * 正面から見ると滑らかな円錐にしか見えず、この波打ちを再現できない。
 * そこで、土台となる中央の丸いドーム（cup）と、裂片ごとに中心が異なる
 * 独立したドーム（bump、各裂片自身の位置で最大高さになる）を用意し、
 * 各点での高さを「その点でのすべてのドーム寄与の最大値」として合成する
 * （金属球状のブレンドと同様の考え方）。外周の輪郭（半径）も、各裂片ドームが
 * 実際に届く範囲から幾何学的に導出するため、裂片同士は必ず滑らかに融合し、
 * 谷に本体が露出する隙間はできない。
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

  const avgLength =
    calyx.leaves.reduce((sum, l) => sum + l.length, 0) / Math.max(calyx.leaves.length, 1);
  const avgThickness =
    calyx.leaves.reduce((sum, l) => sum + l.thickness, 0) / Math.max(calyx.leaves.length, 1);
  const avgEmbed =
    calyx.leaves.reduce((sum, l) => sum + l.embed, 0) / Math.max(calyx.leaves.length, 1);

  // 土台となる中央の丸いドーム（全裂片の谷を埋め、キャップ全体の下地の厚みになる）。
  const cupRadius = neckRadius * 1.15 + avgLength * 0.5;
  const cupHeight = avgThickness * 0.45;
  const cup: Bump = { cx: 0, cy: 0, radius: cupRadius, height: cupHeight };

  // 各裂片ドーム：中心軸からの距離と半径をどちらも width の半分にする
  // （＝ドームの円が必ず中心軸を通る）ことで、(1) 裂片の先端までの距離が
  // ちょうど width になり、(2) 隣接する裂片・中央cupの両方と確実に重なって
  // 谷に本体が露出する隙間ができない、という2条件を単純な式だけで満たす。
  const bumps: Bump[] = calyx.leaves.map((leaf) => {
    const angleRad = leaf.angle * DEG2RAD;
    const petalCenterDist = Math.max(leaf.width, 1) * 0.5;
    return {
      cx: petalCenterDist * Math.cos(angleRad),
      cy: petalCenterDist * Math.sin(angleRad),
      radius: petalCenterDist,
      height: leaf.thickness,
    };
  });

  function heightAt(x: number, y: number): number {
    let h = bumpHeightAt(cup, x, y);
    for (const b of bumps) h = Math.max(h, bumpHeightAt(b, x, y));
    return h;
  }

  // 外周（輪郭）はcupRadius全体ではなく、本体の首を覆うのに必要な最小半径
  // だけを下限にする。cupRadiusをそのまま下限にすると谷でも常にcupRadius
  // まで広がってしまい、星形のスカラップがほとんど見えなくなる。
  const minRimRadius = neckRadius * 1.1;

  function outerRadiusAt(phiRad: number): number {
    let r = minRimRadius;
    for (const b of bumps) {
      const reach = bumpReachAtAngle(b, phiRad);
      if (reach !== null && reach > r) r = reach;
    }
    return r;
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

  // 中心の1点（すべての裂片から離れているため、cup自身の中心高さになる）
  {
    const p = centerAxis.clone().add(new THREE.Vector3(0, 0, heightAt(0, 0)));
    outerPts.push(p);
    innerPts.push(p.clone().add(new THREE.Vector3(0, 0, -avgEmbed)));
  }

  for (let k = 1; k <= DOME_RINGS; k++) {
    const rFrac = k / DOME_RINGS;
    for (let j = 0; j < DOME_SEGMENTS; j++) {
      const phiRad = (j / DOME_SEGMENTS) * Math.PI * 2;
      const outerR = outerRadiusAt(phiRad);
      const actualR = rFrac * outerR;
      const x = actualR * Math.cos(phiRad);
      const y = actualR * Math.sin(phiRad);
      const z = heightAt(x, y);
      const p = centerAxis.clone().add(new THREE.Vector3(x, y, z));
      outerPts.push(p);
      innerPts.push(p.clone().add(new THREE.Vector3(0, 0, -avgEmbed)));
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
