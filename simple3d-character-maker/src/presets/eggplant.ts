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
 * 参考イラスト（丸みの強いデフォルメ・パステルカラー）に合わせて、
 * 丸みの強い(ほぼ卵形〜球形に近い)シルエットに調整している。
 * TODO(未決事項 #3, 指示書 13節): 実寸参照画像が未確定のため、寸法自体は仮値。
 */
export const eggplantBodySections: BodySection[] = [
  { t: 0.0, z: 0, rx: 5.0, ry: 5.0, cx: 0, cy: 0, n: 2.4 }, // 底面（丸みの強い先端）
  { t: 0.15, z: 6.3, rx: 12.0, ry: 11.0, cx: 0, cy: 0.2, n: 2.2 },
  { t: 0.32, z: 13.4, rx: 18.0, ry: 16.0, cx: 0, cy: 0.4, n: 2.1 },
  { t: 0.5, z: 21.0, rx: 20.0, ry: 18.0, cx: 0, cy: 0.5, n: 2.0 }, // 最大幅付近
  { t: 0.68, z: 28.6, rx: 17.0, ry: 15.0, cx: 0, cy: 0.4, n: 2.0 },
  { t: 0.85, z: 35.7, rx: 9.0, ry: 8.0, cx: 0, cy: 0.2, n: 2.2 }, // 絞り
  { t: 1.0, z: 42.0, rx: 4.0, ry: 4.0, cx: 0, cy: 0, n: 2.4 }, // 上端（丸い肩）
];

export const defaultBodyParams: BodyParams = {
  totalHeight: 42,
  sections: eggplantBodySections,
  radialSegments: 64,
  heightSamples: 64,
  symmetricX: true,
  flatBottomHeight: 1.5,
};

export const defaultCalyxParams: CalyxParams = {
  baseT: 0.93,
  symmetric: true,
  leaves: Array.from({ length: 5 }, (_, i) => ({
    angle: (360 / 5) * i,
    length: 6,
    width: 14,
    thickness: 1.5,
    pitch: 12,
    curvature: 0.2,
    embed: 1.0,
  })),
};

export const defaultStemParams: StemParams = {
  radius: 1.5,
  length: 4,
  tilt: 5,
  squash: 0.1,
  distortion: 0.1,
  embed: 1.0,
};

// TODO: EyeParams.height / MouthParams.height の単位は指示書に明記がないため、
// 本体表面パラメータ t（0..1）として扱う。spacing / sizeX / sizeY は mm。
export const defaultEyeParams: EyeParams = {
  spacing: 9,
  height: 0.58,
  sizeX: 1.8,
  sizeY: 3.0,
  tilt: 0,
  relief: 0.3,
};

export const defaultMouthParams: MouthParams = {
  preset: 'soft',
  width: 7,
  curveHeight: 2,
  thickness: 1.2,
  relief: 0.3,
  height: 0.4,
};

export const defaultColorParams: ColorParams = {
  body: '#d9c2e0',
  calyx: '#bfe0c0',
  stem: '#bfe0c0',
  eye: '#2a2a2a',
  mouth: '#2a2a2a',
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
      target: { x: 0, y: 0, z: 21 },
    },
    exportSettings: {
      glbMmZUp: false,
      fileNamePrefix: 'model',
    },
  };
}
