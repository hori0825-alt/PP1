// 刺しゅうパターンの内部表現。
// 座標単位は 0.1mm (PES/PEC/DST 共通の機械単位)、Y軸は画面と同じ下向き。

export const STITCH = 0;
export const JUMP = 1;
export const COLOR_CHANGE = 2;
export const END = 4;

export interface Thread {
  r: number;
  g: number;
  b: number;
  name: string;
  catalog: string;
  /** PEC 64色パレット内の 1始まりインデックス */
  pecIndex: number;
}

export interface Stitch {
  x: number;
  y: number;
  cmd: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class Pattern {
  stitches: Stitch[] = [];
  threads: Thread[] = [];
  name = "PP1";

  add(cmd: number, x: number, y: number): void {
    this.stitches.push({ x, y, cmd });
  }

  bounds(): Bounds {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of this.stitches) {
      if (s.cmd !== STITCH && s.cmd !== JUMP) continue;
      if (s.x < minX) minX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.x > maxX) maxX = s.x;
      if (s.y > maxY) maxY = s.y;
    }
    if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX, minY, maxX, maxY };
  }

  translate(dx: number, dy: number): void {
    for (const s of this.stitches) {
      s.x += dx;
      s.y += dy;
    }
  }

  /** デザイン中心を原点 (0,0) に移動する */
  center(): void {
    const b = this.bounds();
    this.translate(-(b.minX + b.maxX) / 2, -(b.minY + b.maxY) / 2);
  }

  countStitches(): number {
    let n = 0;
    for (const s of this.stitches) if (s.cmd === STITCH) n++;
    return n;
  }

  countJumps(): number {
    let n = 0;
    for (const s of this.stitches) if (s.cmd === JUMP) n++;
    return n;
  }
}

/** COLOR_CHANGE で区切った色ブロックの配列を返す (COLOR_CHANGE/END 自体は含まない) */
export function getColorBlocks(p: Pattern): Stitch[][] {
  const blocks: Stitch[][] = [];
  let cur: Stitch[] = [];
  for (const s of p.stitches) {
    if (s.cmd === COLOR_CHANGE) {
      blocks.push(cur);
      cur = [];
    } else if (s.cmd === END) {
      break;
    } else {
      cur.push(s);
    }
  }
  blocks.push(cur);
  return blocks;
}

/** 連続する同一コマンドのまとまり (コマンドブロック) を返す */
export function getCommandBlocks(stitches: Stitch[]): Stitch[][] {
  const blocks: Stitch[][] = [];
  let cur: Stitch[] = [];
  for (const s of stitches) {
    if (cur.length > 0 && cur[0].cmd !== s.cmd) {
      blocks.push(cur);
      cur = [];
    }
    cur.push(s);
  }
  if (cur.length > 0) blocks.push(cur);
  return blocks;
}
