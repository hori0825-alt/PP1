// PES (v1) エクスポーター。
// PP1 / Artspira が読むのは内部の PEC ブロックなので、PES ラッパーは
// 最小構成 (CEmbOne/CSewSeg セクションなし) とし、糸色は PEC のパレットで保持する。
//
// レイアウト:
//   0x00: "#PES0001"
//   0x08: u32le PEC ブロックへのオフセット
//   0x0C: u16le 0x01 (scale to fit)
//   0x0E: u16le 0x00 (フープ: 0 = 100×100mm, 1 = 130×180mm)
//   0x10: u16le 0x00 (セグメントブロック数 = 0)
//   0x12: u16le 0xFFFF / u16le 0x0000 (CEmbOne なし)
//   0x16: PEC ブロック

import type { StitchPlan } from "../core/types";
import { BinWriter } from "./binWriter";
import type { BrotherThread } from "./brotherPalette";
import { assignBrotherThreads, writePecBlock } from "./pec";

export interface PesResult {
  data: Uint8Array;
  /** 各ブロックに割り当てられた Brother パレット色 (出力後の色確認用) */
  threads: BrotherThread[];
}

export function writePes(plan: StitchPlan): PesResult {
  const threads = assignBrotherThreads(plan);
  const w = new BinWriter();

  w.ascii("#PES0001");
  const pecOffsetPos = w.length;
  w.u32le(0); // プレースホルダー
  w.u16le(0x01); // scale to fit
  w.u16le(0x00); // 100×100mm フープ (PP1)
  w.u16le(0x00); // セグメントブロックなし
  w.u16le(0xffff);
  w.u16le(0x0000);

  w.patchU32le(pecOffsetPos, w.length);
  writePecBlock(w, plan, threads);

  return { data: w.toUint8Array(), threads };
}
