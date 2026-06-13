// PEC ブロックの書き出し。PES ファイルの実体部分であり、
// Brother ミシン (PP1) が実際に読むのはこの PEC のステッチ・色情報。
//
// レイアウト (バイトオフセットは PEC ブロック先頭基準):
//   0x000: "LA:" + ラベル16文字 (空白詰め) + 0x0D
//   0x014: 0x20 ×12
//   0x020: 0xFF 0x00 0x06 0x26   (サムネイル 6バイト幅 × 38px 高)
//   0x024: 0x20 ×12
//   0x030: 色数 - 1
//   0x031: パレットインデックス列 (1色1バイト)
//   以降 0x20 で 0x200 まで詰める
//   0x200: 0x00 0x00 / u24le ブロック長 / 0x31 0xFF 0xF0 /
//          幅 u16le / 高 u16le / 0x1E0 / 0x1B0 /
//          (0x9000|-minX) u16be / (0x9000|-minY) u16be
//   続いてステッチデータ、0xFF 終端、サムネイル画像 (デザイン全体 + 色ごと)

import type { Bounds } from "../core/plan";
import { planBounds } from "../core/plan";
import type { StitchPlan } from "../core/types";
import { BinWriter } from "./binWriter";
import type { BrotherThread } from "./brotherPalette";
import { nearestBrotherThread } from "./brotherPalette";
import type { MachineOp } from "./flatten";
import { flattenPlan } from "./flatten";

const THUMB_W_BYTES = 6; // 48px
const THUMB_W = THUMB_W_BYTES * 8;
const THUMB_H = 38;

/** PES/PEC へ出力する際の色割り当て (元色 → Brother パレット色) */
export function assignBrotherThreads(plan: StitchPlan): BrotherThread[] {
  return plan.blocks.map((b) => nearestBrotherThread(b.thread));
}

function encodeLongForm(value: number): number {
  return (value & 0x0fff) | 0x8000;
}

const FLAG_JUMP = 0x10;
const FLAG_TRIM = 0x20;

/**
 * ステッチ列を PEC エンコードで書き込む。
 * - 短形式: dx,dy がともに -64..63 → 各1バイト (7bit 2の補数)
 * - 長形式: 12bit 2の補数 + 上位バイトにフラグ (0x80 必須, 0x10=jump, 0x20=trim)
 * - 色替え: 0xFE 0xB0 + 交互の 0x02/0x01
 * - 終端: 0xFF
 * trim 命令は直後のジャンプ移動の最初の1針に trim フラグとして畳み込む。
 */
function encodeStitches(w: BinWriter, ops: MachineOp[]): void {
  let xx = 0;
  let yy = 0;
  let colorTwo = true;
  let jumping = false;
  let pendingTrim = false;

  const writeLong = (dx: number, dy: number, flag: number): void => {
    const ex = encodeLongForm(dx) | (flag << 8);
    const ey = encodeLongForm(dy) | (flag << 8);
    w.u8(ex >> 8);
    w.u8(ex);
    w.u8(ey >> 8);
    w.u8(ey);
  };

  for (const op of ops) {
    switch (op.kind) {
      case "stitch": {
        const dx = op.x - xx;
        const dy = op.y - yy;
        xx = op.x;
        yy = op.y;
        if (jumping) {
          // ジャンプ着地点にアンカーの0移動ステッチを打つ
          w.u8(0);
          w.u8(0);
          jumping = false;
        }
        if (dx >= -64 && dx <= 63 && dy >= -64 && dy <= 63) {
          w.u8(dx & 0x7f);
          w.u8(dy & 0x7f);
        } else {
          writeLong(dx, dy, 0);
        }
        break;
      }
      case "jump": {
        const dx = op.x - xx;
        const dy = op.y - yy;
        xx = op.x;
        yy = op.y;
        // trim は次のジャンプの1針目にフラグとして付与する
        writeLong(dx, dy, pendingTrim ? FLAG_TRIM : FLAG_JUMP);
        pendingTrim = false;
        jumping = true;
        break;
      }
      case "trim": {
        pendingTrim = true;
        break;
      }
      case "colorChange": {
        if (jumping) {
          w.u8(0);
          w.u8(0);
          jumping = false;
        }
        pendingTrim = false; // 色替えが暗黙の糸切りを行う
        w.u8(0xfe);
        w.u8(0xb0);
        w.u8(colorTwo ? 0x02 : 0x01);
        colorTwo = !colorTwo;
        break;
      }
      case "end": {
        w.u8(0xff);
        break;
      }
    }
  }
}

