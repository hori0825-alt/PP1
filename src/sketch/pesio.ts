// PES の読み書き (PP1 Sketch 用)。
//
// 書き出し: PES のラッパー部分 (PEC ブロックの前) に、作品データ (線・面・レイヤー・設定) を
//   埋め込む。刺繍機・Artspira は 0x08 のオフセットから PEC (ステッチ) を読むので影響しない。
// 読み込み:
//   1. 埋め込みデータがあれば、描いたときと同じ編集できる作品に戻す
//   2. なければ (他のソフトの PES・以前の版の PES)、針の位置を「縫い目」部品として取り込む。
//      色ごとにレイヤーを分け、元の縫い順をそのまま保つ

import { BROTHER_PALETTE } from "../export/brotherPalette";
import { decodePes } from "../export/decode";
import { dropHiddenRunning, reconstructRun } from "./reconstruct";
import {
  newLayer,
  parseDoc,
  PP1_HOOP_MM,
  newDoc,
  uid,
  type SketchDoc,
  type StitchEl,
  type StitchesEl,
  type ThreadRef,
  type Vec,
} from "./model";

const MAGIC = "PP1SKETCH";
const FORMAT = 1;

/** 小数を 0.001 に丸めて容量を減らす */
function compactJson(doc: SketchDoc): string {
  const { underlayImage: _drop, ...settings } = doc.settings;
  void _drop;
  return JSON.stringify({ ...doc, settings: { ...settings, underlayImage: null } }, (_k, v) =>
    typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v,
  );
}

/** PES に埋め込む作品データ (MAGIC + 形式番号 + 長さ + JSON) */
export function encodeEmbedded(doc: SketchDoc): Uint8Array {
  const json = new TextEncoder().encode(compactJson(doc));
  const out = new Uint8Array(MAGIC.length + 1 + 4 + json.length);
  for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC.charCodeAt(i);
  let p = MAGIC.length;
  out[p++] = FORMAT;
  out[p++] = json.length & 0xff;
  out[p++] = (json.length >> 8) & 0xff;
  out[p++] = (json.length >> 16) & 0xff;
  out[p++] = (json.length >>> 24) & 0xff;
  out.set(json, p);
  return out;
}

