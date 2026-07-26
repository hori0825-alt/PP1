import * as THREE from 'three';
import { configureZUp, GRID_MAJOR_STEP_MM, GRID_MINOR_STEP_MM } from '../core/units';

configureZUp();

export interface Simple3DScene {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  grid: THREE.Group;
  axes: THREE.AxesHelper;
  bodyGroup: THREE.Group;
}

function createGrid(sizeMm = 200): THREE.Group {
  const group = new THREE.Group();
  group.name = 'grid';

  const minorDivisions = Math.round(sizeMm / GRID_MINOR_STEP_MM);
  const minor = new THREE.GridHelper(sizeMm, minorDivisions, 0xdddddd, 0xeeeeee);
  minor.rotation.x = Math.PI / 2;
  minor.position.z = -0.02;

  const majorDivisions = Math.round(sizeMm / GRID_MAJOR_STEP_MM);
  const major = new THREE.GridHelper(sizeMm, majorDivisions, 0x999999, 0xbbbbbb);
  major.rotation.x = Math.PI / 2;

  group.add(minor, major);
  return group;
}

export function createScene(canvas: HTMLCanvasElement): Simple3DScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf2f2f2);

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  const directional = new THREE.DirectionalLight(0xffffff, 1.2);
  directional.position.set(80, -120, 150); // mm 単位。距離減衰なし（3.1節）
  scene.add(ambient, directional);

  const grid = createGrid();
  scene.add(grid);

  const axes = new THREE.AxesHelper(30);
  scene.add(axes);

  const bodyGroup = new THREE.Group();
  bodyGroup.name = 'characterRoot';
  scene.add(bodyGroup);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  return { scene, renderer, grid, axes, bodyGroup };
}
