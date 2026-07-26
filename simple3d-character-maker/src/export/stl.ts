import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';

/** STL（バイナリ・mm等倍・Z-up・色なし形状確認用）を出力する（6.7節）。 */
export function exportStlBinary(root: THREE.Object3D): ArrayBuffer {
  const exporter = new STLExporter();
  const result = exporter.parse(root, { binary: true });
  // binary:true のとき STLExporter は DataView を返す
  const dataView = result as unknown as DataView;
  const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
  return bytes.slice().buffer;
}
