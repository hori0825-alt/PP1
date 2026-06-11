// PES v1 (CEmbOne/CSewSeg + PEC ブロック) ライタ。
// pyembroidery (EmbroidePy/pyembroidery) の PesWriter/PecWriter を TypeScript に移植。
// 座標単位 0.1mm、Y軸下向き。デザインは書き出し前に center() で原点中心にしておくこと。

import {
  COLOR_CHANGE,
  END,
  JUMP,
  Pattern,
  STITCH,
  Stitch,
  TRIM,
  getColorBlocks,
  getCommandBlocks,
} from "./pattern";
import { BinWriter } from "./binWriter";

const JUMP_CODE = 0x10;
const TRIM_CODE = 0x20;
const MASK_07_BIT = 0x7f;

const PEC_ICON_WIDTH = 48;
const PEC_ICON_HEIGHT = 38;
const PEC_ICON_STRIDE = PEC_ICON_WIDTH / 8;

export function writePes(pattern: Pattern): Uint8Array {
  const f = new BinWriter();
  f.ascii("#PES0001");

  const b = pattern.bounds();
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const left = b.minX - cx;
  const top = b.minY - cy;
  const right = b.maxX - cx;
  const bottom = b.maxY - cy;

  const pecPlaceholder = f.position;
  f.u32(0); // PEC ブロック位置 (後埋め)

  f.u16(0x01); // scale to fit
  f.u16(0x01); // hoop
  if (pattern.stitches.length === 0) {
    f.u16(0x0000); // distinct block objects
    f.u16(0x0000);
    f.u16(0x0000);
  } else {
    f.u16(0x0001);
    f.u16(0xffff);
    f.u16(0x0000);
    writePesBlocks(f, pattern, left, top, right, bottom, cx, cy);
  }

  const cur = f.position;
  f.seek(pecPlaceholder);
  f.u32(cur);
  f.seek(cur);

  writePec(pattern, f);
  return f.toUint8Array();
}

/** 単体 .pec ファイルの書き出し */
export function writePecFile(pattern: Pattern): Uint8Array {
  const f = new BinWriter();
  f.ascii("#PEC0001");
  writePec(pattern, f);
  return f.toUint8Array();
}

// ---------------------------------------------------------------- PES blocks

function pesString16(f: BinWriter, s: string): void {
  f.u16(s.length);
  f.ascii(s);
}

function writePesBlocks(
  f: BinWriter,
  pattern: Pattern,
  left: number,
  top: number,
  right: number,
  bottom: number,
  cx: number,
  cy: number,
): void {
  if (pattern.stitches.length === 0) return;

  pesString16(f, "CEmbOne");
  const sectionPlaceholder = writeSewSegHeader(f, left, top, right, bottom);
  f.u16(0xffff);
  f.u16(0x0000); // FFFF 0000 = 後続ブロックあり

  pesString16(f, "CSewSeg");
  const sections = writeSewSegSegments(f, pattern, left, bottom, cx, cy);

  const cur = f.position;
  f.seek(sectionPlaceholder);
  f.u16(sections);
  f.seek(cur);

  f.u16(0x0000);
  f.u16(0x0000); // 0000 0000 = ブロック終端
}

function writeSewSegHeader(
  f: BinWriter,
  left: number,
  top: number,
  right: number,
  bottom: number,
): number {
  const width = right - left;
  const height = bottom - top;
  const hoopHeight = 1800;
  const hoopWidth = 1300;
  for (let i = 0; i < 8; i++) f.u16(0);
  let transX = 0;
  let transY = 0;
  transX += 350;
  transY += 100 + height;
  transX += hoopWidth / 2;
  transY += hoopHeight / 2;
  transX += -width / 2;
  transY += -height / 2;
  f.f32(1);
  f.f32(0);
  f.f32(0);
  f.f32(1);
  f.f32(transX);
  f.f32(transY);

  f.u16(1);
  f.u16(0);
  f.u16(0);
  f.u16(Math.trunc(width));
  f.u16(Math.trunc(height));
  f.fill(0, 8);

  const placeholder = f.position;
  f.u16(0); // セクション数 (後埋め)
  return placeholder;
}

interface SegBlock {
  points: [number, number][];
  colorCode: number;
  flag: number;
}

