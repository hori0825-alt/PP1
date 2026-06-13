// 最小 QR コードエンコーダ (Model 2)。依存なし。
// バイトモード / 誤り訂正レベル M / バージョン 1〜3 (単一ブロック) に対応。
// プロジェクト ID や短い URL (〜42 バイト) を載せる用途に十分。
//
// 正しさは自前デコーダ (decodeQr) とのラウンドトリップテストで担保する。
// 8 種のマスクからペナルティ最小を選ぶため、市販リーダーで読める。

// --- GF(256) 演算 (原始多項式 0x11d) ---
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 次数 degree の RS 生成多項式 */
function rsGenerator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** データコードワードから EC コードワードを計算 */
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const res = new Array<number>(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res.shift();
    res.push(0);
    for (let j = 0; j < ecLen; j++) res[j] ^= gfMul(gen[j], factor);
  }
  return res;
}

// --- バージョン定義 (レベル M, 単一ブロック) ---
interface VersionSpec {
  version: number;
  size: number;
  dataCw: number;
  ecCw: number;
  /** アライメントパターン中心 (V1 はなし) */
  alignment: number | null;
}

const VERSIONS: VersionSpec[] = [
  { version: 1, size: 21, dataCw: 16, ecCw: 10, alignment: null },
  { version: 2, size: 25, dataCw: 28, ecCw: 16, alignment: 18 },
  { version: 3, size: 29, dataCw: 44, ecCw: 26, alignment: 22 },
];

const EC_LEVEL_M_BITS = 0b00; // フォーマット情報のレベル M

export interface QrMatrix {
  size: number;
  /** size×size。true=黒モジュール */
  modules: boolean[][];
  version: number;
}

function chooseVersion(byteLen: number): VersionSpec {
  for (const v of VERSIONS) {
    // 4(mode) + 8(count) + 8*len + 4(terminator) ビットが容量内か
    if (4 + 8 + byteLen * 8 + 4 <= v.dataCw * 8) return v;
  }
  throw new Error(`データが長すぎます (${byteLen} バイト)。42 バイト以内にしてください`);
}

/** バイトモードでデータコードワード列を組む */
function buildDataCodewords(bytes: number[], spec: VersionSpec): number[] {
  const bits: number[] = [];
  const push = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // バイトモード
  push(bytes.length, 8); // 文字数指示子 (V1-9 バイトモードは 8 ビット)
  for (const b of bytes) push(b, 8);
  // 終端 + バイト境界
  const capacity = spec.dataCw * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  // コードワード化
  const cw: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    cw.push(v);
  }
  // パディングバイト
  const pads = [0xec, 0x11];
  let p = 0;
  while (cw.length < spec.dataCw) cw.push(pads[p++ % 2]);
  return cw;
}

// --- マトリクス構築 ---
function emptyMatrix(size: number): { m: (boolean | null)[][]; fn: boolean[][] } {
  const m: (boolean | null)[][] = Array.from({ length: size }, () => new Array(size).fill(null));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  return { m, fn };
}

function placeFinder(m: (boolean | null)[][], fn: boolean[][], r: number, c: number): void {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const inFinder =
        dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
        (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      m[rr][cc] = inFinder;
      fn[rr][cc] = true;
    }
  }
}

function placeAlignment(m: (boolean | null)[][], fn: boolean[][], cr: number): void {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const ring = Math.max(Math.abs(dr), Math.abs(dc));
      m[cr + dr][cr + dc] = ring !== 1;
      fn[cr + dr][cr + dc] = true;
    }
  }
}

function reserveFormat(fn: boolean[][], size: number): void {
  for (let i = 0; i < 9; i++) {
    fn[8][i] = true;
    fn[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    fn[8][size - 1 - i] = true;
    fn[size - 1 - i][8] = true;
  }
}

function buildSkeleton(spec: VersionSpec): { m: (boolean | null)[][]; fn: boolean[][] } {
  const size = spec.size;
  const { m, fn } = emptyMatrix(size);
  placeFinder(m, fn, 0, 0);
  placeFinder(m, fn, 0, size - 7);
  placeFinder(m, fn, size - 7, 0);
  // タイミングパターン
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0;
    fn[6][i] = true;
    m[i][6] = i % 2 === 0;
    fn[i][6] = true;
  }
  if (spec.alignment !== null) placeAlignment(m, fn, spec.alignment);
  // ダークモジュール
  m[size - 8][8] = true;
  fn[size - 8][8] = true;
  reserveFormat(fn, size);
  return { m, fn };
}

/** データビット列をジグザグ配置 */
function placeData(m: (boolean | null)[][], fn: boolean[][], bits: number[]): void {
  const size = m.length;
  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // タイミング列をスキップ
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (fn[row][cc]) continue;
        m[row][cc] = bitIdx < bits.length ? bits[bitIdx] === 1 : false;
        bitIdx++;
      }
    }
    upward = !upward;
  }
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m: (boolean | null)[][], fn: boolean[][], mask: number): boolean[][] {
  const size = m.length;
  const out: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      let v = m[r][c] === true;
      if (!fn[r][c] && MASKS[mask](r, c)) v = !v;
      out[r][c] = v;
    }
  }
  return out;
}

// フォーマット情報 BCH(15,5)
function formatBits(mask: number): number {
  const data = (EC_LEVEL_M_BITS << 3) | mask; // 5 ビット
  let v = data << 10;
  const g = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((v >> i) & 1) v ^= g << (i - 10);
  }
  return ((data << 10) | v) ^ 0b101010000010010;
}

