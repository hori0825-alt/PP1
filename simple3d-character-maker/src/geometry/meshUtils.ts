import * as THREE from 'three';
import type { BodySurface } from './surface';

/** メッシュ生成で共通に使う小さなユーティリティ。 */

/**
 * 本体表面上の接平面における局所オフセット (dx, dy) を、本体表面パラメータ (t, θ) へ
 * 近似変換する。dx は θ 方向（水平）、dy は t 方向（鉛直）に対応する。
 * 小さな付着パーツ（目・耳・角・斑点など）の配置にのみ使う近似であり、
 * S(t, θ) 自体の定義は変えない。
 */
export function tangentPlaneToSurface(
  surface: BodySurface,
  centerT: number,
  centerTheta: number,
  dx: number,
  dy: number,
): { t: number; theta: number } {
  const bodyRadius = Math.max((surface.rx(centerT) + surface.ry(centerT)) / 2, 0.5);
  const eps = 1e-4;
  const dzdtRaw =
    (surface.z(Math.min(centerT + eps, 1)) - surface.z(Math.max(centerT - eps, 0))) / (2 * eps);
  const dzdt = Math.abs(dzdtRaw) > 1e-3 ? dzdtRaw : 1;

  const theta = centerTheta + dx / bodyRadius;
  const t = Math.min(Math.max(centerT + dy / dzdt, 0), 1);
  return { t, theta };
}

export function surfacePointVec3(surface: BodySurface, t: number, theta: number): THREE.Vector3 {
  const p = surface.point(t, theta);
  return new THREE.Vector3(p.x, p.y, p.z);
}

export function surfaceNormalVec3(surface: BodySurface, t: number, theta: number): THREE.Vector3 {
  const n = surface.normal(t, theta);
  return new THREE.Vector3(n.x, n.y, n.z);
}

const LENS_RINGS = 5;
const LENS_SEGMENTS = 16;

/**
 * 本体表面上に、平面内で丸く盛り上がる薄いレンズ状の立体（コイン形状）を追加する。
 * 目・耳・角の付け根・斑点など、表面に貼り付く円形〜楕円形のパーツで共用する。
 */
