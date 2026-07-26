import * as THREE from 'three';
import { CAMERA_FAR, CAMERA_INITIAL_DISTANCE_MM, CAMERA_NEAR } from '../core/units';
import type { ViewName } from '../core/params';

type FixedView = Exclude<ViewName, 'perspective'>;

const VIEW_DIRECTIONS: Record<FixedView, THREE.Vector3> = {
  front: new THREE.Vector3(0, -1, 0), // -Y が手前＝正面側（3.2節）
  back: new THREE.Vector3(0, 1, 0),
  side: new THREE.Vector3(1, 0, 0), // 右側面
  top: new THREE.Vector3(0, 0, 1),
};

const VIEW_UPS: Record<FixedView, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, 1),
  side: new THREE.Vector3(0, 0, 1),
  top: new THREE.Vector3(0, 1, 0),
};

const PERSPECTIVE_VIEW_DIRECTION = new THREE.Vector3(1, -1, 0.7).normalize();

/** 透視・平行投影カメラを一体で管理し、正面・側面・上面などの定型ビューへ切り替える。 */
export class ViewerCameraRig {
  readonly perspective: THREE.PerspectiveCamera;
  readonly orthographic: THREE.OrthographicCamera;

  private orthoMode = false;
  private distanceMm = CAMERA_INITIAL_DISTANCE_MM;
  private target = new THREE.Vector3(0, 0, 25);
  private aspect = 1;
  private currentView: ViewName = 'perspective';

  constructor() {
    this.perspective = new THREE.PerspectiveCamera(45, 1, CAMERA_NEAR, CAMERA_FAR);
    this.orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, CAMERA_NEAR, CAMERA_FAR);
    this.setView('perspective');
  }

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.orthoMode ? this.orthographic : this.perspective;
  }

  get isOrthographic(): boolean {
    return this.orthoMode;
  }

  get view(): ViewName {
    return this.currentView;
  }

  setTarget(target: THREE.Vector3): void {
    this.target.copy(target);
    this.setView(this.currentView);
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    this.updateOrthoFrustum();
  }

  setDistance(distanceMm: number): void {
    this.distanceMm = distanceMm;
    this.setView(this.currentView);
  }

  setOrthographic(enabled: boolean): void {
    this.orthoMode = enabled;
    this.updateOrthoFrustum();
  }

  setView(view: ViewName): void {
    this.currentView = view;
    if (view === 'perspective') {
      const pos = this.target.clone().addScaledVector(PERSPECTIVE_VIEW_DIRECTION, this.distanceMm);
      for (const cam of [this.perspective, this.orthographic]) {
        cam.up.set(0, 0, 1);
        cam.position.copy(pos);
        cam.lookAt(this.target);
      }
      return;
    }
    const dir = VIEW_DIRECTIONS[view];
    const up = VIEW_UPS[view];
    const pos = this.target.clone().addScaledVector(dir, this.distanceMm);
    for (const cam of [this.perspective, this.orthographic]) {
      cam.up.copy(up);
      cam.position.copy(pos);
      cam.lookAt(this.target);
    }
  }

  private updateOrthoFrustum(): void {
    const halfHeight = this.distanceMm * 0.5;
    const halfWidth = halfHeight * this.aspect;
    this.orthographic.left = -halfWidth;
    this.orthographic.right = halfWidth;
    this.orthographic.top = halfHeight;
    this.orthographic.bottom = -halfHeight;
    this.orthographic.updateProjectionMatrix();
  }
}
