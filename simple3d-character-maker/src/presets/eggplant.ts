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
// 上下端のみ短い区間で急に丸くすぼまる（肩で長く絞るのではない）。
export const eggplantBodySections: BodySection[] = [
  { t: 0.0, z: 0, rx: 4.0, ry: 3.8, cx: 0, cy: 0, n: 2.3 }, // 底面（丸く小さくすぼまる先端）
  { t: 0.1, z: 4.2, rx: 12.0, ry: 10.8, cx: 0, cy: 0.15, n: 2.1 },
  { t: 0.2, z: 8.4, rx: 15.4, ry: 13.9, cx: 0, cy: 0.3, n: 2.0 },
  { t: 0.3, z: 12.6, rx: 17.4, ry: 15.7, cx: 0, cy: 0.4, n: 2.0 },
  { t: 0.4, z: 16.8, rx: 18.4, ry: 16.6, cx: 0, cy: 0.45, n: 2.0 },
  { t: 0.5, z: 21.0, rx: 18.6, ry: 16.8, cx: 0, cy: 0.5, n: 2.0 }, // 最大幅付近
  { t: 0.6, z: 25.2, rx: 18.1, ry: 16.3, cx: 0, cy: 0.45, n: 2.0 },
  { t: 0.7, z: 29.4, rx: 17.1, ry: 15.4, cx: 0, cy: 0.4, n: 2.0 },
  { t: 0.8, z: 33.6, rx: 15.5, ry: 14.0, cx: 0, cy: 0.3, n: 2.05 },
  { t: 0.9, z: 37.8, rx: 13.4, ry: 12.1, cx: 0, cy: 0.2, n: 2.1 },
  { t: 1.0, z: 42.0, rx: 6.5, ry: 6.0, cx: 0, cy: 0, n: 2.2 }, // 上端（ヘタが載る首）
];

export const defaultBodyParams: BodyParams = {
  totalHeight: 42,
  sections: eggplantBodySections,
  radialSegments: 64,
  heightSamples: 64,
  symmetricX: true,
  flatBottomHeight: 1.5,
};

// 参考画像を計測すると、ヘタ（花冠）の最大幅は本体の首（ヘタが載る位置）の
// 実際の半径よりも明らかに大きく張り出しており、個々の花びらというより
// 連続した1枚のスカラップ状ドームに見える（calyxMesh.ts 参照）。
// width は裂片1つの影響角度幅(半値幅deg)、length は谷からの張り出し量(mm)、
// thickness はドーム全体の盛り上がり高さ(mm)。
export const defaultCalyxParams: CalyxParams = {
  baseT: 0.96,
  symmetric: true,
  leaves: Array.from({ length: 5 }, (_, i) => ({
    angle: (360 / 5) * i,
    length: 4.5,
    width: 38,
    thickness: 2.5,
    pitch: 0,
    curvature: 0,
    embed: 2,
  })),
};

// 参考画像のヘタ中央には、花冠から立ち上がりコンマ状に丸くカーブする、
// 根元が太く先端が丸まった芽（茎）がある。
export const defaultStemParams: StemParams = {
  radius: 1.6,
  length: 6.5,
  tilt: 10,
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
