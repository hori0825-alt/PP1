import * as THREE from 'three';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';

export const MTL_MATERIAL_NAME = 'simple3d_main';

/**
 * OBJ + MTL 出力（開発指示書 6.7節）。
 * three.js の OBJExporter はマテリアルを MTL に書き出せないため、
 * 出力文字列に対してアプリ側で mtllib / usemtl 行を後挿入する。
 */
export function exportObjText(root: THREE.Object3D): string {
  const exporter = new OBJExporter();
  const raw = exporter.parse(root);
  return postProcessObj(raw);
}

export function postProcessObj(raw: string): string {
  const lines = raw.split('\n');
  const withMtllib = ['mtllib model.mtl', ...lines];

  const firstFaceIndex = withMtllib.findIndex((line) => line.startsWith('f '));
  if (firstFaceIndex === -1) {
    return withMtllib.join('\n');
  }
  withMtllib.splice(firstFaceIndex, 0, `usemtl ${MTL_MATERIAL_NAME}`);
  return withMtllib.join('\n');
}

export function buildMtlText(): string {
  return [
    `newmtl ${MTL_MATERIAL_NAME}`,
    'Ka 0.000 0.000 0.000',
    'Kd 1.000 1.000 1.000',
    'Ks 0.000 0.000 0.000',
    'd 1.0',
    'illum 1',
    'map_Kd texture.png',
    '',
  ].join('\n');
}
