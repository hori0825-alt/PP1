// Tajima DST ライタ。単位 0.1mm。DST は Y軸上向きなので書き出し時に反転する。

import { COLOR_CHANGE, END, JUMP, Pattern, STITCH } from "./pattern";
import { BinWriter } from "./binWriter";

const MAX_DELTA = 121;

/** dx, dy (-121..121) を 3バイトレコードにエンコード */
export function encodeDstRecord(dx: number, dy: number, jump: boolean, colorChange: boolean): [number, number, number] {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let x = dx;
  let y = dy;

  if (x > 40) {
    b2 |= 0x04;
    x -= 81;
  } else if (x < -40) {
    b2 |= 0x08;
    x += 81;
  }
  if (y > 40) {
    b2 |= 0x20;
    y -= 81;
  } else if (y < -40) {
    b2 |= 0x10;
    y += 81;
  }

  if (x > 13) {
    b1 |= 0x04;
    x -= 27;
  } else if (x < -13) {
    b1 |= 0x08;
    x += 27;
  }
  if (y > 13) {
    b1 |= 0x20;
    y -= 27;
  } else if (y < -13) {
    b1 |= 0x10;
    y += 27;
  }

  if (x > 4) {
    b0 |= 0x04;
    x -= 9;
  } else if (x < -4) {
    b0 |= 0x08;
    x += 9;
  }
  if (y > 4) {
    b0 |= 0x20;
    y -= 9;
  } else if (y < -4) {
    b0 |= 0x10;
    y += 9;
  }

  if (x > 1) {
    b1 |= 0x01;
    x -= 3;
  } else if (x < -1) {
    b1 |= 0x02;
    x += 3;
  }
  if (y > 1) {
    b1 |= 0x80;
    y -= 3;
  } else if (y < -1) {
    b1 |= 0x40;
    y += 3;
  }

  if (x === 1) {
    b0 |= 0x01;
    x -= 1;
  } else if (x === -1) {
    b0 |= 0x02;
    x += 1;
  }
  if (y === 1) {
    b0 |= 0x80;
    y -= 1;
  } else if (y === -1) {
    b0 |= 0x40;
    y += 1;
  }

  if (x !== 0 || y !== 0) throw new Error(`DST delta out of range: ${dx},${dy}`);

  b2 |= 0x03;
  if (jump) b2 |= 0x80;
  if (colorChange) b2 |= 0xc0;
  return [b0, b1, b2];
}

/** 3バイトレコードを (dx, dy) にデコード (テスト用) */
export function decodeDstRecord(b0: number, b1: number, b2: number): { dx: number; dy: number; jump: boolean; colorChange: boolean } {
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
  return {
    dx,
    dy,
    jump: (b2 & 0x80) !== 0 && (b2 & 0xc0) !== 0xc0,
    colorChange: (b2 & 0xc0) === 0xc0,
  };
}

export function writeDst(pattern: Pattern): Uint8Array {
  // レコード生成 (DST 座標系: y を反転)
  const records: [number, number, number][] = [];
  let colorChanges = 0;
  let x = 0;
  let y = 0;
  let endX = 0;
  let endY = 0;

  const emitMove = (tx: number, ty: number, jump: boolean) => {
    let dx = Math.round(tx) - x;
    let dy = Math.round(ty) - y;
    do {
      const sx = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dx));
      const sy = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dy));
      records.push(encodeDstRecord(sx, sy, jump, false));
      dx -= sx;
      dy -= sy;
    } while (dx !== 0 || dy !== 0);
    x = Math.round(tx);
    y = Math.round(ty);
  };

  for (const s of pattern.stitches) {
    const sy = -s.y; // Y反転
    if (s.cmd === STITCH) {
      emitMove(s.x, sy, false);
      endX = x;
      endY = y;
    } else if (s.cmd === JUMP) {
      emitMove(s.x, sy, true);
    } else if (s.cmd === COLOR_CHANGE) {
      records.push(encodeDstRecord(0, 0, false, true));
      colorChanges++;
    } else if (s.cmd === END) {
      break;
    }
  }

  // 範囲計算 (原点 = 開始位置)
  const b = pattern.bounds();
  const plusX = Math.round(Math.max(0, b.maxX));
  const minusX = Math.round(Math.max(0, -b.minX));
  const plusY = Math.round(Math.max(0, -b.minY));
  const minusY = Math.round(Math.max(0, b.maxY));

  const f = new BinWriter();
  const name = (pattern.name || "PP1").slice(0, 16);
  const pad = (v: number, w: number) => String(Math.abs(v)).padStart(w, "0");
  const sign = (v: number) => (v < 0 ? "-" : "+");

  f.ascii("LA:" + name.padEnd(16, " ") + "\r");
  f.ascii("ST:" + String(records.length).padStart(7, " ") + "\r");
  f.ascii("CO:" + String(colorChanges).padStart(3, " ") + "\r");
  f.ascii("+X:" + pad(plusX, 5) + "\r");
  f.ascii("-X:" + pad(minusX, 5) + "\r");
  f.ascii("+Y:" + pad(plusY, 5) + "\r");
  f.ascii("-Y:" + pad(minusY, 5) + "\r");
  f.ascii("AX:" + sign(endX) + pad(endX, 5) + "\r");
  f.ascii("AY:" + sign(endY) + pad(endY, 5) + "\r");
  f.ascii("MX:+00000\r");
  f.ascii("MY:+00000\r");
  f.ascii("PD:******\r");
  f.u8(0x1a);
  f.fill(0x20, 512 - f.position);

  for (const [b0, b1, b2] of records) {
    f.u8(b0);
    f.u8(b1);
    f.u8(b2);
  }
  f.u8(0x00);
  f.u8(0x00);
  f.u8(0xf3);
  return f.toUint8Array();
}
