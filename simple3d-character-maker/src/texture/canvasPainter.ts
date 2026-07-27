import * as THREE from 'three';
import type { ColorParams, CowColorParams } from '../core/params';
import {
  ATLAS_PATCHES,
  ATLAS_SIZE,
  patchCenterUV,
  patchFillRect,
  type AtlasPatch,
  type PartKey,
} from './atlas';

/**
 * パーツ色から 2048x2048 のテクスチャアトラスを Canvas 上に描画する。
 * ナス・牛のどちらのキャラクタータイプでも同じアトラスを使い回せるよう、
 * 両方の色を常に描画しておく（未使用パッチが残っても実害はない）。
 */
export function paintAtlasCanvas(colors: ColorParams, cowColors: CowColorParams): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('paintAtlasCanvas: 2D context を取得できませんでした');
  }

  // 背景は不透明の白で埋める（透明PNGは印刷側で事故が起きやすいため：6.6節）
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);

  const colorByPart: Record<PartKey, string> = {
    body: colors.body,
    calyx: colors.calyx,
    stem: colors.stem,
    eye: colors.eye,
    mouth: colors.mouth,
    cowBody: cowColors.body,
    cowSpots: cowColors.spot,
    cowHorns: cowColors.horn,
    cowNose: cowColors.nose,
    cowEyes: cowColors.eye,
  };

  for (const key of Object.keys(ATLAS_PATCHES) as PartKey[]) {
    const rect = patchFillRect(ATLAS_PATCHES[key]);
    ctx.fillStyle = colorByPart[key];
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  }

  return canvas;
}

export function createAtlasTexture(colors: ColorParams, cowColors: CowColorParams): THREE.CanvasTexture {
  const canvas = paintAtlasCanvas(colors, cowColors);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * ジオメトリの全頂点 UV をパッチ中心の1点近傍へ収束させる（ベタ塗り）。
 * 境界のにじみを避けるため、パッチはあらかじめ 8px マージンを空けて塗られている。
 */
export function assignSolidUV(geometry: THREE.BufferGeometry, patch: AtlasPatch): void {
  const position = geometry.getAttribute('position');
  const { u, v } = patchCenterUV(patch);
  const uvArray = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    uvArray[i * 2] = u;
    uvArray[i * 2 + 1] = v;
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvArray, 2));
}