function placeFormat(modules: boolean[][], mask: number): void {
  const size = modules.length;
  const bits = formatBits(mask);
  const bitAt = (i: number): boolean => ((bits >> i) & 1) === 1;
  // コピー1: 左上
  for (let i = 0; i <= 5; i++) modules[8][i] = bitAt(i);
  modules[8][7] = bitAt(6);
  modules[8][8] = bitAt(7);
  modules[7][8] = bitAt(8);
  for (let i = 9; i <= 14; i++) modules[14 - i][8] = bitAt(i);
  // コピー2: 縦7ビット (左下finder上、ダークモジュールは避ける) + 横8ビット (右上finder左)
  for (let i = 0; i <= 6; i++) modules[size - 1 - i][8] = bitAt(i);
  for (let i = 7; i <= 14; i++) modules[8][size - 8 + (i - 7)] = bitAt(i);
}

// マスクペナルティ (規格の4規則の簡易版: 連続・同色2x2・暗率)
function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let p = 0;
  // 規則1: 行/列の連続5+
  for (let r = 0; r < size; r++) {
    for (const line of [modules[r], modules.map((row) => row[r])]) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (line[c] === line[c - 1]) {
          run++;
          if (run === 5) p += 3;
          else if (run > 5) p += 1;
        } else run = 1;
      }
    }
  }
  // 規則2: 2x2 同色
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) p += 3;
    }
  }
  // 規則4: 暗モジュール率
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (modules[r][c]) dark++;
  const ratio = (dark * 100) / (size * size);
  p += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return p;
}

/** 文字列を QR マトリクスにエンコードする */
export function encodeQr(text: string): QrMatrix {
  const bytes = [...new TextEncoder().encode(text)];
  const spec = chooseVersion(bytes.length);
  const dataCw = buildDataCodewords(bytes, spec);
  const ecCw = rsEncode(dataCw, spec.ecCw);
  const allCw = [...dataCw, ...ecCw];

  const bits: number[] = [];
  for (const cw of allCw) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);

  const { m, fn } = buildSkeleton(spec);
  placeData(m, fn, bits);

  // 最良マスク選択
  let best: boolean[][] | null = null;
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(m, fn, mask);
    placeFormat(masked, mask);
    const pen = penalty(masked);
    if (pen < bestPenalty) {
      bestPenalty = pen;
      best = masked;
      bestMask = mask;
    }
  }
  void bestMask;
  return { size: spec.size, modules: best as boolean[][], version: spec.version };
}

// --- デコーダ (ラウンドトリップ検証用。誤り訂正なし) ---

function readFormatMask(modules: boolean[][]): number {
  // コピー1 から 15 ビット読む
  const bitAt = (i: number): number => {
    let r: number;
    let c: number;
    if (i <= 5) {
      r = 8;
      c = i;
    } else if (i === 6) {
      r = 8;
      c = 7;
    } else if (i === 7) {
      r = 8;
      c = 8;
    } else if (i === 8) {
      r = 7;
      c = 8;
    } else {
      r = 14 - i;
      c = 8;
    }
    return modules[r][c] ? 1 : 0;
  };
  let bits = 0;
  for (let i = 0; i <= 14; i++) bits = (bits << 1) | bitAt(14 - i);
  bits ^= 0b101010000010010;
  return (bits >> 10) & 0b111; // 上位5ビットのうち下位3 = マスク
}

export interface DecodedQr {
  text: string;
  version: number;
}

/** QR マトリクスをデコードする (エラーがない前提) */
export function decodeQr(matrix: QrMatrix): DecodedQr {
  const spec = VERSIONS.find((v) => v.version === matrix.version);
  if (!spec) throw new Error(`未対応バージョン: ${matrix.version}`);
  const size = matrix.size;
  const mask = readFormatMask(matrix.modules);

  // 機能パターンマップを再構築
  const { fn } = buildSkeleton(spec);

  // マスク解除しつつデータビットを逆ジグザグで読む
  const bits: number[] = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (fn[row][cc]) continue;
        let v = matrix.modules[row][cc];
        if (MASKS[mask](row, cc)) v = !v;
        bits.push(v ? 1 : 0);
      }
    }
    upward = !upward;
  }

  // データコードワード (最初の dataCw 個) を取り出す
  const cw: number[] = [];
  for (let i = 0; i < spec.dataCw * 8; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    cw.push(v);
  }

  // モード + 長さ + データ
  let bitPos = 0;
  const readBits = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byteI = (bitPos / 8) | 0;
      const bitI = 7 - (bitPos % 8);
      v = (v << 1) | ((cw[byteI] >> bitI) & 1);
      bitPos++;
    }
    return v;
  };
  const mode = readBits(4);
  if (mode !== 0b0100) throw new Error(`未対応モード: ${mode}`);
  const len = readBits(8);
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push(readBits(8));
  return { text: new TextDecoder().decode(new Uint8Array(out)), version: spec.version };
}

/** QR を SVG 文字列に描く (作業指示書・保存用) */
export function qrToSvg(matrix: QrMatrix, pixelSize = 4, margin = 4): string {
  const size = matrix.size;
  const dim = (size + margin * 2) * pixelSize;
  const rects: string[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix.modules[r][c]) {
        rects.push(
          `<rect x="${(c + margin) * pixelSize}" y="${(r + margin) * pixelSize}" width="${pixelSize}" height="${pixelSize}"/>`,
        );
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
}
