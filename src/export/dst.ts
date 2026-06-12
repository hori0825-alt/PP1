// DST (Tajima) エクスポーター。
// - 512バイトヘッダー + 3バイト/レコードのステッチデータ + 終端レコード
// - 1レコードの移動量は ±121 (12.1mm)。flatten 側で分割済みだが、ここでも検証する。
// - DST の Y 軸は上が正のため、内部座標 (+y 下) から反転する。
// - DST に糸切りコードはないため、trim は小さな3連ジャンプで表現する
//   (多くのミシンが3連続ジャンプを糸切りと解釈する慣例に従う)。

import type { StitchPlan } from "../core/types";
import { BinWriter } from "./binWriter";
import type { MachineOp } from "./flatten";
import { flattenPlan } from "./flatten";

/** dx, dy (-121..121) と種別から 3バイトレコードを生成 */
export function encodeDstRecord(
  dx: number,
  dy: number,
  kind: "stitch" | "jump" | "colorChange",
): [number, number, number] {
  if (dx < -121 || dx > 121 || dy < -121 || dy > 121) {
    throw new Error(`DST record out of range: dx=${dx}, dy=${dy}`);
  }
  let b0 = 0;
  let b1 = 0;
  let b2 = 0x03; // bit0, bit1 は常にセット

  // 平衡三進法 (各桁 -1/0/+1 × 3^k, k=0..4) に分解してビットを立てる。
  // 桁ごとのビット位置: [byte, +ビット, -ビット]
  const X_BITS: [number, number, number][] = [
    [0, 0x01, 0x02], // 1
    [1, 0x01, 0x02], // 3
    [0, 0x04, 0x08], // 9
    [1, 0x04, 0x08], // 27
    [2, 0x04, 0x08], // 81
  ];
  const Y_BITS: [number, number, number][] = [
    [0, 0x80, 0x40], // 1
    [1, 0x80, 0x40], // 3
    [0, 0x20, 0x10], // 9
    [1, 0x20, 0x10], // 27
    [2, 0x20, 0x10], // 81
  ];

  const apply = (value: number, bits: [number, number, number][]): void => {
    let v = value;
    for (let k = 0; k < 5; k++) {
      const r = ((v % 3) + 3) % 3;
      const digit = r === 2 ? -1 : r;
      v = (v - digit) / 3;
      if (digit === 0) continue;
      const [byteIdx, plusBit, minusBit] = bits[k];
      const bit = digit > 0 ? plusBit : minusBit;
      if (byteIdx === 0) b0 |= bit;
      else if (byteIdx === 1) b1 |= bit;
      else b2 |= bit;
    }
  };

  apply(dx, X_BITS);
  apply(dy, Y_BITS);

  if (kind === "jump") b2 |= 0x80;
  if (kind === "colorChange") b2 |= 0xc0;
  return [b0, b1, b2];
}

interface DstRecord {
  dx: number;
  dy: number;
  kind: "stitch" | "jump" | "colorChange";
}

/** MachineOp 列を DST レコード列に変換 (Y 反転・trim の3連ジャンプ化を含む) */
function toRecords(ops: MachineOp[]): DstRecord[] {
  const records: DstRecord[] = [];
  let xx = 0;
  let yy = 0;
  for (const op of ops) {
    switch (op.kind) {
      case "stitch":
      case "jump": {
        const dx = op.x - xx;
        const dy = -(op.y - yy); // Y 反転
        xx = op.x;
        yy = op.y;
        records.push({ dx, dy, kind: op.kind });
        break;
      }
      case "trim": {
        // その場で小さく3回ジャンプして元の位置に戻る (合計移動ゼロ)
        records.push({ dx: 2, dy: 2, kind: "jump" });
        records.push({ dx: -4, dy: -4, kind: "jump" });
        records.push({ dx: 2, dy: 2, kind: "jump" });
        break;
      }
      case "colorChange": {
        records.push({ dx: 0, dy: 0, kind: "colorChange" });
        break;
      }
      case "end":
        break;
    }
  }
  return records;
}

function headerLine(w: BinWriter, key: string, value: string): void {
  w.ascii(key + value);
  w.u8(0x0d);
}

export function writeDst(plan: StitchPlan): Uint8Array {
  const records = toRecords(flattenPlan(plan));

  // バウンディングと終点を DST 座標系 (Y 上向き) で集計
  let x = 0;
  let y = 0;
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  let colorChanges = 0;
  for (const r of records) {
    x += r.dx;
    y += r.dy;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (r.kind === "colorChange") colorChanges++;
  }

  const w = new BinWriter(512 + records.length * 3 + 3);
  const num = (v: number, width: number): string =>
    String(Math.abs(Math.round(v))).padStart(width, " ");
  const signed = (v: number, width: number): string =>
    (v < 0 ? "-" : "+") + String(Math.abs(Math.round(v))).padStart(width, " ");

  const label = plan.name.replace(/[^\x20-\x7e]/g, "_").slice(0, 16);
  headerLine(w, "LA:", label.padEnd(16, " "));
  headerLine(w, "ST:", num(records.length, 7));
  headerLine(w, "CO:", num(colorChanges, 3));
  headerLine(w, "+X:", num(maxX, 5));
  headerLine(w, "-X:", num(Math.abs(minX), 5));
  headerLine(w, "+Y:", num(maxY, 5));
  headerLine(w, "-Y:", num(Math.abs(minY), 5));
  headerLine(w, "AX:", signed(x, 5));
  headerLine(w, "AY:", signed(y, 5));
  headerLine(w, "MX:", signed(0, 5));
  headerLine(w, "MY:", signed(0, 5));
  headerLine(w, "PD:", "******");
  w.u8(0x1a);
  w.fill(0x20, 512 - w.length);

  for (const r of records) {
    w.bytes(encodeDstRecord(r.dx, r.dy, r.kind));
  }
  w.bytes([0x00, 0x00, 0xf3]); // 終端

  return w.toUint8Array();
}
