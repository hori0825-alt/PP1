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

  // 土台となる中央の丸いドーム（全裂片の谷を埋め、本体の首を覆うのに必要な
  // 最小限の半径だけ持たせる）。この半径をそのまま外周の下限にも使うことで、
  // 「高さが自然にゼロへ落ちる場所」と「輪郭の下限」を一致させ、谷に
  // 高さゼロの平らな縁（見た目上のツバ）ができてしまうのを防ぐ。
  const cupRadius = neckRadius * 1.1 + avgLength * 0.15;
  const cupHeight = avgThickness * 0.45;
  const cup: Bump = { cx: 0, cy: 0, radius: cupRadius, height: cupHeight };

  // 各裂片ドーム：中心をwidthの55%の距離に置き、ドーム自身の半径は残り45%に
  // 抑える。中心からの距離と半径を同じ(50%ずつ)にすると、盛り上がりの
  // なだらかな裾野が中心近くから輪郭いっぱいまで間延びして広がってしまい、
  // 「本体に貼り付いた平らなツバ」のように見えてしまう。半径を控えめにして
  // ドーム自身は輪郭付近に留めることで、丸くコロンと盛り上がった裂片に近い
  // シルエットになる（中心寄りの隙間はcupが埋める）。
  const bumps: Bump[] = calyx.leaves.map((leaf) => {
    const angleRad = leaf.angle * DEG2RAD;
    const reach = Math.max(leaf.width, 1);
    const bumpRadius = reach * 0.45;
    const petalCenterDist = reach - bumpRadius;
    return {
      cx: petalCenterDist * Math.cos(angleRad),
      cy: petalCenterDist * Math.sin(angleRad),
      radius: bumpRadius,
      height: leaf.thickness,
    };
  });

  function heightAt(x: number, y: number): number {
    let h = bumpHeightAt(cup, x, y);
    for (const b of bumps) h = Math.max(h, bumpHeightAt(b, x, y));
    return h;
  }

  // 外周（輪郭）は「cupとすべての裂片ドームのうち、その方位角で実際に
  // 届く最大距離」として求める。cupの半径そのものを下限にすることで、
  // 高さがゼロになる場所と輪郭の下限が必ず一致し、平らな縁ができない。
  function outerRadiusAt(phiRad: number): number {
    let r = cupRadius;
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
