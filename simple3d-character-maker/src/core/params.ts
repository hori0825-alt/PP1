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

export interface ProjectData {
  version: number; // 現在 1
  unit: 'mm';
  referenceImages: ReferenceImage[];
  body: BodyParams;
  calyx: CalyxParams;
  stem: StemParams;
  eyes: EyeParams;
  mouth: MouthParams;
  colors: ColorParams;
  printSettings: PrintSettings;
  camera: CameraState;
  exportSettings: ExportSettings;
}

export const CURRENT_PROJECT_VERSION = 1;
