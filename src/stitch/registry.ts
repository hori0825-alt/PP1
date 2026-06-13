// ステッチジェネレーターのレジストリ。
// 将来の高度なフィル (Wave/Spiral/Radial/Motif 等) はここに登録して追加する。

import { SATIN_DEFAULT, TATAMI_DEFAULT } from "../core/constants";
import type { Region } from "../core/region";
import { satinFromRegion } from "./satin";
import { tatamiFill } from "./tatami";
import type { GeneratorResult, SatinParams, StitchGenerator, TatamiParams } from "./types";

const generators = new Map<string, StitchGenerator>();

export function registerGenerator(name: string, gen: StitchGenerator): void {
  generators.set(name, gen);
}

export function getGenerator(name: string): StitchGenerator | undefined {
  return generators.get(name);
}

export function listGenerators(): string[] {
  return [...generators.keys()];
}

// --- 標準ジェネレーターの登録 ---

registerGenerator("tatami", (region: Region, params: unknown): GeneratorResult => {
  const p = params as Partial<TatamiParams> | undefined;
  return tatamiFill(region, {
    angleDeg: p?.angleDeg ?? 45,
    rowSpacing: p?.rowSpacing ?? TATAMI_DEFAULT.rowSpacing,
    stitchLength: p?.stitchLength ?? TATAMI_DEFAULT.stitchLength,
  });
});

registerGenerator("satin", (region: Region, params: unknown): GeneratorResult => {
  const p = params as Partial<SatinParams> | undefined;
  return satinFromRegion(region, {
    spacing: p?.spacing ?? SATIN_DEFAULT.spacing,
    maxWidth: p?.maxWidth ?? SATIN_DEFAULT.maxWidth,
  });
});