function* segmentBlocks(
  pattern: Pattern,
  adjustX: number,
  adjustY: number,
): Generator<SegBlock> {
  let colorIndex = 0;
  const threadAt = (i: number) =>
    pattern.threads[Math.min(i, pattern.threads.length - 1)];
  let colorCode = threadAt(0)?.pecIndex ?? 20;
  colorIndex++;
  let stitchedX = 0;
  let stitchedY = 0;
  for (const block of getCommandBlocks(pattern.stitches)) {
    const cmd = block[0].cmd;
    if (cmd === JUMP) {
      const last = block[block.length - 1];
      const points: [number, number][] = [
        [stitchedX - adjustX, stitchedY - adjustY],
        [last.x - adjustX, last.y - adjustY],
      ];
      yield { points, colorCode, flag: 1 };
    } else if (cmd === COLOR_CHANGE) {
      colorCode = threadAt(colorIndex)?.pecIndex ?? 20;
      colorIndex++;
    } else if (cmd === STITCH) {
      const points: [number, number][] = [];
      for (const s of block) {
        stitchedX = s.x;
        stitchedY = s.y;
        points.push([stitchedX - adjustX, stitchedY - adjustY]);
      }
      yield { points, colorCode, flag: 0 };
    }
  }
}

function writeSewSegSegments(
  f: BinWriter,
  pattern: Pattern,
  left: number,
  bottom: number,
  cx: number,
  cy: number,
): number {
  let section = 0;
  const colorlog: [number, number][] = [];
  let previousColorCode = -1;
  let first = true;
  const adjustX = left + cx;
  const adjustY = bottom + cy;

  for (const seg of segmentBlocks(pattern, adjustX, adjustY)) {
    if (!first) f.u16(0x8003); // セクション区切り
    first = false;
    if (previousColorCode !== seg.colorCode) {
      colorlog.push([section, seg.colorCode]);
      previousColorCode = seg.colorCode;
    }
    f.u16(seg.flag);
    f.u16(seg.colorCode);
    f.u16(seg.points.length);
    for (const [x, y] of seg.points) {
      f.u16(Math.trunc(x) & 0xffff);
      f.u16(Math.trunc(y) & 0xffff);
    }
    section++;
  }

  f.u16(colorlog.length);
  for (const [sec, code] of colorlog) {
    f.u16(sec);
    f.u16(code);
  }
  return section;
}

// ----------------------------------------------------------------------- PEC

export function writePec(pattern: Pattern, f: BinWriter): void {
  const b = pattern.bounds();
  writePecHeader(pattern, f);
  writePecBlock(pattern, f, b);
  writePecGraphics(pattern, f, b);
}

function writePecHeader(pattern: Pattern, f: BinWriter): void {
  const name = (pattern.name || "PP1").slice(0, 8);
  f.ascii("LA:" + name.padEnd(16, " ") + "\r");
  f.fill(0x20, 12);
  f.u8(0xff);
  f.u8(0x00);
  f.u8(PEC_ICON_STRIDE);
  f.u8(PEC_ICON_HEIGHT);

  const colorIndexList = pattern.threads.map((t) => t.pecIndex);
  const n = colorIndexList.length;
  if (n !== 0) {
    f.fill(0x20, 12);
    f.u8(n - 1);
    f.bytes(colorIndexList);
  } else {
    f.bytes([0x20, 0x20, 0x20, 0x20, 0x64, 0x20, 0x00, 0x20, 0x00, 0x20, 0x20, 0x20, 0xff]);
  }
  f.fill(0x20, 463 - n);
}

function writePecBlock(
  pattern: Pattern,
  f: BinWriter,
  b: { minX: number; minY: number; maxX: number; maxY: number },
): void {
  const width = b.maxX - b.minX;
  const height = b.maxY - b.minY;

  const start = f.position;
  f.u8(0x00);
  f.u8(0x00);
  f.u24(0); // ブロック長 (後埋め)
  f.bytes([0x31, 0xff, 0xf0]);
  f.u16(Math.round(width));
  f.u16(Math.round(height));
  f.u16(0x1e0);
  f.u16(0x1b0);
  pecEncode(pattern, f);

  const length = f.position - start;
  const cur = f.position;
  f.seek(start + 2);
  f.u24(length);
  f.seek(cur);
}

function writeValue(f: BinWriter, value: number, long: boolean, flag = 0): void {
  if (!long && value > -64 && value < 63) {
    f.u8(value & MASK_07_BIT);
  } else {
    let v = value & 0x0fff;
    v |= 0x8000;
    v |= flag << 8;
    f.u8((v >> 8) & 0xff);
    f.u8(v & 0xff);
  }
}

