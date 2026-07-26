import * as THREE from 'three';
import type { ReferenceImage } from '../core/params';

export interface ReferencePlaneHandle {
  readonly carrier: THREE.Group;
  readonly imageWidthPx: number;
  readonly imageHeightPx: number;
  /** ラスタライズ後の画像上でクリックした位置から UV (0..1) を得るための Raycaster 対象。 */
  readonly mesh: THREE.Mesh;
  update(ref: ReferenceImage): void;
  dispose(): void;
}

const textureLoader = new THREE.TextureLoader();

/**
 * 参照画像を読み込み、1px = 1mm を基準サイズとする平面を作る。
 * carrier（ビューごとの固定姿勢）の子として mesh（ユーザー調整可能な変換）を持つ。
 * 常に depthTest を無効にして描画するため、本体メッシュの前後関係を気にせず
 * 半透明の下敷きとして常に見える（Blender のリファレンス画像と同様の方式）。
 */
export function createReferencePlane(ref: ReferenceImage): Promise<ReferencePlaneHandle> {
  return new Promise((resolve, reject) => {
    textureLoader.load(
      ref.dataUrl,
      (texture) => {
        const img = texture.image as HTMLImageElement;
        const w = img.naturalWidth || img.width || 100;
        const h = img.naturalHeight || img.height || 100;

        const geometry = new THREE.PlaneGeometry(w, h);
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = -1;

        const carrier = new THREE.Group();
        applyBaseOrientation(carrier, ref.view);
        carrier.add(mesh);

        applyUserTransform(mesh, material, ref);

        resolve({
          carrier,
          mesh,
          imageWidthPx: w,
          imageHeightPx: h,
          update: (r) => applyUserTransform(mesh, material, r),
          dispose: () => {
            geometry.dispose();
            material.dispose();
            texture.dispose();
          },
        });
      },
      undefined,
      reject,
    );
  });
}

function applyBaseOrientation(carrier: THREE.Group, view: ReferenceImage['view']): void {
  carrier.position.set(0, 0, 0);
  if (view === 'front') {
    // 平面の法線が -Y（正面カメラ側）を向くようにする。
    carrier.rotation.set(Math.PI / 2, 0, 0);
  } else if (view === 'side') {
    // 平面の法線が +X（右側面カメラ側）を向くようにする。
    carrier.rotation.set(0, Math.PI / 2, 0);
  } else {
    // top: 平面の法線はそのまま +Z（上面カメラ側）。
    carrier.rotation.set(0, 0, 0);
  }
}

function applyUserTransform(
  mesh: THREE.Mesh,
  material: THREE.MeshBasicMaterial,
  ref: ReferenceImage,
): void {
  mesh.visible = ref.visible;
  material.opacity = ref.opacity;
  mesh.position.set(ref.offset.x, ref.offset.y, 0);
  mesh.rotation.z = (ref.rotation * Math.PI) / 180;
  mesh.scale.set((ref.flipX ? -1 : 1) * ref.scale, ref.scale, 1);
}

export interface CalibrationResult {
  scale: number;
}

/**
 * キャリブレーション：画像上の2点間の実寸(mm)から scale を算出する（6.5節）。
 * uv1, uv2 は Raycaster の intersection.uv（0..1、テクスチャの向きに一致）。
 */
export function computeCalibrationScale(
  uv1: { x: number; y: number },
  uv2: { x: number; y: number },
  imageWidthPx: number,
  imageHeightPx: number,
  realLengthMm: number,
): CalibrationResult {
  const du = (uv2.x - uv1.x) * imageWidthPx;
  const dv = (uv2.y - uv1.y) * imageHeightPx;
  const pixelDistanceMm = Math.hypot(du, dv); // 1px = 1mm 基準の平面上での距離
  if (pixelDistanceMm < 1e-6) {
    throw new Error('2点が近すぎます。離れた2点をクリックしてください。');
  }
  return { scale: realLengthMm / pixelDistanceMm };
}
