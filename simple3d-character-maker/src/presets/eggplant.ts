import {
  CURRENT_PROJECT_VERSION,
  type BodyParams,
  type BodySection,
  type CalyxParams,
  type ColorParams,
  type EyeParams,
  type MouthParams,
  type ProjectData,
  type StemParams,
} from '../core/params';
import { createDefaultCowParams } from './cow';

/**
 * ナスの初期断面（開発指示書 6.1節「初期断面（7断面）」）。
 * 参考イラスト（丸みの強いデフォルメ・パステルカラー）に合わせて、
 * 丸みの強い(ほぼ卵形〜球形に近い)シルエットに調整している。
 * TODO(未決事項 #3, 指示書 13節): 実寸参照画像が未確定のため、寸法自体は仮値。
 */
// 参考画像を実際にピクセル計測し(輪郭の左右端をトレースして幅を測定)、
// その相対プロファイルに合わせて断面を組んでいる。実測では中間70%
// (t=0.1〜0.9)が最大幅の65〜99%を保つ非常にふっくらした卵形で、
// 上端（ヘタの真下）でも最大幅の約72%までしか細くならない
// （＝いわゆる「細い首」はほぼ無く、ヘタの真下までふっくら太いまま）。
// 見た目上の「首」の印象は本体の先細りではなく、ヘタ（花冠）がその上に
// 少し張り出して載ることで生まれている（calyxMesh.ts 参照）。
// なお本体の「首下～底面」の高さに対する最大幅の比は実測で約0.81。
// 幅の分布(各tでの相対幅)を変えずにこの比を再現するため、全高を42→46mmへ
// 引き伸ばしている（rx/ry・cx/cyは据え置き、zのみ46/42倍）。
// 底面付近(t=0〜0.15)は実測で非常に急に丸く広がる(t=0.04で最大幅の25%、
// t=0.10で64%に達する)。7断面のみだと補間曲線がなだらかになりすぎて
// この急峻な丸みを再現できないため、t=0.05/0.08/0.15に断面を追加している。
export const eggplantBodySections: BodySection[] = [
  { t: 0.0, z: 0, rx: 4.0, ry: 3.8, cx: 0, cy: 0, n: 2.3 }, // 底面（丸く小さくすぼまる先端）
  { t: 0.05, z: 2.3, rx: 9.0, ry: 8.1, cx: 0, cy: 0.05, n: 2.4 },
  { t: 0.08, z: 3.68, rx: 11.1, ry: 10.0, cx: 0, cy: 0.1, n: 2.2 },
  { t: 0.1, z: 4.6, rx: 11.9, ry: 10.7, cx: 0, cy: 0.15, n: 2.15 },
  { t: 0.15, z: 6.9, rx: 15.2, ry: 13.7, cx: 0, cy: 0.22, n: 2.05 },
  { t: 0.2, z: 9.2, rx: 16.5, ry: 14.9, cx: 0, cy: 0.3, n: 2.0 },
  { t: 0.3, z: 13.8, rx: 17.8, ry: 16.1, cx: 0, cy: 0.4, n: 2.0 },
  { t: 0.4, z: 18.4, rx: 18.5, ry: 16.7, cx: 0, cy: 0.45, n: 2.0 },
  { t: 0.5, z: 23.0, rx: 18.6, ry: 16.8, cx: 0, cy: 0.5, n: 2.0 }, // 最大幅付近
  { t: 0.6, z: 27.6, rx: 18.5, ry: 16.7, cx: 0, cy: 0.45, n: 2.0 },
  { t: 0.7, z: 32.2, rx: 18.0, ry: 16.3, cx: 0, cy: 0.4, n: 2.0 },
  { t: 0.8, z: 36.8, rx: 17.2, ry: 15.5, cx: 0, cy: 0.3, n: 2.02 },
  { t: 0.9, z: 41.4, rx: 16.2, ry: 14.7, cx: 0, cy: 0.15, n: 2.05 },
  { t: 1.0, z: 46.0, rx: 13.4, ry: 12.1, cx: 0, cy: 0, n: 2.1 }, // 上端（ヘタが載る面。ほぼ絞らない）
];

