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
// 参考画像は「肩」で急に絞られる壺型ではなく、卵形のまま連続的になだらかに
// 先細っていく（首のくびれが無い）シルエットのため、最大幅から上端まで
// 単調になだらかに減少する一本のカーブになるよう区間を組み直している。
export const eggplantBodySections: BodySection[] = [
  { t: 0.0, z: 0, rx: 4.5, ry: 4.5, cx: 0, cy: 0, n: 2.4 }, // 底面（丸みの強い先端）
  { t: 0.18, z: 7.6, rx: 11.5, ry: 10.5, cx: 0, cy: 0.2, n: 2.2 },
  { t: 0.36, z: 15.1, rx: 15.0, ry: 13.5, cx: 0, cy: 0.4, n: 2.1 },
  { t: 0.52, z: 21.8, rx: 16.0, ry: 14.5, cx: 0, cy: 0.5, n: 2.0 }, // 最大幅付近
  { t: 0.68, z: 28.6, rx: 14.0, ry: 12.5, cx: 0, cy: 0.4, n: 2.05 },
  { t: 0.82, z: 34.4, rx: 10.5, ry: 9.5, cx: 0, cy: 0.25, n: 2.15 },
  { t: 0.93, z: 39.1, rx: 7.0, ry: 6.5, cx: 0, cy: 0.1, n: 2.2 },
  { t: 1.0, z: 42.0, rx: 4.0, ry: 4.0, cx: 0, cy: 0, n: 2.3 }, // 上端（ヘタが載る、くびれの無い先細り）
];

export const defaultBodyParams: BodyParams = {
  totalHeight: 42,
  sections: eggplantBodySections,
  radialSegments: 64,
  heightSamples: 64,
  symmetricX: true,
  flatBottomHeight: 1.5,
};

// 参考画像（粘土フィギュア）のヘタは、葉が垂れ下がらず本体の肩に沿って
// 隣同士がほぼ密着する丸いスカラップ状の「花冠」に見える。そのため
// pitch/curvature をほぼ0にして葉を垂らさず、width を広げて隣の葉と
// 重ねることで連続した花冠シルエットを作る。
export const defaultCalyxParams: CalyxParams = {
  baseT: 0.94,
  symmetric: true,
  leaves: Array.from({ length: 5 }, (_, i) => ({
    angle: (360 / 5) * i,
    length: 3,
    width: 8,
    thickness: 1.8,
    pitch: 4,
    curvature: 0.05,
    embed: 0.8,
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