/** PES に埋め込まれた作品データを探す。なければ null */
export function extractEmbedded(data: Uint8Array): SketchDoc | null {
  if (data.length < 12) return null;
  const pecOffset = data[8] | (data[9] << 8) | (data[10] << 16) | (data[11] << 24);
  const end = Math.min(data.length, pecOffset > 0 ? pecOffset : data.length);
  for (let i = 12; i + MAGIC.length + 5 <= end; i++) {
    let hit = true;
    for (let k = 0; k < MAGIC.length; k++) {
      if (data[i + k] !== MAGIC.charCodeAt(k)) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    let p = i + MAGIC.length;
    const format = data[p++];
    if (format !== FORMAT) return null;
    const len = (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0;
    p += 4;
    if (p + len > data.length) return null;
    try {
      return parseDoc(new TextDecoder().decode(data.subarray(p, p + len)));
    } catch {
      return null;
    }
  }
  return null;
}

export interface PesImport {
  doc: SketchDoc;
  /** 埋め込みデータから完全に復元できた */
  restored: boolean;
  /** 縫い目から線・面を推定した */
  reconstructed: boolean;
  stitches: number;
  colors: number;
}

function threadFor(pecIndex: number): ThreadRef {
  const t = BROTHER_PALETTE.find((p) => p.pecIndex === pecIndex) ?? BROTHER_PALETTE.find((p) => p.pecIndex === 20)!;
  return { r: t.r, g: t.g, b: t.b, pecIndex: t.pecIndex, name: t.name };
}

/** PES を読み込む */
export interface PesImportOptions {
  /** 編集用データがないとき、縫い目から線・面を推定する (false なら縫い目のまま) */
  reconstruct?: boolean;
}

export function importPes(data: Uint8Array, fallbackName = "PES", opts: PesImportOptions = {}): PesImport {
  const reconstruct = opts.reconstruct ?? true;
  const magic = String.fromCharCode(...data.subarray(0, 4));
  if (magic !== "#PES") throw new Error("PES ファイルではありません");

  const embedded = extractEmbedded(data);
  if (embedded) {
    let n = 0;
    for (const l of embedded.layers) n += l.elements.length;
    return { doc: embedded, restored: true, reconstructed: false, stitches: 0, colors: n };
  }

  const dec = decodePes(data);
  // 針の位置を、糸切り・渡り・色替えで区切った「縫い目」の列に分ける
  const blocks: Vec[][][] = [[]];
  let run: Vec[] | null = null;
  let x = 0;
  let y = 0;
  let total = 0;
  const close = () => {
    if (run) {
      // 同じ位置の針 (ジャンプ着地のアンカー) は1つにまとめる
      const pts = run.filter((p, i) => i === 0 || p.x !== run![i - 1].x || p.y !== run![i - 1].y);
      if (pts.length >= 2) blocks[blocks.length - 1].push(pts);
    }
    run = null;
  };
  for (const op of dec.ops) {
    const before = { x: x / 10, y: y / 10 };
    x += op.dx;
    y += op.dy;
    if (op.kind === "colorChange") {
      close();
      blocks.push([]);
    } else if (op.kind === "stitch") {
      if (!run) run = [before];
      run.push({ x: x / 10, y: y / 10 });
      total++;
    } else {
      close();
    }
  }
  close();

  // 全体の外接矩形
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of blocks)
    for (const r of b)
      for (const p of r) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
  if (!isFinite(minX)) throw new Error("この PES には縫い目がありません");

  // キャンバス: PP1 の枠 (100mm) に収まるなら 100×100、超えるなら収まる大きさ
  const w = maxX - minX;
  const h = maxY - minY;
  const cw = w <= PP1_HOOP_MM ? PP1_HOOP_MM : Math.ceil(w + 4);
  const ch = h <= PP1_HOOP_MM ? PP1_HOOP_MM : Math.ceil(h + 4);
  // 原点 (枠の中心) からはみ出す配置なら中央に寄せる
  const fits = minX >= -cw / 2 && maxX <= cw / 2 && minY >= -ch / 2 && maxY <= ch / 2;
  const ox = fits ? 0 : -(minX + maxX) / 2;
  const oy = fits ? 0 : -(minY + maxY) / 2;

  const doc = newDoc(cw, ch);
  const name = (dec.label || fallbackName).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
  doc.settings.name = name || "PES";
  doc.layers = [];
  // 色ブロックごとに部品を作る (縫う順のまま)
  const perBlock: { color: ThreadRef; els: StitchEl[] }[] = [];
  blocks.forEach((runs, i) => {
    if (runs.length === 0) return;
    const color = threadFor(dec.paletteIndices[i] ?? 20);
    const els: StitchEl[] = [];
    for (const run of runs) {
      const pts = run.map((p) => ({ x: p.x + ox, y: p.y + oy }));
      if (reconstruct) els.push(...reconstructRun(pts, color));
      else els.push({ kind: "stitches", id: uid(), points: pts, color } satisfies StitchesEl);
    }
    perBlock.push({ color, els });
  });
  // 後で縫う面・太い線の下に隠れる下縫い・つなぎ縫いを除く (全体の縫い順で判定)
  if (reconstruct) {
    const keep = new Set(dropHiddenRunning(perBlock.flatMap((b) => b.els)).map((e) => e.id));
    for (const b of perBlock) b.els = b.els.filter((e) => keep.has(e.id));
  }
  for (const b of perBlock) {
    if (b.els.length === 0) continue;
    const layer = newLayer(`${doc.layers.length + 1}. ${b.color.name ?? "色"}`);
    // 元の縫い順をそのまま保つ
    layer.order = "manual";
    layer.elements = b.els;
    doc.layers.push(layer);
  }
  return { doc, restored: false, reconstructed: reconstruct, stitches: total, colors: doc.layers.length };
}
