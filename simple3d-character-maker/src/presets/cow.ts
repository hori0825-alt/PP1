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

// 参考画像（粘土フィギュア）は胴体が短く丸く、頭が胴体とほぼ同じ大きさの
// 丸い塊として前方に付く、非常にコンパクトなデフォルメ比率になっている。
export const cowTorsoSections: BodySection[] = [
  { t: 0.0, z: 0, rx: 6.0, ry: 6.0, cx: 0, cy: 0, n: 2.3 }, // 尾側
  { t: 0.3, z: 7, rx: 12.0, ry: 11.0, cx: 0, cy: 0, n: 2.1 },
  { t: 0.55, z: 12, rx: 13.0, ry: 12.5, cx: 0, cy: 0, n: 2.0 }, // 最大幅
  { t: 0.8, z: 18, rx: 11.0, ry: 10.5, cx: 0, cy: 0, n: 2.1 },
  { t: 1.0, z: 22, rx: 7.0, ry: 7.0, cx: 0, cy: 0, n: 2.3 }, // 胸側（頭の付け根）
];

export const defaultCowTorsoParams: CowTorsoParams = {
  sections: cowTorsoSections,
  radialSegments: 32,
  heightSamples: 24,
};

// 頭は胴体に匹敵するくらい大きな丸い塊（参考画像）。tilt を負にして鼻先を
// 下向き〜前向きにする（見上げるようなポーズにしない）。
export const cowHeadSections: BodySection[] = [
  { t: 0.0, z: 0, rx: 6.5, ry: 6.5, cx: 0, cy: 0, n: 2.2 }, // 首側
  { t: 0.35, z: 6, rx: 11.5, ry: 11.0, cx: 0, cy: 0, n: 2.1 },
  { t: 0.65, z: 11, rx: 12.0, ry: 11.5, cx: 0, cy: 0.2, n: 2.0 }, // 最大幅（丸い頭）
  { t: 0.85, z: 14, rx: 9.0, ry: 8.5, cx: 0, cy: 0.4, n: 2.1 },
  { t: 1.0, z: 16, rx: 6.0, ry: 6.0, cx: 0, cy: 0.6, n: 2.3 }, // 鼻先
];

export const defaultCowHeadParams: CowHeadParams = {
  sections: cowHeadSections,
  radialSegments: 28,
  heightSamples: 18,
  tilt: -16,
};

// 参考画像の脚は接地するだけの短い太い「棒」に近い。
export const defaultCowLegsParams: CowLegsParams = {
  front: { radius: 3.0, length: 6, distortion: 0.08, squash: 0.05, embed: 1.3 },
  back: { radius: 3.2, length: 6, distortion: 0.08, squash: 0.05, embed: 1.3 },
  spacingX: 8,
  frontT: 0.82,
  backT: 0.14,
};

// 参考画像では耳はほとんど目立たず、頭の輪郭にほぼ埋もれて見える。
export const defaultCowEarParams: CowEarParams = {
  sizeX: 2.6,
  sizeY: 3.2,
  tilt: 15,
  relief: 0.6,
  attachHeight: 0.5,
  spacing: 55,
};

// 参考画像の角は頭頂中央寄りに2本近接し、丸みのある太短い形。
export const defaultCowHornParams: CowHornParams = {
  length: 3.5,
  radiusStart: 2.3,
  radiusEnd: 1.3,
  tilt: 28,
  attachHeight: 0.25,
  spacing: 20,
};

export const defaultCowTailParams: CowTailParams = {
  radius: 1.6,
  length: 14,
  tilt: 25,
  distortion: 0.15,
  tuftSize: 3,
};

// 参考画像の目は盛り上がったレンズ状ではなく、平たく小さい黒目。
export const defaultCowEyeParams: CowEyeParams = {
  spacing: 10,
  height: 0.78,
  sizeX: 1.0,
  sizeY: 1.1,
  relief: 0.1,
};

export const defaultCowNostrilParams: CowNostrilParams = {
  spacing: -12,
  height: 0.83,
  size: 1.0,
  relief: 0.15,
};

// 参考画像の斑点模様は、頭〜首〜背中に広がる大きな連続した一枚の
// まだら模様が主体（小さな水玉ではない）。cowMesh.ts 側で個数を少なく・
// サイズを大きくし、上面(背側)へ偏らせて配置する。
export const defaultCowSpotParams: CowSpotParams = {
  seed: 1,
  count: 1,
  minSize: 2.5,
  maxSize: 3.5,
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
