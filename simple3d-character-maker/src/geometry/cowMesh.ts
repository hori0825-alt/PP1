import * as THREE from 'three';
import type { CowLegParams, CowParams } from '../core/params';
import { buildCapsuleMesh } from './capsuleMesh';
import { buildBodySurface, type BodySurface } from './surface';
import { appendLensShellOnSurface, buildTaperedCylinder, fixOutwardWinding } from './meshUtils';

export interface CowMeshResult {
  geometry: THREE.BufferGeometry;
  warnings: string[];
}

/** 単一マテリアル方式のため、色ごとに5グループへまとめる（6.6節と同じ考え方）。 */
export interface CowMeshSet {
  body: CowMeshResult; // 胴体・頭・脚・耳・しっぽの軸（白）
  spots: CowMeshResult; // 斑点・しっぽの房（グレー）
  horns: CowMeshResult; // 角（タン）
  nose: CowMeshResult; // 鼻先パッチ・鼻孔（ピンク）
  eyes: CowMeshResult; // 目（黒）
}

const DEG2RAD = Math.PI / 180;
const FEATURE_EMBED_MM = 0.3;

function makeGeometry(positions: number[], indices: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function applyMatrixToArray(positions: number[], matrix: THREE.Matrix4): void {
  const v = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    v.set(positions[i]!, positions[i + 1]!, positions[i + 2]!);
    v.applyMatrix4(matrix);
    positions[i] = v.x;
    positions[i + 1] = v.y;
    positions[i + 2] = v.z;
  }
}

/** 側面(θ=0/π)から上方向(または負値で下方向)へ角度バイアスをかけた方位角を返す。 */
function sideThetaFromBiasDeg(side: 1 | -1, biasDeg: number): number {
  const biasRad = biasDeg * DEG2RAD;
  return side === 1 ? biasRad : Math.PI - biasRad;
}

interface AttachedTransform {
  point: (t: number, theta: number) => THREE.Vector3;
  normal: (t: number, theta: number) => THREE.Vector3;
  matrix: THREE.Matrix4;
}

function makeAttachedTransform(surface: BodySurface, matrix: THREE.Matrix4): AttachedTransform {
  return {
    point: (t, theta) => {
      const p = surface.point(t, theta);
      return new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(matrix);
    },
    normal: (t, theta) => {
      const n = surface.normal(t, theta);
      return new THREE.Vector3(n.x, n.y, n.z).transformDirection(matrix);
    },
    matrix,
  };
}

/**
 * 牛のジオメトリを組み立てる（開発指示書 8節）。
 * 胴体・頭は本体と同じ S(t, θ) 表現を capsuleMesh.ts で「浮いた」カプセルとして生成し、
 * ワールド X 軸まわりに +90°（＋首の傾き）回転させることで水平（前後 = ワールドY）向きにする。
 * 脚・角・しっぽ・耳・目・鼻孔は、この回転後の座標系で本体表面上の位置・法線を評価して配置するため、
 * 本体の断面を変更すると自動的に追従する。
 */
