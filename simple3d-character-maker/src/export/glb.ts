import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

/**
 * GLB を出力する（6.7節・3.3節）。
 * 既定では glTF 仕様に合わせて mm→m（0.001倍）・Z-up→Y-up に変換する。
 * exportSettings.glbMmZUp が true の場合のみ、mm・Z-up のまま出力する。
 */
export async function exportGlbBinary(root: THREE.Object3D, glbMmZUp: boolean): Promise<ArrayBuffer> {
  const wrapper = new THREE.Group();
  wrapper.add(root.clone(true));

  if (!glbMmZUp) {
    wrapper.rotation.x = -Math.PI / 2; // Z-up -> Y-up
    wrapper.scale.setScalar(0.001); // mm -> m
  }
  wrapper.updateMatrixWorld(true);

  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(wrapper, { binary: true });
  if (result instanceof ArrayBuffer) {
    return result;
  }
  // binary:true を指定しているため通常はここに来ないが、型の都合でフォールバックする
  return new TextEncoder().encode(JSON.stringify(result)).buffer as ArrayBuffer;
}
