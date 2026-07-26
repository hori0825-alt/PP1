import { describe, expect, it } from 'vitest';
import { deserializeProject, serializeProject } from '../src/state/persistence';
import { createDefaultProjectData } from '../src/presets/eggplant';
import { ProjectVersionError } from '../src/core/migrate';
import { CURRENT_PROJECT_VERSION } from '../src/core/params';

describe('project JSON persistence', () => {
  it('round-trips a project through serialize/deserialize', () => {
    const project = createDefaultProjectData();
    project.body.totalHeight = 42;
    const json = serializeProject(project);
    const restored = deserializeProject(json);
    expect(restored.body.totalHeight).toBe(42);
    expect(restored.version).toBe(CURRENT_PROJECT_VERSION);
  });

  it('rejects a project JSON with a newer version than supported', () => {
    const project = createDefaultProjectData();
    const json = JSON.stringify({ ...project, version: CURRENT_PROJECT_VERSION + 1 });
    expect(() => deserializeProject(json)).toThrow(ProjectVersionError);
  });
});
