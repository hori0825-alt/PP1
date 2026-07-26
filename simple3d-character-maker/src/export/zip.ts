import { zipSync, type Zippable } from 'fflate';

export interface ZipContents {
  objText: string;
  mtlText: string;
  pngBytes: Uint8Array;
  glbBytes: Uint8Array;
  stlBytes: Uint8Array;
  projectJson: string;
  printCheckText: string;
  readmeText: string;
}

/**
 * ZIP 一括ダウンロード（6.7節）。サブフォルダを作らず、ルート直下に並べる。
 */
export function buildExportZip(contents: ZipContents): Uint8Array {
  const encoder = new TextEncoder();
  const files: Zippable = {
    'model.obj': encoder.encode(contents.objText),
    'model.mtl': encoder.encode(contents.mtlText),
    'texture.png': contents.pngBytes,
    'model.glb': contents.glbBytes,
    'model.stl': contents.stlBytes,
    'project.json': encoder.encode(contents.projectJson),
    'print_check.txt': encoder.encode(contents.printCheckText),
    'README_print.txt': encoder.encode(contents.readmeText),
  };
  return zipSync(files, { level: 6 });
}
