import { describe, expect, it } from 'vitest';
import { buildBodyMesh } from '../src/geometry/bodyMesh';
import { buildCalyxMesh } from '../src/geometry/calyxMesh';
import { buildStemMesh } from '../src/geometry/stemMesh';
import { buildEyeMesh, buildMouthMesh } from '../src/geometry/faceMesh';
import {
  runPrintChecks,
  approximateMinWallThickness,
  type CheckInput,
} from '../src/inspect/checks';
import { createDefaultProjectData } from '../src/presets/eggplant';

function buildInput(project = createDefaultProjectData()): CheckInput {
  const body = buildBodyMesh(project.body);
  const calyx = buildCalyxMesh(project.calyx, project.body.sections);
  const stem = buildStemMesh(project.stem, project.body.sections);
  const eyes = buildEyeMesh(project.eyes, project.body.sections);
  const mouth = buildMouthMesh(project.mouth, project.body.sections);
  return {
    bodyGeometry: body.geometry,
    calyxGeometry: calyx.geometry,
    stemGeometry: stem.geometry,
    eyeGeometry: eyes.geometry,
    mouthGeometry: mouth.geometry,
    project,
    textureReady: true,
  };
}

describe('runPrintChecks (eggplant preset, default params)', () => {
  it('reports all-green for topology checks on the default well-formed model', () => {
    const results = runPrintChecks(buildInput());
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get('boundary-edges')!.severity).toBe('green');
    expect(byId.get('non-manifold-edges')!.severity).toBe('green');
    expect(byId.get('normal-consistency')!.severity).toBe('green');
    expect(byId.get('degenerate-triangles')!.severity).toBe('green');
    expect(byId.get('ground-contact')!.severity).toBe('green');
    expect(byId.get('texture')!.severity).toBe('green');
  });

  it('flags missing texture as red', () => {
    const input = buildInput();
    input.textureReady = false;
    const results = runPrintChecks(input);
    expect(results.find((r) => r.id === 'texture')!.severity).toBe('red');
  });

  it('flags a too-thin stem as red/yellow depending on severity', () => {
    const project = createDefaultProjectData();
    project.stem.radius = 0.5;
    const results = runPrintChecks(buildInput(project));
    expect(results.find((r) => r.id === 'min-diameter')!.severity).toBe('red');
  });

  it('flags a height mismatch between AABB and specified totalHeight', () => {
    const project = createDefaultProjectData();
    // 断面のzを変えず totalHeight だけずらして矛盾を作る
    project.body.totalHeight = 999;
    const results = runPrintChecks(buildInput(project));
    expect(results.find((r) => r.id === 'dimensions')!.severity).toBe('yellow');
  });

  it('flags insufficient calyx embed as yellow/red', () => {
    const project = createDefaultProjectData();
    project.calyx.leaves.forEach((l) => (l.embed = 0));
    const results = runPrintChecks(buildInput(project));
    expect(results.find((r) => r.id === 'intersection-depth')!.severity).toBe('red');
  });
});

describe('approximateMinWallThickness', () => {
  it('returns a finite positive number for the default eggplant body', () => {
    const project = createDefaultProjectData();
    const body = buildBodyMesh(project.body);
    const thickness = approximateMinWallThickness(body.geometry);
    expect(Number.isFinite(thickness)).toBe(true);
    expect(thickness).toBeGreaterThan(0);
  });
});
