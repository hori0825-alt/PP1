import type {
  BodySection,
  CowColorParams,
  CowEarParams,
  CowEyeParams,
  CowHeadParams,
  CowHornParams,
  CowLegsParams,
  CowNostrilParams,
  CowParams,
  CowSpotParams,
  CowTailParams,
  CowTorsoParams,
} from '../core/params';

/**
 * 牛の初期パラメータ（開発指示書 8節）。
 * 胴体・頭は本体と同じ断面表現（S(t,θ)）を再利用し、水平向きの浮いたカプセルとして
 * 生成する（geometry/capsuleMesh.ts 参照）。丸みのある四足胴体・頭・短く太い
 * 四本脚・太く短い角・本体に沿う短いしっぽ・色のみのグレー模様、を反映している。
 */

export const cowTorsoSections: BodySection[] = [
  { t: 0.0, z: 0, rx: 6.0, ry: 6.0, cx: 0, cy: 0, n: 2.3 }, // 尾側
  { t: 0.25, z: 8, rx: 13.0, ry: 12.0, cx: 0, cy: 0, n: 2.1 },
  { t: 0.5, z: 16, rx: 15.0, ry: 14.0, cx: 0, cy: 0, n: 2.0 }, // 最大幅
  { t: 0.75, z: 24, rx: 13.0, ry: 12.0, cx: 0, cy: 0, n: 2.1 },
  { t: 1.0, z: 32, rx: 7.0, ry: 7.0, cx: 0, cy: 0, n: 2.3 }, // 胸側（頭の付け根）
];

export const defaultCowTorsoParams: CowTorsoParams = {
  sections: cowTorsoSections,
  radialSegments: 32,
  heightSamples: 24,
};

export const cowHeadSections: BodySection[] = [
  { t: 0.0, z: 0, rx: 6.0, ry: 6.0, cx: 0, cy: 0, n: 2.2 }, // 首側
  { t: 0.4, z: 6, rx: 7.5, ry: 7.0, cx: 0, cy: 0, n: 2.1 },
  { t: 0.7, z: 11, rx: 7.0, ry: 6.5, cx: 0, cy: 0.3, n: 2.0 },
  { t: 1.0, z: 15, rx: 5.0, ry: 5.0, cx: 0, cy: 0.5, n: 2.3 }, // 鼻先
];

export const defaultCowHeadParams: CowHeadParams = {
  sections: cowHeadSections,
  radialSegments: 24,
  heightSamples: 16,
  tilt: 10,
};

export const defaultCowLegsParams: CowLegsParams = {
  front: { radius: 3.5, length: 11, distortion: 0.1, squash: 0.05, embed: 2 },
  back: { radius: 3.8, length: 11, distortion: 0.1, squash: 0.05, embed: 2 },
  spacingX: 9,
  frontT: 0.78,
  backT: 0.15,
};

export const defaultCowEarParams: CowEarParams = {
  sizeX: 4.5,
  sizeY: 5.5,
  tilt: 20,
  relief: 1.8,
  attachHeight: 0.55,
  spacing: 45,
};

export const defaultCowHornParams: CowHornParams = {
  length: 5,
  radiusStart: 2,
  radiusEnd: 0.8,
  tilt: 35,
  attachHeight: 0.3,
  spacing: 38,
};

export const defaultCowTailParams: CowTailParams = {
  radius: 1.5,
  length: 14,
  tilt: 25,
  distortion: 0.15,
  tuftSize: 2.5,
};

export const defaultCowEyeParams: CowEyeParams = {
  spacing: 15,
  height: 0.8,
  sizeX: 1.3,
  sizeY: 1.6,
  relief: 0.3,
};

export const defaultCowNostrilParams: CowNostrilParams = {
  spacing: -15,
  height: 0.95,
  size: 0.8,
  relief: 0.15,
};

export const defaultCowSpotParams: CowSpotParams = {
  seed: 1,
  count: 6,
  minSize: 3,
  maxSize: 6,
};

export const defaultCowColorParams: CowColorParams = {
  body: '#f7f5f2',
  spot: '#4a4a4a',
  horn: '#cbb994',
  nose: '#e8a0a8',
  eye: '#1a1a1a',
};

export function createDefaultCowParams(): CowParams {
  return {
    torso: structuredClone(defaultCowTorsoParams),
    head: structuredClone(defaultCowHeadParams),
    legs: structuredClone(defaultCowLegsParams),
    ears: structuredClone(defaultCowEarParams),
    horns: structuredClone(defaultCowHornParams),
    tail: structuredClone(defaultCowTailParams),
    eyes: structuredClone(defaultCowEyeParams),
    nostrils: structuredClone(defaultCowNostrilParams),
    spots: structuredClone(defaultCowSpotParams),
    colors: structuredClone(defaultCowColorParams),
  };
}