export function buildCowMesh(cow: CowParams): CowMeshSet {
  const warnings: string[] = [];

  // ---- 胴体 ----
  const torsoSurface = buildBodySurface(cow.torso.sections);
  const torsoRaw = buildCapsuleMesh({
    sections: cow.torso.sections,
    radialSegments: cow.torso.radialSegments,
    heightSamples: cow.torso.heightSamples,
  });
  warnings.push(...torsoRaw.warnings);

  const rotOnly = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  const rotatedProbe = torsoRaw.geometry.clone();
  rotatedProbe.applyMatrix4(rotOnly);
  rotatedProbe.computeBoundingBox();
  const rBbox = rotatedProbe.boundingBox!;

  const frontVisible = Math.max(0.1, cow.legs.front.length - cow.legs.front.embed);
  const backVisible = Math.max(0.1, cow.legs.back.length - cow.legs.back.embed);
  const groundClearance = Math.max(frontVisible, backVisible);

  const dz = groundClearance - rBbox.min.z;
  const dy = -(rBbox.min.y + rBbox.max.y) / 2;

  const torsoMatrix = rotOnly.clone();
  torsoMatrix.setPosition(0, dy, dz);

  const torsoGeom = torsoRaw.geometry.clone();
  torsoGeom.applyMatrix4(torsoMatrix);
  torsoGeom.computeVertexNormals();

  const torsoWorld = makeAttachedTransform(torsoSurface, torsoMatrix);

  // ---- 頭 ----
  const headSurface = buildBodySurface(cow.head.sections);
  const headRaw = buildCapsuleMesh({
    sections: cow.head.sections,
    radialSegments: cow.head.radialSegments,
    heightSamples: cow.head.heightSamples,
  });
  warnings.push(...headRaw.warnings);

  const headTiltRad = cow.head.tilt * DEG2RAD;
  const headRotOnly = new THREE.Matrix4().makeRotationX(Math.PI / 2 + headTiltRad);
  const localNeck = new THREE.Vector3(headSurface.cx(0), headSurface.cy(0), headSurface.z(0));
  const rotatedNeck = localNeck.clone().applyMatrix4(headRotOnly);
  // 胸側(t=1)は capsuleMesh 側で1点(cx(1), cy(1), z(1))に収束させて閉じているため、
  // その収束点をワールド変換したものを付け根の中心として使う（θ=0 の断面上の点は
  // 中心ではなく側面の縁になってしまい、頭が左右にずれてしまう）。
  const chestLocal = new THREE.Vector3(torsoSurface.cx(1), torsoSurface.cy(1), torsoSurface.z(1));
  const chestWorld = chestLocal.clone().applyMatrix4(torsoMatrix);
  const headTranslation = chestWorld.clone().sub(rotatedNeck);
  const headMatrix = headRotOnly.clone();
  headMatrix.setPosition(headTranslation.x, headTranslation.y, headTranslation.z);

  const headGeom = headRaw.geometry.clone();
  headGeom.applyMatrix4(headMatrix);
  headGeom.computeVertexNormals();

  const headWorld = makeAttachedTransform(headSurface, headMatrix);

  // ---- 脚（4本）----
  const DOWN_THETA = -Math.PI / 2;
  const legPositions: number[] = [];
  const legIndices: number[] = [];

  function addLeg(t: number, side: 1 | -1, leg: CowLegParams): void {
    const bodyRadiusAtT = Math.max((torsoSurface.rx(t) + torsoSurface.ry(t)) / 2, 1);
    const halfAngle = cow.legs.spacingX / 2 / bodyRadiusAtT;
    const theta = DOWN_THETA + side * halfAngle;
    const origin = torsoWorld.point(t, theta);
    const direction = torsoWorld.normal(t, theta);
    // 胴体の断面（腹の高さ）は付け根の t によって変わるため、脚の可視長を
    // 「地面(z=0)に接するのに必要な長さ」と「パラメータで指定された長さ」の
    // 大きい方に自動延長し、テーパー形状によらず必ず接地するようにする。
    // 脚は傾く（direction が真下からずれる）ため、実際に地面へ最も深く食い込む
    // のは中心軸の到達点ではなく先端手前のリング（半径分だけ余計に沈む）になる。
    // 中心軸の到達長を初期値とし、実測した最下点が地面を突き抜けていたら
    // その分だけ短くする方向に補正する（数値的に収束させる）。
    const specifiedVisible = Math.max(leg.length - leg.embed, 0.1);
    const centerReach = direction.z < -1e-6 ? origin.z / -direction.z : specifiedVisible;
    let visibleLength = Math.max(specifiedVisible, centerReach);
    const minAllowed = Math.max(specifiedVisible * 0.3, leg.radius, 0.5);
    let built = buildTaperedCylinder({
      origin,
      direction,
      length: visibleLength + leg.embed,
      radiusStart: leg.radius,
      radiusEnd: leg.radius,
      embed: leg.embed,
      squash: leg.squash,
      distortion: leg.distortion,
      radialSegments: 12,
      heightSegments: 4,
    });
    if (direction.z < -1e-6) {
      for (let iter = 0; iter < 4; iter++) {
        let minZ = Infinity;
        for (let i = 2; i < built.positions.length; i += 3) {
          if (built.positions[i]! < minZ) minZ = built.positions[i]!;
        }
        if (minZ >= -1e-3) break;
        visibleLength = Math.max(minAllowed, visibleLength - -minZ / -direction.z);
        built = buildTaperedCylinder({
          origin,
          direction,
          length: visibleLength + leg.embed,
          radiusStart: leg.radius,
          radiusEnd: leg.radius,
          embed: leg.embed,
          squash: leg.squash,
          distortion: leg.distortion,
          radialSegments: 12,
          heightSegments: 4,
        });
      }
    }
    const { positions, indices } = built;
    const offset = legPositions.length / 3;
    legPositions.push(...positions);
    legIndices.push(...indices.map((i) => i + offset));
  }
  addLeg(cow.legs.frontT, 1, cow.legs.front);
  addLeg(cow.legs.frontT, -1, cow.legs.front);
  addLeg(cow.legs.backT, 1, cow.legs.back);
  addLeg(cow.legs.backT, -1, cow.legs.back);
  fixOutwardWinding(legPositions, legIndices);
  const legsGeom = makeGeometry(legPositions, legIndices);

  if (Math.min(cow.legs.front.radius, cow.legs.back.radius) < 0.5) {
    warnings.push('脚の半径が印刷業者の確定最小値(0.5mm)を下回り危険です。');
  }

  // ---- 耳（本体色）----
  const earPositions: number[] = [];
  const earIndices: number[] = [];
  for (const side of [1, -1] as const) {
    const theta = sideThetaFromBiasDeg(side, cow.ears.spacing);
    const tiltRad = side * cow.ears.tilt * DEG2RAD;
    appendLensShellOnSurface(
      headSurface,
      cow.ears.attachHeight,
      theta,
      tiltRad,
      cow.ears.sizeX,
      cow.ears.sizeY,
      cow.ears.relief,
      FEATURE_EMBED_MM,
      earPositions,
      earIndices,
    );
  }
  fixOutwardWinding(earPositions, earIndices);
  applyMatrixToArray(earPositions, headMatrix);
  const earsGeom = makeGeometry(earPositions, earIndices);

  // ---- しっぽ（軸）----
  const tailTiltRad = cow.tail.tilt * DEG2RAD;
  const tailBaseWorld = torsoWorld.point(0, Math.PI);
  const tailDirBase = new THREE.Vector3(0, 0, -1).transformDirection(torsoMatrix);
  const tailDir = tailDirBase.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), -tailTiltRad);

  const { positions: tailPos, indices: tailIdx } = buildTaperedCylinder({
    origin: tailBaseWorld,
    direction: tailDir,
    length: cow.tail.length,
    radiusStart: cow.tail.radius,
    radiusEnd: cow.tail.radius * 0.7,
    embed: 1.5,
    distortion: cow.tail.distortion,
    radialSegments: 10,
    heightSegments: 5,
  });
  fixOutwardWinding(tailPos, tailIdx);
  const tailShaftGeom = makeGeometry(tailPos, tailIdx);

  if (cow.tail.radius < 0.5) {
    warnings.push('しっぽの半径が印刷業者の確定最小値(0.5mm)を下回り危険です。');
  }

  // ---- 角（タン）----
  const hornPositions: number[] = [];
  const hornIndices: number[] = [];
  for (const side of [1, -1] as const) {
    const theta = sideThetaFromBiasDeg(side, cow.horns.spacing);
    const origin = headWorld.point(cow.horns.attachHeight, theta);
    const outward = headWorld.normal(cow.horns.attachHeight, theta);
    const tiltRad = cow.horns.tilt * DEG2RAD;
    const direction = outward.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), side * tiltRad);
    const { positions, indices } = buildTaperedCylinder({
      origin,
      direction,
      length: cow.horns.length,
      radiusStart: cow.horns.radiusStart,
      radiusEnd: cow.horns.radiusEnd,
      embed: 1,
      radialSegments: 10,
      heightSegments: 4,
    });
    const offset = hornPositions.length / 3;
    hornPositions.push(...positions);
    hornIndices.push(...indices.map((i) => i + offset));
  }
  fixOutwardWinding(hornPositions, hornIndices);
  const hornsGeom = makeGeometry(hornPositions, hornIndices);

  // ---- しっぽの房（グレー）----
  const tuftSections = [
    { t: 0, z: 0, rx: 0.5, ry: 0.5, cx: 0, cy: 0, n: 2.2 },
    { t: 0.5, z: cow.tail.tuftSize, rx: cow.tail.tuftSize, ry: cow.tail.tuftSize, cx: 0, cy: 0, n: 2 },
    { t: 1, z: cow.tail.tuftSize * 2, rx: 0.5, ry: 0.5, cx: 0, cy: 0, n: 2.2 },
  ];
  const tuftRaw = buildCapsuleMesh({ sections: tuftSections, radialSegments: 12, heightSamples: 8 });
  const tailTipWorld = tailBaseWorld.clone().addScaledVector(tailDir, cow.tail.length);
  const tuftQuat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    tailDir.clone().normalize(),
  );
  const tuftRotMatrix = new THREE.Matrix4().makeRotationFromQuaternion(tuftQuat);
  const tuftRotatedBase = new THREE.Vector3(0, 0, 0).applyMatrix4(tuftRotMatrix);
  const tuftTranslation = tailTipWorld.clone().sub(tuftRotatedBase);
  const tuftMatrix = tuftRotMatrix.clone();
  tuftMatrix.setPosition(tuftTranslation.x, tuftTranslation.y, tuftTranslation.z);
  const tuftGeom = tuftRaw.geometry.clone();
  tuftGeom.applyMatrix4(tuftMatrix);
  tuftGeom.computeVertexNormals();

  const spotAndTuftGeoms = [tuftGeom];

  // ---- 斑点（色のみのグレー模様。8節）----
  // 実ジオメトリを持つ小さなパッチとして胴体表面へ配置する（UVをアトラス上の
  // 単色パッチへ収束させる既存方式と両立させるため）。
  let seed = cow.spots.seed >>> 0 || 1;
  function nextRandom(): number {
    // mulberry32
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const spotPositions: number[] = [];
  const spotIndices: number[] = [];
  for (let i = 0; i < cow.spots.count; i++) {
    const t = 0.1 + nextRandom() * 0.8;
    const theta = nextRandom() * Math.PI * 2;
    const size = cow.spots.minSize + nextRandom() * (cow.spots.maxSize - cow.spots.minSize);
    appendLensShellOnSurface(
      torsoSurface,
      t,
      theta,
      nextRandom() * Math.PI * 2,
      size,
      size * (0.7 + nextRandom() * 0.3),
      0.2,
      FEATURE_EMBED_MM,
      spotPositions,
      spotIndices,
    );
  }
  fixOutwardWinding(spotPositions, spotIndices);
  applyMatrixToArray(spotPositions, torsoMatrix);
  spotAndTuftGeoms.push(makeGeometry(spotPositions, spotIndices));

  // ---- 目（黒）----
  const eyePositions: number[] = [];
  const eyeIndices: number[] = [];
  for (const side of [1, -1] as const) {
    const theta = sideThetaFromBiasDeg(side, cow.eyes.spacing);
    appendLensShellOnSurface(
      headSurface,
      cow.eyes.height,
      theta,
      0,
      cow.eyes.sizeX,
      cow.eyes.sizeY,
      cow.eyes.relief,
      FEATURE_EMBED_MM,
      eyePositions,
      eyeIndices,
    );
  }
  fixOutwardWinding(eyePositions, eyeIndices);
  applyMatrixToArray(eyePositions, headMatrix);
  const eyesGeom = makeGeometry(eyePositions, eyeIndices);

  // ---- 鼻先パッチ + 鼻孔（ピンク）----
  const nosePositions: number[] = [];
  const noseIndices: number[] = [];
  // 鼻先全体のパッチ（下地）。
  // 鼻先の極(t=1)に近すぎると tangentPlaneToSurface の接平面近似が破綻して
  // 自己交差する（頭表面がほぼ一点に収束するため）。鼻孔の高さから十分下げて配置する。
  appendLensShellOnSurface(
    headSurface,
    Math.max(cow.nostrils.height - 0.15, 0),
    -Math.PI / 2,
    0,
    3,
    2.5,
    0.1,
    FEATURE_EMBED_MM,
    nosePositions,
    noseIndices,
  );
  for (const side of [1, -1] as const) {
    const theta = sideThetaFromBiasDeg(side, cow.nostrils.spacing);
    appendLensShellOnSurface(
      headSurface,
      cow.nostrils.height,
      theta,
      0,
      cow.nostrils.size,
      cow.nostrils.size,
      cow.nostrils.relief,
      FEATURE_EMBED_MM,
      nosePositions,
      noseIndices,
    );
  }
  fixOutwardWinding(nosePositions, noseIndices);
  applyMatrixToArray(nosePositions, headMatrix);
  const noseGeom = makeGeometry(nosePositions, noseIndices);

  // ---- 「body」グループへ結合（胴体・頭・脚・耳・しっぽの軸）----
  const bodyGeoms = [torsoGeom, headGeom, legsGeom, earsGeom, tailShaftGeom];
  const bodyPositions: number[] = [];
  const bodyIndices: number[] = [];
  for (const g of bodyGeoms) {
    const pos = g.getAttribute('position');
    const idx = g.getIndex()!;
    const base = bodyPositions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      bodyPositions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    for (let i = 0; i < idx.count; i++) {
      bodyIndices.push(idx.array[i]! + base);
    }
  }
  const bodyGeom = makeGeometry(bodyPositions, bodyIndices);

  const spotPositions2: number[] = [];
  const spotIndices2: number[] = [];
  for (const g of spotAndTuftGeoms) {
    const pos = g.getAttribute('position');
    const idx = g.getIndex()!;
    const base = spotPositions2.length / 3;
    for (let i = 0; i < pos.count; i++) {
      spotPositions2.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    for (let i = 0; i < idx.count; i++) {
      spotIndices2.push(idx.array[i]! + base);
    }
  }
  const spotsGeom = makeGeometry(spotPositions2, spotIndices2);

  return {
    body: { geometry: bodyGeom, warnings },
    spots: { geometry: spotsGeom, warnings: [] },
    horns: { geometry: hornsGeom, warnings: [] },
    nose: { geometry: noseGeom, warnings: [] },
    eyes: { geometry: eyesGeom, warnings: [] },
  };
}
