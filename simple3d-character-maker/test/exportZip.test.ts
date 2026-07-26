import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { buildExportZip } from '../src/export/zip';

describe('buildExportZip', () => {
  it('bundles all required files at the root (no subfolders)', () => {
    const zipBytes = buildExportZip({
      objText: 'mtllib model.mtl\nusemtl simple3d_main\nv 0 0 0\nf 1 1 1',
      mtlText: 'newmtl simple3d_main\nmap_Kd texture.png\n',
      pngBytes: new Uint8Array([137, 80, 78, 71]), // dummy PNG-ish bytes
      glbBytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
      stlBytes: new Uint8Array(84),
      projectJson: '{"version":1}',
      printCheckText: 'OK',
      readmeText: 'readme',
    });

    const entries = unzipSync(zipBytes);
    const names = Object.keys(entries).sort();
    expect(names).toEqual(
      [
        'README_print.txt',
        'model.glb',
        'model.mtl',
        'model.obj',
        'model.stl',
        'print_check.txt',
        'project.json',
        'texture.png',
      ].sort(),
    );
    for (const name of names) {
      expect(name.includes('/')).toBe(false);
    }
    expect(new TextDecoder().decode(entries['model.obj'])).toContain('mtllib model.mtl');
  });
});
