import * as THREE from 'three';

/** メッシュ生成で共通に使う小さなユーティリティ。 */

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
