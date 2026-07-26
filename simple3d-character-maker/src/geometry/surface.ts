import type { BodySection } from '../core/params';
import { makeCatmullRomInterpolator } from '../core/spline';

/** Three.js に依存しない軽量な 3 次元点。 */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface BodySurface {
  rx(t: number): number;
  ry(t: number): number;
  cx(t: number): number;
  cy(t: number): number;
  z(t: number): number;
  n(t: number): number;
  /** 本体表面上の座標 S(t, θ) を返す（開発指示書 6.1節）。 */
  point(t: number, theta: number): Point3;
  /** S(t, θ) の法線を微小差分で近似する。 */
  normal(t: number, theta: number): Point3;
}

function superellipseComponent(theta: number, trig: (theta: number) => number, exponent: number): number {
  const v = trig(theta);
  return Math.sign(v) * Math.abs(v) ** exponent;
}

/**
 * 断面制御点（t の昇順、最低 2 点）から、本体表面を表す純関数群を構築する。
 * この関数はメッシュ生成だけでなく、ヘタ・茎・顔の配置からも呼び出される。
 */
export function buildBodySurface(sections: readonly BodySection[]): BodySurface {
  if (sections.length < 2) {
    throw new Error('buildBodySurface: sections には最低 2 点が必要です');
  }
  const ts = sections.map((s) => s.t);
  const rxFn = makeCatmullRomInterpolator(ts, sections.map((s) => s.rx));
  const ryFn = makeCatmullRomInterpolator(ts, sections.map((s) => s.ry));
  const cxFn = makeCatmullRomInterpolator(ts, sections.map((s) => s.cx));
  const cyFn = makeCatmullRomInterpolator(ts, sections.map((s) => s.cy));
  const zFn = makeCatmullRomInterpolator(ts, sections.map((s) => s.z));
  const nFn = makeCatmullRomInterpolator(ts, sections.map((s) => s.n));

  function point(t: number, theta: number): Point3 {
    const n = nFn(t);
    const exponent = 2 / n;
    const x = cxFn(t) + rxFn(t) * superellipseComponent(theta, Math.cos, exponent);
    const y = cyFn(t) + ryFn(t) * superellipseComponent(theta, Math.sin, exponent);
    return { x, y, z: zFn(t) };
  }

  function normal(t: number, theta: number): Point3 {
    const epsT = 1e-4;
    const epsTheta = 1e-4;
    const tLo = Math.max(0, t - epsT);
    const tHi = Math.min(1, t + epsT);
    const dtDenom = tHi - tLo || epsT * 2;

    const pT0 = point(tLo, theta);
    const pT1 = point(tHi, theta);
    const dT: Point3 = {
      x: (pT1.x - pT0.x) / dtDenom,
      y: (pT1.y - pT0.y) / dtDenom,
      z: (pT1.z - pT0.z) / dtDenom,
    };

    const pTh0 = point(t, theta - epsTheta);
    const pTh1 = point(t, theta + epsTheta);
    const dTheta: Point3 = {
      x: (pTh1.x - pTh0.x) / (2 * epsTheta),
      y: (pTh1.y - pTh0.y) / (2 * epsTheta),
      z: (pTh1.z - pTh0.z) / (2 * epsTheta),
    };

    // 法線 = dT × dTheta
    let nx = dT.y * dTheta.z - dT.z * dTheta.y;
    let ny = dT.z * dTheta.x - dT.x * dTheta.z;
    let nz = dT.x * dTheta.y - dT.y * dTheta.x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    // 外向き法線になるよう、中心から見た放射方向と同じ向きに揃える。
    const outward = { x: Math.cos(theta), y: Math.sin(theta), z: 0 };
    const dot = nx * outward.x + ny * outward.y + nz * outward.z;
    if (dot < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    return { x: nx, y: ny, z: nz };
  }

  return { rx: rxFn, ry: ryFn, cx: cxFn, cy: cyFn, z: zFn, n: nFn, point, normal };
}
