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

/**
 * ナスの初期断面（開発指示書 6.1節「初期断面（7断面）」）。
 * TODO(未決事項 #3, 指示書 13節): 実寸参照画像が未確定のため、最大幅 36.7mm は仮値。
 * 参照画像が確定し次第、この値を差し替える。
 */
export const eggplantBodySections: BodySection[] = [
  { t: 0.0, z: 0, rx: 2.0, ry: 2.0, cx: 0, cy: 0, n: 2.2 }, // 底面（丸みのある先端）
  { t: 0.15, z: 7.5, rx: 10.0, ry: 9.0, cx: 0, cy: 0.5, n: 2.2 },
  { t: 0.3, z: 15, rx: 15.5, ry: 13.5, cx: 0, cy: 1.0, n: 2.0 },
  { t: 0.5, z: 25, rx: 18.35, ry: 15.5, cx: 0, cy: 1.5, n: 2.0 }, // 最大幅付近
  { t: 0.7, z: 35, rx: 16.0, ry: 14.0, cx: 0, cy: 2.0, n: 2.0 },
  { t: 0.88, z: 44, rx: 8.0, ry: 7.0, cx: 0, cy: 2.5, n: 2.3 }, // 絞り
  { t: 1.0, z: 50, rx: 1.2, ry: 1.2, cx: 0, cy: 3.0, n: 2.5 }, // 上端
];

export const defaultBodyParams: BodyParams = {
  totalHeight: 50,
  sections: eggplantBodySections,
  radialSegments: 64,
  heightSamples: 64,
  symmetricX: true,
  flatBottomHeight: 1.0,
};

export const defaultCalyxParams: CalyxParams = {
  baseT: 0.9,
  symmetric: true,
  leaves: Array.from({ length: 5 }, (_, i) => ({
    angle: (360 / 5) * i,
    length: 12,
    width: 6,
    thickness: 1.2,
    pitch: 35,
    curvature: 0.5,
    embed: 1.0,
  })),
};

export const defaultStemParams: StemParams = {
  radius: 2.5,
  length: 12,
  tilt: 8,
  squash: 0.15,
  distortion: 0.2,
  embed: 1.2,
};

// TODO: EyeParams.height / MouthParams.height の単位は指示書に明記がないため、
// 本体表面パラメータ t（0..1）として扱う。spacing / sizeX / sizeY は mm。
export const defaultEyeParams: EyeParams = {
  spacing: 8,
  height: 0.62,
  sizeX: 1.6,
  sizeY: 3.2,
  tilt: 5,
  relief: 0.4,
};

export const defaultMouthParams: MouthParams = {
  preset: 'soft',
  width: 6,
  curveHeight: 2,
  thickness: 1,
  relief: 0.3,
  height: 0.45,
};

export const defaultColorParams: ColorParams = {
  body: '#5b2a86',
  calyx: '#4f7942',
  stem: '#4f7942',
  eye: '#1a1a1a',
  mouth: '#1a1a1a',
};

export function createDefaultProjectData(): ProjectData {
  return {
    version: CURRENT_PROJECT_VERSION,
    unit: 'mm',
    referenceImages: [],
    body: structuredClone(defaultBodyParams),
    calyx: structuredClone(defaultCalyxParams),
    stem: structuredClone(defaultStemParams),
    eyes: structuredClone(defaultEyeParams),
    mouth: structuredClone(defaultMouthParams),
    colors: structuredClone(defaultColorParams),
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
      target: { x: 0, y: 0, z: 25 },
    },
    exportSettings: {
      glbMmZUp: false,
      fileNamePrefix: 'model',
    },
  };
}
