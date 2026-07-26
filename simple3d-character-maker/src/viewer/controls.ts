import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** OrbitControls をラップし、透視/平行投影カメラの切り替え時に対象カメラを再バインドする。 */
export class ViewerControls {
  private controls: OrbitControls;

  constructor(camera: THREE.Camera, domElement: HTMLElement, target: THREE.Vector3) {
    this.controls = new OrbitControls(camera, domElement);
    this.controls.target.copy(target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.update();
  }

  rebind(camera: THREE.Camera): void {
    this.controls.object = camera;
    this.controls.update();
  }

  setTarget(target: THREE.Vector3): void {
    this.controls.target.copy(target);
    this.controls.update();
  }

  update(): void {
    this.controls.update();
  }

  dispose(): void {
    this.controls.dispose();
  }
}
