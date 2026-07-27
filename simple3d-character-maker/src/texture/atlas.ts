/**
 * 単一マテリアル・単一テクスチャアトラス方式（開発指示書 6.6節）。
 * three.js の OBJExporter はマテリアルを MTL に出力できず、複数の子オブジェクトも
 * 1つのメッシュに統合されるため、全パーツを1つのマテリアル(simple3d_main)に統一する。
 * 各パーツの UV はここで定義するパッチ中心の1点近傍に収束させ、ベタ塗りにする。
 */

export const ATLAS_SIZE = 2048;
export const ATLAS_MARGIN_PX = 8;

export interface AtlasPatch {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type PartKey =
  | 'body'
  | 'calyx'
  | 'stem'
  | 'eye'
  | 'mouth'
  | 'cowBody'
  | 'cowSpots'
  | 'cowHorns'
  | 'cowNose'
  | 'cowEyes';

export const ATLAS_PATCHES: Record<PartKey, AtlasPatch> = {
  body: { x0: 0, y0: 0, x1: 1024, y1: 1024 },
  calyx: { x0: 1024, y0: 0, x1: 1536, y1: 512 },
  stem: { x0: 1536, y0: 0, x1: 1792, y1: 256 },
  eye: { x0: 1024, y0: 512, x1: 1280, y1: 768 },
  mouth: { x0: 1280, y0: 512, x1: 1536, y1: 768 },
  // 牛（8節）: ナスと共存できるよう、まだ使われていない下半分に配置する。
  cowBody: { x0: 0, y0: 1024, x1: 1024, y1: 2048 },
  cowSpots: { x0: 1024, y0: 1024, x1: 1536, y1: 1536 },
  cowHorns: { x0: 1536, y0: 1024, x1: 1792, y1: 1280 },
  cowNose: { x0: 1024, y0: 1536, x1: 1536, y1: 2048 },
  cowEyes: { x0: 1536, y0: 1280, x1: 1792, y1: 1536 },
};

/** パッチ中心の UV 座標（0..1）を返す。ベタ塗りのため境界からの多少のずれは影響しない。 */
export function patchCenterUV(patch: AtlasPatch): { u: number; v: number } {
  const cx = (patch.x0 + patch.x1) / 2;
  const cy = (patch.y0 + patch.y1) / 2;
  return { u: cx / ATLAS_SIZE, v: 1 - cy / ATLAS_SIZE };
}

/** パッチの塗りつぶし矩形（外周 8px マージンを除いた内側の領域）。 */
export function patchFillRect(patch: AtlasPatch): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: patch.x0 + ATLAS_MARGIN_PX,
    y: patch.y0 + ATLAS_MARGIN_PX,
    width: patch.x1 - patch.x0 - 2 * ATLAS_MARGIN_PX,
    height: patch.y1 - patch.y0 - 2 * ATLAS_MARGIN_PX,
  };
}
