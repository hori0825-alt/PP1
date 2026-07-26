import * as THREE from 'three';

/**
 * 単位・座標系の規約（開発指示書 3節）
 * - シーン内部の 1 unit = 1 mm
 * - Z-up 統一。原点は底面中心（bbox.min.z === 0, bbox.center.x === 0）
 */

export const MM_PER_UNIT = 1;

export const CAMERA_NEAR = 0.5;
export const CAMERA_FAR = 3000;
export const CAMERA_INITIAL_DISTANCE_MM = 150;

export const GRID_MAJOR_STEP_MM = 10;
export const GRID_MINOR_STEP_MM = 1;

/** 起動時に一度だけ呼び出し、Three.js のデフォルト上方向を Z 軸に固定する。 */
export function configureZUp(): void {
  THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
}

/** mm 値を小数第1位までの表示用文字列に丸める。 */
export function formatMm(valueMm: number): string {
  return `${valueMm.toFixed(1)} mm`;
}

export function roundMm(valueMm: number): number {
  return Math.round(valueMm * 10) / 10;
}
