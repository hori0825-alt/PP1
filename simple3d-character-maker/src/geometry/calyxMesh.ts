import * as THREE from 'three';
import type { BodySection, CalyxLeaf, CalyxParams } from '../core/params';
import { buildBodySurface, type BodySurface } from './surface';
import { appendGridShell, fixOutwardWinding, type GridShellPoint } from './meshUtils';

export interface CalyxMeshResult {
  geometry: THREE.BufferGeometry;
  warnings: string[];
}

const DEG2RAD = Math.PI / 180;
const U_SEGMENTS = 10;
const V_SEGMENTS = 6;
const ROOT_BLEND = 0.12;
const TIP_START = 0.82;
const MIN_WIDTH_FRAC = 0.03;

function smoothstep(x: number): number {
  const c = Math.min(Math.max(x, 0), 1);
  return c * c * (3 - 2 * c);
}

/** 葉のシルエット（根元は0へ収束、先端は半円状に丸める）。 */
function widthFraction(u: number): number {
  let raw: number;
  if (u < ROOT_BLEND) {
    raw = smoothstep(u / ROOT_BLEND);
  } else if (u <= TIP_START) {
    raw = 1;
  } else {
    const phi = ((u - TIP_START) / (1 - TIP_START)) * (Math.PI / 2);
    raw = Math.cos(phi);
  }
  return Math.max(MIN_WIDTH_FRAC, raw);
}

function buildLeafGrid(leaf: CalyxLeaf, baseT: number, surface: BodySurface): GridShellPoint[][] {
  const centerAngleRad = leaf.angle * DEG2RAD;
  const pitchRad = Math.min(Math.max(leaf.pitch, 0), 89) * DEG2RAD;
  const curvature = Math.min(Math.max(leaf.curvature, 0), 1);

  const eps = 1e-4;
  const dzdtRaw =
    (surface.z(Math.min(baseT + eps, 1)) - surface.z(Math.max(baseT - eps, 0))) / (2 * eps);
  const dzdt = Math.abs(dzdtRaw) > 1e-3 ? dzdtRaw : 1;

  const grid: GridShellPoint[][] = [];
  for (let ui = 0; ui <= U_SEGMENTS; ui++) {
    const u = ui / U_SEGMENTS;
    const effectivePitch = pitchRad + curvature * u * (Math.PI / 2 - pitchRad);
    const verticalDropMm = leaf.length * u * Math.sin(effectivePitch);
    const t = Math.min(Math.max(baseT - verticalDropMm / dzdt, 0), baseT);

    const bodyRadius = Math.max((surface.rx(t) + surface.ry(t)) / 2, 0.5);
    const spreadMax = leaf.width / 2 / bodyRadius;
    const frac = widthFraction(u);

    const row: GridShellPoint[] = [];
    for (let vi = 0; vi <= V_SEGMENTS; vi++) {
      const v = (vi / V_SEGMENTS) * 2 - 1; // -1..1
      const theta = centerAngleRad + v * spreadMax * frac;
      const p = surface.point(t, theta);
      const n = surface.normal(t, theta);
      const pv = new THREE.Vector3(p.x, p.y, p.z);
      const nv = new THREE.Vector3(n.x, n.y, n.z);
      const outer = pv.clone().addScaledVector(nv, leaf.thickness / 2);
      const inner = pv.clone().addScaledVector(nv, -leaf.embed);
      row.push({ outer, inner });
    }
    grid.push(row);
  }
  return grid;
}

/**
 * ヘタ（5枚の葉）を生成する（開発指示書 6.2節）。
 * レイキャストは使わず、本体表面関数 S(t, θ) を直接評価して配置するため、
 * 本体の断面パラメータを変更すると自動的に追従する。
 */
export function buildCalyxMesh(
  calyx: CalyxParams,
  bodySections: readonly BodySection[],
): CalyxMeshResult {
  const warnings: string[] = [];
  const surface = buildBodySurface(bodySections);

  const positions: number[] = [];
  const indices: number[] = [];

  for (const leaf of calyx.leaves) {
    if (leaf.embed < 0.8) {
      warnings.push(`ヘタの埋め込み量が推奨範囲(0.8〜1.5mm)未満です: ${leaf.embed.toFixed(2)}mm`);
    }
    const grid = buildLeafGrid(leaf, calyx.baseT, surface);
    appendGridShell(grid, positions, indices);
  }

  fixOutwardWinding(positions, indices);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  return { geometry, warnings };
}
