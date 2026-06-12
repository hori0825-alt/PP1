// プロジェクトの保存/読み込み (JSON)。
// 画像・オブジェクト・縫い順・設定を保存し、再編集できるようにする。

import type { EmbObject, GlobalSettings } from "./object";

export interface ProjectJson {
  app: "pp1-stitch-studio";
  version: 2;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  settings: GlobalSettings;
  /** 元画像 (dataURL) */
  imageDataUrl: string | null;
  order: string[];
  objects: SerializedObject[];
}

interface SerializedObject {
  id: string;
  name: string;
  paletteIndex: number;
  ringsPx: number[][][];
  mask: { x0: number; y0: number; w: number; h: number; data: string } | null;
  estWidthMm: number;
  areaPx: number;
  settings: EmbObject["settings"];
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function serializeProject(
  name: string,
  id: string,
  settings: GlobalSettings,
  imageDataUrl: string | null,
  objects: EmbObject[],
  order: string[],
): ProjectJson {
  return {
    app: "pp1-stitch-studio",
    version: 2,
    id,
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings,
    imageDataUrl,
    order: [...order],
    objects: objects.map((o) => ({
      id: o.id,
      name: o.name,
      paletteIndex: o.paletteIndex,
      ringsPx: o.ringsPx.map((ring) => ring.map(([x, y]) => [x, y])),
      mask: o.mask
        ? { x0: o.mask.x0, y0: o.mask.y0, w: o.mask.w, h: o.mask.h, data: bytesToBase64(o.mask.data) }
        : null,
      estWidthMm: o.estWidthMm,
      areaPx: o.areaPx,
      settings: { ...o.settings },
    })),
  };
}

export function deserializeObjects(p: ProjectJson): { objects: EmbObject[]; order: string[] } {
  const objects: EmbObject[] = p.objects.map((s) => ({
    id: s.id,
    name: s.name,
    paletteIndex: s.paletteIndex,
    ringsPx: s.ringsPx.map((ring) => ring.map(([x, y]) => [x, y] as [number, number])),
    mask: s.mask
      ? { x0: s.mask.x0, y0: s.mask.y0, w: s.mask.w, h: s.mask.h, data: base64ToBytes(s.mask.data) }
      : null,
    estWidthMm: s.estWidthMm,
    areaPx: s.areaPx,
    settings: { ...s.settings },
  }));
  return { objects, order: [...p.order] };
}

export function newProjectId(): string {
  return `pp1-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}