export const defaultBodyParams: BodyParams = {
  totalHeight: 46,
  sections: eggplantBodySections,
  radialSegments: 64,
  heightSamples: 64,
  symmetricX: true,
  flatBottomHeight: 1.5,
};

// 参考画像のヘタは、本体の（ほぼ絞られていない）上端面に載る、ふちが波打つ
// 星形の1枚のキャップに見える（実測で本体上端幅の約1.6倍まで外側へ張り出す）。
// width は裂片先端までの中心軸からの半径(mm)、length は谷（裂片の間）の
// 半径を広げる量(mm)、thickness は裂片頂点での盛り上がり高さ(mm)。
// baseT=1.0（本体最上端）に置き、本体の上端面を完全に覆う大きさにする。
export const defaultCalyxParams: CalyxParams = {
  baseT: 1.0,
  symmetric: true,
  leaves: Array.from({ length: 5 }, (_, i) => ({
    angle: (360 / 5) * i,
    length: 2.5,
    width: 15,
    thickness: 6.5,
    pitch: 0,
    curvature: 0,
    embed: 2,
  })),
};

// 参考画像のヘタ中央には、花冠から立ち上がりコンマ状に丸くカーブする、
// 根元が太く先端が丸まった芽（茎）がある。
export const defaultStemParams: StemParams = {
  radius: 2.6,
  length: 22,
  tilt: 5,
  squash: 0.05,
  distortion: 0.05,
  embed: 0.8,
};

// TODO: EyeParams.height / MouthParams.height の単位は指示書に明記がないため、
// 本体表面パラメータ t（0..1）として扱う。spacing / sizeX / sizeY は mm。
// 参考画像の目は縦長の小さな楕円（現在より一回り小さく、やや上寄り）。
export const defaultEyeParams: EyeParams = {
  spacing: 7.5,
  height: 0.64,
  sizeX: 1.2,
  sizeY: 2.0,
  tilt: 0,
  relief: 0.3,
};

export const defaultMouthParams: MouthParams = {
  preset: 'soft',
  width: 7,
  curveHeight: 2,
  thickness: 1.2,
  relief: 0.3,
  height: 0.46,
};

export const defaultColorParams: ColorParams = {
  body: '#d9c2e0',
  calyx: '#bfe0c0',
  stem: '#bfe0c0',
  eye: '#2a2a2a',
  mouth: '#2a2a2a',
};

export function createDefaultProjectData(
  characterType: 'eggplant' | 'cow' = 'eggplant',
): ProjectData {
  return {
    version: CURRENT_PROJECT_VERSION,
    unit: 'mm',
    characterType,
    referenceImages: [],
    body: structuredClone(defaultBodyParams),
    calyx: structuredClone(defaultCalyxParams),
    stem: structuredClone(defaultStemParams),
    eyes: structuredClone(defaultEyeParams),
    mouth: structuredClone(defaultMouthParams),
    colors: structuredClone(defaultColorParams),
    cow: createDefaultCowParams(),
    printSettings: {
      // 印刷業者の仕様確定（13節 未決事項#2 回答済み）:
      // 「実寸1mm以下の部分は折れやすいため太くする」。ここでの値は安全マージンを
      // 含めた黄警告の目安（赤警告は inspect/checks.ts・geometry/stemMesh.ts で
      // 確定仕様値そのもの=1mmを直接しきい値として使用）。
      minWallThicknessMm: 2.0,
      minStemRadiusMm: 0.75, // 直径1.5mm相当（確定仕様の直径1mmに安全マージン）
      minCalyxEmbedMm: 0.8,
    },
    camera: {
      view: 'perspective',
      orthographic: false,
      distanceMm: 150,
      target: { x: 0, y: 0, z: 21 },
    },
    exportSettings: {
      glbMmZUp: false,
      fileNamePrefix: 'model',
    },
  };
}
