/**
 * データモデル（開発指示書 5節）。
 * JSON へ保存できる純粋データを唯一の正とする（方針 11）。
 * UI・3D シーンはすべてこの型のみを参照し、Three.js オブジェクトを状態として保持しない。
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** 本体の 1 断面 */
export interface BodySection {
  t: number; // 高さ方向の正規化位置 0..1
  z: number; // 実高さ mm（t から導出せず、明示的に保持）
  rx: number; // X 半径（正面幅の半分）mm
  ry: number; // Y 半径（側面奥行きの半分）mm
  cx: number; // X 中心オフセット mm
  cy: number; // Y 中心オフセット mm
  n: number; // 丸み係数（スーパー楕円指数）2 = 楕円
}

export interface BodyParams {
  totalHeight: number; // 全高 mm（既定 50）
  sections: BodySection[]; // 最低 7、可変
  radialSegments: number; // 既定 64
  heightSamples: number; // 補間後の断面数 既定 64
  symmetricX: boolean; // 左右対称ロック
  flatBottomHeight: number; // 底面平坦化の高さ mm（既定 1.0）
}

export interface CalyxLeaf {
  angle: number; // 中心からの方位角 deg
  length: number; // mm
  width: number; // mm
  thickness: number; // mm
  pitch: number; // 下向き角度 deg
  curvature: number; // 下向き曲率 0..1
  embed: number; // 本体への埋め込み量 mm（0.8〜1.5 推奨）
}

export interface CalyxParams {
  leaves: CalyxLeaf[]; // 既定 5
  baseT: number; // 本体上のどの高さに載せるか 0..1
  symmetric: boolean;
}

export interface StemParams {
  radius: number; // mm
  length: number; // mm
  tilt: number; // 傾き deg
  squash: number; // 潰し率 0..1
  distortion: number; // 断面歪み 0..1
  embed: number; // ヘタ中央への埋め込み mm（1.0 以上）
}

export interface EyeParams {
  spacing: number;
  height: number;
  sizeX: number;
  sizeY: number;
  tilt: number;
  relief: number; // 盛り上がり 0..0.8mm
}

export type MouthPreset = 'soft' | 'strong' | 'line' | 'none';
export interface MouthParams {
  preset: MouthPreset;
  width: number;
  curveHeight: number;
  thickness: number;
  relief: number; // 正なら盛り上げ、負なら彫り込み
  height: number; // 顔上の高さ
}

export interface ColorParams {
  body: string;
  calyx: string;
  stem: string;
  eye: string;
  mouth: string;
}

export interface ReferenceImage {
  view: 'front' | 'side' | 'top';
  dataUrl: string; // base64。JSON に内包する
  visible: boolean;
  opacity: number;
  scale: number;
  offset: Vec2;
  rotation: number;
  flipX: boolean;
  locked: boolean;
  calibration?: { p1: Vec2; p2: Vec2; realLengthMm: number };
}

/** 印刷設定。TODO(未決事項 #1, #2): 業者の受入フォーマット・最小肉厚/最小径の実数値は暫定。 */
export interface PrintSettings {
  minWallThicknessMm: number; // 暫定 3.0mm（参考値）
  minStemRadiusMm: number; // 暫定 1.2mm / 赤閾値 0.8mm
  minCalyxEmbedMm: number; // 暫定 0.8mm 推奨
}

export type ViewName = 'front' | 'side' | 'top' | 'back' | 'perspective';

export interface CameraState {
  view: ViewName;
  orthographic: boolean;
  distanceMm: number;
  target: Vec2 & { z: number };
}

export interface ExportSettings {
  glbMmZUp: boolean; // true の場合のみ GLB を mm・Z-up のまま出力する（既定 false = m・Y-up）
  fileNamePrefix: string; // 既定 "model"
}

/**
 * Phase 2: 牛（開発指示書 8節）。
 * 胴体・頭は本体と同じ断面表現（BodySection・S(t,θ)）を再利用し、
 * geometry/capsuleMesh.ts で水平向きの「浮いた」カプセル形状として生成する。
 */
export interface CowTorsoParams {
  sections: BodySection[]; // t=0 尾側 → t=1 胸側
  radialSegments: number;
  heightSamples: number;
  groundClearance: number; // 地面から胴体下端までの高さ（≒脚の長さの目安）mm
}

export interface CowHeadParams {
  sections: BodySection[]; // t=0 首側 → t=1 鼻先側
  radialSegments: number;
  heightSamples: number;
  tilt: number; // 首の上向き角度 deg
}

export interface CowLegParams {
  radius: number;
  length: number;
  distortion: number;
  squash: number;
  embed: number;
}

export interface CowLegsParams {
  front: CowLegParams;
  back: CowLegParams;
  spacingX: number; // 左右の脚の間隔 mm
  frontT: number; // 前脚を付ける胴体上の t
  backT: number; // 後脚を付ける胴体上の t
}

export interface CowEarParams {
  sizeX: number;
  sizeY: number;
  tilt: number;
  relief: number;
  attachHeight: number; // 頭表面上の高さ位置 t
  spacing: number; // 左右の開き角換算 mm
}

export interface CowHornParams {
  length: number;
  radiusStart: number;
  radiusEnd: number;
  tilt: number; // 外向き＋上向きの角度 deg
  attachHeight: number; // 頭表面上の高さ位置 t
  spacing: number;
}

export interface CowTailParams {
  radius: number;
  length: number;
  tilt: number;
  distortion: number;
  tuftSize: number; // 先端房の半径 mm
}

export interface CowEyeParams {
  spacing: number;
  height: number; // 頭表面上の高さ位置 t
  sizeX: number;
  sizeY: number;
  relief: number;
}

export interface CowNostrilParams {
  spacing: number;
  height: number; // 頭表面上の高さ位置 t（鼻先寄り）
  size: number;
  relief: number;
}

/** 色のみのグレー模様（8節）。表面に貼り付く小さな色パッチとして実装する。 */
export interface CowSpotParams {
  seed: number;
  count: number;
  minSize: number;
  maxSize: number;
}

export interface CowColorParams {
  body: string;
  spot: string;
  horn: string;
  nose: string;
  eye: string;
}

export interface CowParams {
  torso: CowTorsoParams;
  head: CowHeadParams;
  legs: CowLegsParams;
  ears: CowEarParams;
  horns: CowHornParams;
  tail: CowTailParams;
  eyes: CowEyeParams;
  nostrils: CowNostrilParams;
  spots: CowSpotParams;
  colors: CowColorParams;
}

export type CharacterType = 'eggplant' | 'cow';

export interface ProjectData {
  version: number; // 現在 2
  unit: 'mm';
  characterType: CharacterType;
  referenceImages: ReferenceImage[];
  body: BodyParams;
  calyx: CalyxParams;
  stem: StemParams;
  eyes: EyeParams;
  mouth: MouthParams;
  colors: ColorParams;
  cow: CowParams;
  printSettings: PrintSettings;
  camera: CameraState;
  exportSettings: ExportSettings;
}

export const CURRENT_PROJECT_VERSION = 2;