/** 48×38 1bit のサムネイルを生成 (ステッチ位置をプロット)。blockIndex=null で全体 */
function renderThumbnail(
  plan: StitchPlan,
  bounds: Bounds,
  blockIndex: number | null,
): Uint8Array {
  const img = new Uint8Array(THUMB_W_BYTES * THUMB_H);
  const setPx = (px: number, py: number): void => {
    if (px < 0 || px >= THUMB_W || py < 0 || py >= THUMB_H) return;
    img[py * THUMB_W_BYTES + (px >> 3)] |= 1 << (px & 7);
  };
  const w = Math.max(1, bounds.maxX - bounds.minX);
  const h = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min((THUMB_W - 4) / w, (THUMB_H - 4) / h);
  const ox = (THUMB_W - w * scale) / 2;
  const oy = (THUMB_H - h * scale) / 2;

  plan.blocks.forEach((block, bi) => {
    if (blockIndex !== null && bi !== blockIndex) return;
    for (const run of block.runs) {
      for (const p of run.stitches) {
        setPx(
          Math.round((p.x - bounds.minX) * scale + ox),
          Math.round((p.y - bounds.minY) * scale + oy),
        );
      }
    }
  });
  return img;
}

/** PEC ブロック全体を書き込む */
export function writePecBlock(w: BinWriter, plan: StitchPlan, threads: BrotherThread[]): void {
  const base = w.length;
  const bounds = planBounds(plan) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const label = plan.name.replace(/[^\x20-\x7e]/g, "_").slice(0, 16);

  // ---- ヘッダー (0x000 - 0x1FF) ----
  w.ascii("LA:");
  w.ascii(label.padEnd(16, " "));
  w.u8(0x0d);
  w.fill(0x20, 12);
  w.bytes([0xff, 0x00, THUMB_W_BYTES, THUMB_H]);
  w.fill(0x20, 12);
  const colorCount = threads.length;
  w.u8((colorCount - 1) & 0xff);
  for (const th of threads) w.u8(th.pecIndex);
  w.fill(0x20, 0x1cf - colorCount);

  // ---- ステッチセクション (0x200 -) ----
  const blockStart = w.length; // base + 0x200
  w.u8(0x00);
  w.u8(0x00);
  const lenPatchPos = w.length;
  w.u24le(0); // ブロック長プレースホルダー
  w.bytes([0x31, 0xff, 0xf0]);
  w.u16le(bounds.maxX - bounds.minX);
  w.u16le(bounds.maxY - bounds.minY);
  w.u16le(0x1e0);
  w.u16le(0x1b0);
  w.u16be(0x9000 | (-bounds.minX & 0xfff));
  w.u16be(0x9000 | (-bounds.minY & 0xfff));

  encodeStitches(w, flattenPlan(plan));

  // ブロック長 = 0x200 からステッチ終端 (0xFF 含む) まで
  w.patchU24le(lenPatchPos, w.length - blockStart);

  // ---- サムネイル: デザイン全体 + 色ごと ----
  w.bytes(renderThumbnail(plan, bounds, null));
  for (let i = 0; i < plan.blocks.length; i++) {
    w.bytes(renderThumbnail(plan, bounds, i));
  }

  void base;
}
