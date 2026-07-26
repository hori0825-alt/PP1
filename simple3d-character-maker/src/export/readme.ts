import type { ProjectData } from '../core/params';

/** 印刷会社向けメモ（README_print.txt）。単位・座標系・原点・想定寸法を明記する（6.7節）。 */
export function buildReadmePrintText(project: ProjectData): string {
  const maxRx = Math.max(...project.body.sections.map((s) => s.rx));
  const maxRy = Math.max(...project.body.sections.map((s) => s.ry));
  return [
    'Simple3D Character Maker - 印刷用データについて',
    '',
    `単位: mm（model.obj / model.stl は mm 等倍）`,
    `座標系: Z-up（+Z が上）。原点は底面中心（bbox.min.z = 0, bbox.center.x = 0）。`,
    `全高: ${project.body.totalHeight.toFixed(1)} mm`,
    `最大幅（X方向, 概算）: ${(maxRx * 2).toFixed(1)} mm`,
    `最大奥行き（Y方向, 概算）: ${(maxRy * 2).toFixed(1)} mm`,
    '',
    'model.glb は glTF の仕様に合わせて既定でメートル・Y-up に変換して出力しています',
    '（exportSettings.glbMmZUp を有効にすると mm・Z-up のまま出力できます）。',
    '',
    'model.obj + model.mtl + texture.png は単一マテリアル(simple3d_main)構成です。',
    'すべてのパーツが1枚のテクスチャアトラス(texture.png)を共有し、パーツごとの',
    '色はアトラス上の単色パッチとして塗り分けています。',
    '',
    '同梱の print_check.txt に、出力直前の自己診断結果を記載しています。',
  ].join('\n');
}