export function appendLensShellOnSurface(
  surface: BodySurface,
  centerT: number,
  centerTheta: number,
  tiltRad: number,
  sizeX: number,
  sizeY: number,
  relief: number,
  embedMm: number,
  positions: number[],
  indices: number[],
): void {
  const baseIndex = positions.length / 3;
  const outerCount = 1 + LENS_RINGS * LENS_SEGMENTS;

  const outerIndex = (k: number, j: number): number =>
    k === 0 ? baseIndex : baseIndex + 1 + (k - 1) * LENS_SEGMENTS + (j % LENS_SEGMENTS);
  const innerBase = baseIndex + outerCount;
  const innerIndex = (k: number, j: number): number =>
    k === 0 ? innerBase : innerBase + 1 + (k - 1) * LENS_SEGMENTS + (j % LENS_SEGMENTS);

  const outerPts: THREE.Vector3[] = [];
  const innerPts: THREE.Vector3[] = [];

  function computePoint(r: number, phi: number): { outer: THREE.Vector3; inner: THREE.Vector3 } {
    const localX = sizeX * r * Math.cos(phi);
    const localY = sizeY * r * Math.sin(phi);
    const dx = localX * Math.cos(tiltRad) - localY * Math.sin(tiltRad);
    const dy = localX * Math.sin(tiltRad) + localY * Math.cos(tiltRad);
    const { t, theta } = tangentPlaneToSurface(surface, centerT, centerTheta, dx, dy);
    const p = surfacePointVec3(surface, t, theta);
    const n = surfaceNormalVec3(surface, t, theta);
    return {
      outer: p.clone().addScaledVector(n, relief),
      inner: p.clone().addScaledVector(n, -embedMm),
    };
  }

  const center = computePoint(0, 0);
  outerPts.push(center.outer);
  innerPts.push(center.inner);
  for (let k = 1; k <= LENS_RINGS; k++) {
    const r = k / LENS_RINGS;
    for (let j = 0; j < LENS_SEGMENTS; j++) {
      const phi = (j / LENS_SEGMENTS) * Math.PI * 2;
      const pt = computePoint(r, phi);
      outerPts.push(pt.outer);
      innerPts.push(pt.inner);
    }
  }

  for (const p of outerPts) positions.push(p.x, p.y, p.z);
  for (const p of innerPts) positions.push(p.x, p.y, p.z);

  // outer 面：中心からのファン + リング間のクアッド
  for (let j = 0; j < LENS_SEGMENTS; j++) {
    indices.push(outerIndex(0, 0), outerIndex(1, j), outerIndex(1, j + 1));
  }
  for (let k = 1; k < LENS_RINGS; k++) {
    for (let j = 0; j < LENS_SEGMENTS; j++) {
      const a = outerIndex(k, j);
      const b = outerIndex(k + 1, j);
      const c = outerIndex(k + 1, j + 1);
      const d = outerIndex(k, j + 1);
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  // inner 面：逆向きの巻き順
  for (let j = 0; j < LENS_SEGMENTS; j++) {
    indices.push(innerIndex(0, 0), innerIndex(1, j + 1), innerIndex(1, j));
  }
  for (let k = 1; k < LENS_RINGS; k++) {
    for (let j = 0; j < LENS_SEGMENTS; j++) {
      const a = innerIndex(k, j);
      const b = innerIndex(k + 1, j);
      const c = innerIndex(k + 1, j + 1);
      const d = innerIndex(k, j + 1);
      indices.push(a, d, b);
      indices.push(b, d, c);
    }
  }

  // 外周（最外リング）で outer と inner をつなぐ側壁
  for (let j = 0; j < LENS_SEGMENTS; j++) {
    const oa = outerIndex(LENS_RINGS, j);
    const ob = outerIndex(LENS_RINGS, j + 1);
    const ia = innerIndex(LENS_RINGS, j);
    const ib = innerIndex(LENS_RINGS, j + 1);
    indices.push(ob, oa, ia);
    indices.push(ob, ia, ib);
  }
}

export interface GridShellPoint {
  outer: THREE.Vector3;
  inner: THREE.Vector3;
}

/**
 * 矩形 (u, v) グリッド状の薄いシェル（表面 outer + 裏面 inner + 周囲の側壁）を
 * ウォータータイトな閉じた立体として positions/indices に追加する。
 * ヘタの葉・口のリボンなど、本体表面に貼り付く薄い部品で共通に使う。
 */
export function appendGridShell(
  grid: GridShellPoint[][],
  positions: number[],
  indices: number[],
): void {
  const uCount = grid.length;
  const vCount = grid[0]!.length;
  const baseIndex = positions.length / 3;

  const outerIndex = (ui: number, vi: number): number => baseIndex + ui * vCount + vi;
  const innerIndex = (ui: number, vi: number): number =>
    baseIndex + uCount * vCount + ui * vCount + vi;

  for (const row of grid) {
    for (const point of row) {
      positions.push(point.outer.x, point.outer.y, point.outer.z);
    }
  }
  for (const row of grid) {
    for (const point of row) {
      positions.push(point.inner.x, point.inner.y, point.inner.z);
    }
  }

  // 表面（outer）
  for (let ui = 0; ui < uCount - 1; ui++) {
    for (let vi = 0; vi < vCount - 1; vi++) {
      const a = outerIndex(ui, vi);
      const b = outerIndex(ui + 1, vi);
      const c = outerIndex(ui + 1, vi + 1);
      const d = outerIndex(ui, vi + 1);
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  // 裏面（inner）：outer と逆向きの巻き順にする
  for (let ui = 0; ui < uCount - 1; ui++) {
    for (let vi = 0; vi < vCount - 1; vi++) {
      const a = innerIndex(ui, vi);
      const b = innerIndex(ui + 1, vi);
      const c = innerIndex(ui + 1, vi + 1);
      const d = innerIndex(ui, vi + 1);
      indices.push(a, d, b);
      indices.push(b, d, c);
    }
  }

  // 周囲を一周する境界ループ（outer と inner をつなぐ側壁）。
  // 各コーナーがちょうど1回だけ現れるよう、区間の終端を重複させない。
  const boundary: Array<[number, number]> = [];
  for (let ui = 0; ui < uCount; ui++) boundary.push([ui, 0]);
  for (let vi = 1; vi < vCount; vi++) boundary.push([uCount - 1, vi]);
  for (let ui = uCount - 2; ui >= 0; ui--) boundary.push([ui, vCount - 1]);
  for (let vi = vCount - 2; vi >= 1; vi--) boundary.push([0, vi]);

  for (let i = 0; i < boundary.length; i++) {
    const [u0, v0] = boundary[i]!;
    const [u1, v1] = boundary[(i + 1) % boundary.length]!;
    const oa = outerIndex(u0, v0);
    const ob = outerIndex(u1, v1);
    const ia = innerIndex(u0, v0);
    const ib = innerIndex(u1, v1);
    indices.push(ob, oa, ia);
    indices.push(ob, ia, ib);
  }
}

function signedVolume(positions: number[], indices: number[]): number {
  let vol = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i]! * 3;
    const ib = indices[i + 1]! * 3;
    const ic = indices[i + 2]! * 3;
    const ax = positions[ia]!;
    const ay = positions[ia + 1]!;
    const az = positions[ia + 2]!;
    const bx = positions[ib]!;
    const by = positions[ib + 1]!;
    const bz = positions[ib + 2]!;
    const cxp = positions[ic]!;
    const cyp = positions[ic + 1]!;
    const czp = positions[ic + 2]!;
    vol += ax * (by * czp - bz * cyp) - ay * (bx * czp - bz * cxp) + az * (bx * cyp - by * cxp);
  }
  return vol / 6;
}

function reverseWinding(indices: number[]): void {
  for (let i = 0; i < indices.length; i += 3) {
    const tmp = indices[i + 1]!;
    indices[i + 1] = indices[i + 2]!;
    indices[i + 2] = tmp;
  }
}

/**
 * 閉じた（ウォータータイトな）メッシュを想定し、符号付き体積を検査して
 * 全体が外向き法線になるよう必要なら巻き順を反転する。
 */
export function fixOutwardWinding(positions: number[], indices: number[]): void {
  if (signedVolume(positions, indices) < 0) {
    reverseWinding(indices);
  }
}

export interface TaperedCylinderParams {
  /** 付け根（embed 適用前）の位置。 */
  origin: THREE.Vector3;
  /** 伸びる方向（内部で正規化する）。 */
  direction: THREE.Vector3;
  length: number;
  radiusStart: number;
  radiusEnd: number;
  /** 付け根側をこの分だけ direction と逆向きに埋め込む。 */
  embed: number;
  squash?: number;
  distortion?: number;
  /** 側面のわずかな不均一さ（mm）。0 で無効。 */
  irregularityMm?: number;
  radialSegments?: number;
  heightSegments?: number;
}

function orthonormalBasis(dir: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const helper = Math.abs(dir.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const e1 = new THREE.Vector3().crossVectors(helper, dir).normalize();
  const e2 = new THREE.Vector3().crossVectors(dir, e1).normalize();
  return [e1, e2];
}

/**
 * 先細り可能な、断面にわずかな歪みを持つ円柱（脚・角・しっぽ・茎などで共用）。
 * 付け根は embed だけ逆向きに埋め込まれ、両端は点に閉じてウォータータイトにする。
 */
export function buildTaperedCylinder(params: TaperedCylinderParams): {
  positions: number[];
  indices: number[];
} {
  const {
    origin,
    direction,
    length,
    radiusStart,
    radiusEnd,
    embed,
    squash = 0,
    distortion = 0,
    irregularityMm = 0,
    radialSegments = 16,
    heightSegments = 6,
  } = params;

  const dir = direction.clone().normalize();
  const [e1, e2] = orthonormalBasis(dir);
  const bottom = origin.clone().addScaledVector(dir, -embed);

  const positions: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];

  for (let i = 0; i <= heightSegments; i++) {
    const hFrac = i / heightSegments;
    const radius = radiusStart + (radiusEnd - radiusStart) * hFrac;
    const center = bottom.clone().addScaledVector(dir, hFrac * length);
    ringStart.push(positions.length / 3);
    for (let j = 0; j < radialSegments; j++) {
      const theta = (j / radialSegments) * Math.PI * 2;
      const phase = hFrac * 1.3;
      const rE1 = radius * (1 - squash) * (1 + distortion * Math.sin(3 * theta + phase));
      const rE2 = radius * (1 + distortion * Math.sin(3 * theta + phase + 1.0));
      const bump = irregularityMm * Math.cos(2 * theta + hFrac * 4.0);

      const p = center
        .clone()
        .addScaledVector(e1, rE1 * Math.cos(theta))
        .addScaledVector(e2, rE2 * Math.sin(theta))
        .addScaledVector(dir, bump);
      positions.push(p.x, p.y, p.z);
    }
  }

  for (let i = 0; i < heightSegments; i++) {
    const startA = ringStart[i]!;
    const startB = ringStart[i + 1]!;
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

  // 下端キャップ（付け根。埋め込まれ隠れるがパーツ単体を閉じた立体にする）
  {
    const ring0 = ringStart[0]!;
    const centerIndex = positions.length / 3;
    positions.push(bottom.x, bottom.y, bottom.z);
    for (let j = 0; j < radialSegments; j++) {
      const jn = (j + 1) % radialSegments;
      indices.push(ring0 + j, ring0 + jn, centerIndex);
    }
  }

  // 上端キャップ（先端）
  {
    const ringTop = ringStart[heightSegments]!;
    const tip = bottom.clone().addScaledVector(dir, length);
    const centerIndex = positions.length / 3;
    positions.push(tip.x, tip.y, tip.z);
    for (let j = 0; j < radialSegments; j++) {
      const jn = (j + 1) % radialSegments;
      indices.push(ringTop + jn, ringTop + j, centerIndex);
    }
  }

  return { positions, indices };
}
