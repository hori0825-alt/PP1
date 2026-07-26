import * as THREE from 'three';
import type { BodySection, EyeParams, MouthParams } from '../core/params';
import { buildBodySurface, type BodySurface } from './surface';
import { appendGridShell, fixOutwardWinding, type GridShellPoint } from './meshUtils';

export interface FaceMeshResult {
  geometry: THREE.BufferGeometry;
  warnings: string[];
}

const DEG2RAD = Math.PI / 180;
// -Y が正面（3.2節）。顔のパーツはすべてこの方位角を中心に配置する。
const FRONT_THETA = -Math.PI / 2;
// 目・口は本体表面へのわずかな埋め込みで薄いシェルを閉じる（指示書に明記の無い実装上の定数）。
const FACE_EMBED_MM = 0.3;

/**
 * 本体表面上の接平面における局所オフセット (dx, dy) を、本体表面パラメータ (t, θ) へ
 * 近似変換する。dx は θ 方向（水平）、dy は t 方向（鉛直）に対応する。
 * 小さな顔パーツの配置にのみ使う近似であり、S(t, θ) 自体の定義は変えない。
 */
function tangentPlaneToSurface(
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

function surfacePoint(surface: BodySurface, t: number, theta: number): THREE.Vector3 {
  const p = surface.point(t, theta);
  return new THREE.Vector3(p.x, p.y, p.z);
}

function surfaceNormal(surface: BodySurface, t: number, theta: number): THREE.Vector3 {
  const n = surface.normal(t, theta);
  return new THREE.Vector3(n.x, n.y, n.z);
}

const LENS_RINGS = 5;
const LENS_SEGMENTS = 16;

/** 目のような、平面内で丸く盛り上がる薄いレンズ状の立体（コイン形状）を追加する。 */
function appendLensShell(
  surface: BodySurface,
  centerT: number,
  centerTheta: number,
  tiltRad: number,
  sizeX: number,
  sizeY: number,
  relief: number,
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

  // 頂点座標を先に計算して配列へ格納する
  const outerPts: THREE.Vector3[] = [];
  const innerPts: THREE.Vector3[] = [];

  function computePoint(r: number, phi: number): { outer: THREE.Vector3; inner: THREE.Vector3 } {
    const localX = sizeX * r * Math.cos(phi);
    const localY = sizeY * r * Math.sin(phi);
    const dx = localX * Math.cos(tiltRad) - localY * Math.sin(tiltRad);
    const dy = localX * Math.sin(tiltRad) + localY * Math.cos(tiltRad);
    const { t, theta } = tangentPlaneToSurface(surface, centerT, centerTheta, dx, dy);
    const p = surfacePoint(surface, t, theta);
    const n = surfaceNormal(surface, t, theta);
    return {
      outer: p.clone().addScaledVector(n, relief),
      inner: p.clone().addScaledVector(n, -FACE_EMBED_MM),
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

/** 目を生成する（開発指示書 6.4節）。左右対称に本体表面へ配置し、法線方向へ盛り上げる。 */
export function buildEyeMesh(eyes: EyeParams, bodySections: readonly BodySection[]): FaceMeshResult {
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
    appendLensShell(
      surface,
      centerT,
      centerTheta,
      tiltRad,
      eyes.sizeX,
      eyes.sizeY,
      eyes.relief,
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
export function buildMouthMesh(mouth: MouthParams, bodySections: readonly BodySection[]): FaceMeshResult {
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
      const p = surfacePoint(surface, t, theta);
      const n = surfaceNormal(surface, t, theta);
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