function pecEncode(pattern: Pattern, f: BinWriter): void {
  let colorTwo = true;
  let jumping = true;
  let init = true;
  // 糸切りは TRIM コマンドで明示されたときだけ行う。
  // それ以外の JUMP は糸を切らない移動 (渡り糸) として書き出す
  let pendingTrim = false;
  let xx = 0;
  let yy = 0;
  for (const stitch of pattern.stitches) {
    const dx = Math.round(stitch.x - xx);
    const dy = Math.round(stitch.y - yy);
    xx += dx;
    yy += dy;
    const cmd = stitch.cmd;
    if (cmd === STITCH) {
      if (jumping) {
        if (dx !== 0 && dy !== 0) {
          writeValue(f, 0, false);
          writeValue(f, 0, false);
        }
        jumping = false;
      }
      pendingTrim = false;
      writeValue(f, dx, false);
      writeValue(f, dy, false);
    } else if (cmd === TRIM) {
      pendingTrim = true;
      continue; // 位置情報のみ (dx,dy=0)。次の JUMP で糸切りフラグを立てる
    } else if (cmd === JUMP) {
      jumping = true;
      const flag = init ? JUMP_CODE : pendingTrim ? TRIM_CODE : JUMP_CODE;
      writeValue(f, dx, true, flag);
      writeValue(f, dy, true, flag);
    } else if (cmd === COLOR_CHANGE) {
      if (jumping) {
        writeValue(f, 0, false);
        writeValue(f, 0, false);
        jumping = false;
      }
      pendingTrim = false; // 色替えで機械が糸処理するため
      f.u8(0xfe);
      f.u8(0xb0);
      f.u8(colorTwo ? 0x02 : 0x01);
      colorTwo = !colorTwo;
    } else if (cmd === END) {
      f.u8(0xff);
      break;
    }
    init = false;
  }
}

// ------------------------------------------------------------- PEC graphics

/** 48x38 px のサムネイル枠 (角丸枠) を生成 */
function getBlankGraphic(): number[] {
  const g = new Array<number>(PEC_ICON_STRIDE * PEC_ICON_HEIGHT).fill(0);
  const setRow = (row: number, bytes: number[]) => {
    for (let i = 0; i < PEC_ICON_STRIDE; i++) g[row * PEC_ICON_STRIDE + i] = bytes[i];
  };
  setRow(1, [0xf0, 0xff, 0xff, 0xff, 0xff, 0x0f]);
  setRow(2, [0x08, 0x00, 0x00, 0x00, 0x00, 0x10]);
  setRow(3, [0x04, 0x00, 0x00, 0x00, 0x00, 0x20]);
  for (let r = 4; r <= 33; r++) setRow(r, [0x02, 0x00, 0x00, 0x00, 0x00, 0x40]);
  setRow(34, [0x04, 0x00, 0x00, 0x00, 0x00, 0x20]);
  setRow(35, [0x08, 0x00, 0x00, 0x00, 0x00, 0x10]);
  setRow(36, [0xf0, 0xff, 0xff, 0xff, 0xff, 0x0f]);
  return g;
}

function markBit(graphic: number[], x: number, y: number): void {
  if (x < 0 || x >= PEC_ICON_WIDTH || y < 0 || y >= PEC_ICON_HEIGHT) return;
  graphic[y * PEC_ICON_STRIDE + Math.floor(x / 8)] |= 1 << x % 8;
}

function drawScaled(
  b: { minX: number; minY: number; maxX: number; maxY: number },
  points: Stitch[],
  graphic: number[],
  buffer: number,
): void {
  let dw = b.maxX - b.minX;
  let dh = b.maxY - b.minY;
  if (dw === 0) dw = 1;
  if (dh === 0) dh = 1;
  const scale = Math.min(
    (PEC_ICON_WIDTH - buffer) / dw,
    (PEC_ICON_HEIGHT - buffer) / dh,
  );
  const cx = (b.maxX + b.minX) / 2;
  const cy = (b.maxY + b.minY) / 2;
  const tx = -cx * scale + PEC_ICON_WIDTH / 2;
  const ty = -cy * scale + PEC_ICON_HEIGHT / 2;
  for (const p of points) {
    markBit(graphic, Math.floor(p.x * scale + tx), Math.floor(p.y * scale + ty));
  }
}

function writePecGraphics(
  pattern: Pattern,
  f: BinWriter,
  b: { minX: number; minY: number; maxX: number; maxY: number },
): void {
  const all = getBlankGraphic();
  const stitchesOnly = pattern.stitches.filter((s) => s.cmd === STITCH);
  drawScaled(b, stitchesOnly, all, 4);
  f.bytes(all);

  for (const block of getColorBlocks(pattern)) {
    const g = getBlankGraphic();
    drawScaled(b, block.filter((s) => s.cmd === STITCH), g, 5);
    f.bytes(g);
  }
}
