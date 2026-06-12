// テスト用の PES/PEC・DST デコーダー (ラウンドトリップ検証用)。
// Phase 6 で正式なリーダーに昇格させる予定。

export interface DecodedDstRecord {
  dx: number;
  dy: number;
  kind: "stitch" | "jump" | "colorChange";
}

export function decodeDstRecord(b0: number, b1: number, b2: number): DecodedDstRecord {
  let dx = 0;
  let dy = 0;
  if (b0 & 0x01) dx += 1;
  if (b0 & 0x02) dx -= 1;
  if (b0 & 0x04) dx += 9;
  if (b0 & 0x08) dx -= 9;
  if (b0 & 0x80) dy += 1;
  if (b0 & 0x40) dy -= 1;
  if (b0 & 0x20) dy += 9;
  if (b0 & 0x10) dy -= 9;
  if (b1 & 0x01) dx += 3;
  if (b1 & 0x02) dx -= 3;
  if (b1 & 0x04) dx += 27;
  if (b1 & 0x08) dx -= 27;
  if (b1 & 0x80) dy += 3;
  if (b1 & 0x40) dy -= 3;
  if (b1 & 0x20) dy += 27;
  if (b1 & 0x10) dy -= 27;
  if (b2 & 0x04) dx += 81;
  if (b2 & 0x08) dx -= 81;
  if (b2 & 0x20) dy += 81;
  if (b2 & 0x10) dy -= 81;
  let kind: DecodedDstRecord["kind"] = "stitch";
  if ((b2 & 0xc0) === 0xc0) kind = "colorChange";
  else if (b2 & 0x80) kind = "jump";
  return { dx, dy, kind };
}

export interface DecodedDst {
  label: string;
  stitchCount: number;
  colorChangeCount: number;
  records: DecodedDstRecord[];
}

export function decodeDst(data: Uint8Array): DecodedDst {
  const header = new TextDecoder("ascii").decode(data.slice(0, 512));
  const label = /LA:(.{1,16})\r/.exec(header)?.[1].trimEnd() ?? "";
  const stitchCount = Number(/ST:\s*(\d+)\r/.exec(header)?.[1] ?? -1);
  const colorChangeCount = Number(/CO:\s*(\d+)\r/.exec(header)?.[1] ?? -1);

  const records: DecodedDstRecord[] = [];
  for (let i = 512; i + 2 < data.length; i += 3) {
    const [b0, b1, b2] = [data[i], data[i + 1], data[i + 2]];
    if (b2 === 0xf3) break;
    records.push(decodeDstRecord(b0, b1, b2));
  }
  return { label, stitchCount, colorChangeCount, records };
}

export interface DecodedPecOp {
  kind: "stitch" | "jump" | "trim" | "colorChange";
  dx: number;
  dy: number;
}

export interface DecodedPes {
  pecOffset: number;
  label: string;
  colorCount: number;
  paletteIndices: number[];
  ops: DecodedPecOp[];
}

function readU32le(data: Uint8Array, pos: number): number {
  return data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24);
}

export function decodePes(data: Uint8Array): DecodedPes {
  const magic = new TextDecoder("ascii").decode(data.slice(0, 8));
  if (magic !== "#PES0001") throw new Error(`bad magic: ${magic}`);
  const pecOffset = readU32le(data, 8);

  const la = new TextDecoder("ascii").decode(data.slice(pecOffset, pecOffset + 3));
  if (la !== "LA:") throw new Error(`PEC not found at offset ${pecOffset}`);
  const label = new TextDecoder("ascii")
    .decode(data.slice(pecOffset + 3, pecOffset + 19))
    .trimEnd();

  const colorCount = data[pecOffset + 0x30] + 1;
  const paletteIndices: number[] = [];
  for (let i = 0; i < colorCount; i++) {
    paletteIndices.push(data[pecOffset + 0x31 + i]);
  }

  // ステッチデータはセクションヘッダー 20 バイトの後から
  let pos = pecOffset + 0x200 + 20;
  const ops: DecodedPecOp[] = [];

  const readCoord = (): { v: number; flags: number } => {
    const b = data[pos++];
    if (b & 0x80) {
      const b2 = data[pos++];
      let v = ((b & 0x0f) << 8) | b2;
      if (v > 2047) v -= 4096;
      return { v, flags: b & 0x30 };
    }
    let v = b & 0x7f;
    if (v > 63) v -= 128;
    return { v, flags: 0 };
  };

  for (;;) {
    const b = data[pos];
    if (b === 0xff) break;
    if (b === 0xfe && data[pos + 1] === 0xb0) {
      ops.push({ kind: "colorChange", dx: 0, dy: 0 });
      pos += 3;
      continue;
    }
    const x = readCoord();
    const y = readCoord();
    const flags = x.flags | y.flags;
    let kind: DecodedPecOp["kind"] = "stitch";
    if (flags & 0x20) kind = "trim";
    else if (flags & 0x10) kind = "jump";
    ops.push({ kind, dx: x.v, dy: y.v });
  }
  return { pecOffset, label, colorCount, paletteIndices, ops };
}
