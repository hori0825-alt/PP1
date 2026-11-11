// PP1 Sketch のドキュメントモデル。
//
// 描いたものが最初から「刺繍の部品」になっている、というのがこのアプリの前提。
//   - 線 (StrokeEl): ペンで描いた中心線 + 太さ。ランニング / 3重 / サテンで縫う。
//   - 面 (FillEl):   閉じた輪郭 (+ 穴)。タタミで塗る。
// 画像の減色・輪郭抽出のような「推測」は一切しない。
//
// レイヤー = 重ね順 = 縫い順。layers[0] が一番下 (最初に縫う)、末尾が一番上 (最後に縫う)。
// 座標はすべて mm、原点は刺繍枠の中心、+y が下。

export type Vec = { x: number; y: number };

/** 線の縫い方。auto は太さから自動で選ぶ */
export type StrokeStyle = "auto" | "running" | "triple" | "satin";

export interface ThreadRef {
  r: number;
  g: number;
  b: number;
  /** Brother PEC 色番号 (パレットから選んだ場合)。PES 出力でそのまま保持される */
  pecIndex?: number;
  name?: string;
}

export interface StrokeEl {
  kind: "stroke";
  id: string;
  /** 中心線 (mm)。平滑化済み */
  points: Vec[];
  /** 閉じた線 (円・四角の輪郭など)。始点と終点がつながっている */
  closed: boolean;
  /** 線の太さ (mm) */
  width: number;
  style: StrokeStyle;
  color: ThreadRef;
}

export interface FillEl {
  kind: "fill";
  id: string;
  /** 外周 (mm) */
  outer: Vec[];
  /** 穴 (mm)。縫わない */
  holes: Vec[][];
  /** タタミの角度 (度)。null なら設定の既定値 */
  angleDeg: number | null;
  color: ThreadRef;
}

/**
 * 画像 (下敷き・なぞり用)。刺繍には含まれない。
 * 画像の左上 p0・右上 p1・左下 p2 の3つの角 (mm) で位置・大きさ・回転・反転を表す。
 * 画像データ本体は images.ts のストアにあり、ここには imageId だけを持つ (保存・取り消しを軽くするため)。
 */
export interface ImageEl {
  kind: "image";
  id: string;
  imageId: string;
  p0: Vec;
  p1: Vec;
  p2: Vec;
  /** 不透明度 0〜1 */
  opacity: number;
}

/**
 * 縫い目 (PES などから読み込んだ針の位置の列)。形の情報はないので、針の位置をそのまま縫う。
 * 移動・拡大縮小・回転・色・縫い順・個々の針の位置は編集できる。
 */
export interface StitchesEl {
  kind: "stitches";
  id: string;
  /** 針を落とす位置 (mm)。この順に縫う */
  points: Vec[];
  color: ThreadRef;
}

/** 縫う部品 */
export type StitchEl = StrokeEl | FillEl | StitchesEl;
/** レイヤーに入るもの (縫う部品 + 画像) */
export type Element = StitchEl | ImageEl;

export const isStitchEl = (el: Element): el is StitchEl => el.kind !== "image";

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /**
   * レイヤー内の縫い順。
   *  - auto:   同じ色をまとめ、近い順に並べ替えて縫う (糸切り最少)
   *  - manual: 描いた順 (elements 配列の順) に縫う
   */
  order: "auto" | "manual";
  elements: Element[];
}

export type TrimPolicy = "auto" | "fewer" | "always";

export interface SketchSettings {
  name: string;
  /** タタミ行間隔 (mm) */
  fillSpacing: number;
  /** サテン間隔 (mm) */
  satinSpacing: number;
  /** タタミのステッチ長 (mm) */
  fillStitchLen: number;
  /** ランニングのステッチ長 (mm) */
  runLen: number;
  /** 面の既定角度 (度) */
  fillAngle: number;
  /** 下縫いを入れる */
  underlay: boolean;
  /**
   * 渡りの扱い。
   *  - auto:   隠れる経路はつなぎ縫い、短い渡りは渡り糸、遠いと糸切り
   *  - fewer:  糸切りを最少に (隠れない渡りも糸切りせず渡り糸にする)
   *  - always: 隠れないときは常に糸切り (渡り糸を残さない)
   */
  trimPolicy: TrimPolicy;
  /** auto のとき、この距離 (mm) 以上は糸切り */
  trimDistance: number;
  /** キャンバス (刺繍する範囲) の幅・高さ (mm)。PP1 の枠は最大 100×100 */
  canvasW: number;
  canvasH: number;
  /** (旧形式) 下絵 (dataURL)。読み込み時に画像レイヤーへ移す */
  underlayImage: string | null;
  underlayOpacity: number;
  underlayVisible: boolean;
}

export interface SketchDoc {
  app: "pp1-sketch";
  version: 1;
  layers: Layer[];
  settings: SketchSettings;
}

let seq = 0;
export function uid(prefix = "e"): string {
  seq++;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export const DEFAULT_SETTINGS: SketchSettings = {
  name: "SKETCH",
  fillSpacing: 0.4,
  satinSpacing: 0.38,
  fillStitchLen: 3.0,
  runLen: 2.0,
  fillAngle: 45,
  underlay: true,
  trimPolicy: "auto",
  trimDistance: 10,
  canvasW: 100,
  canvasH: 100,
  underlayImage: null,
  underlayOpacity: 0.35,
  underlayVisible: true,
};

export function newLayer(name: string): Layer {
  return { id: uid("L"), name, visible: true, locked: false, order: "auto", elements: [] };
}

export function newDoc(canvasW = 100, canvasH = 100): SketchDoc {
  // 刺繍の定石: 塗りを先に、線画を後 (上) に縫う
  return {
    app: "pp1-sketch",
    version: 1,
    layers: [newLayer("塗り"), newLayer("線画")],
    settings: { ...DEFAULT_SETTINGS, canvasW, canvasH },
  };
}

/** PP1 の刺繍枠 (mm) */
export const PP1_HOOP_MM = 100;

/** 画像の4つ目の角 (右下) */
export function imageCorners(el: ImageEl): Vec[] {
  const p3 = { x: el.p1.x + el.p2.x - el.p0.x, y: el.p1.y + el.p2.y - el.p0.y };
  return [el.p0, el.p1, p3, el.p2];
}

/** 太さから実際の縫い方を決める */
export function resolveStrokeStyle(el: StrokeEl): Exclude<StrokeStyle, "auto"> {
  if (el.style !== "auto") return el.style;
  if (el.width < 0.8) return "running";
  if (el.width < 1.4) return "triple";
  return "satin";
}

export function colorKey(c: ThreadRef): string {
  return `${c.r},${c.g},${c.b}`;
}

export function cloneDoc(doc: SketchDoc): SketchDoc {
  return JSON.parse(JSON.stringify(doc)) as SketchDoc;
}

/** 読み込んだ JSON を検証し、欠けている設定を補う */
export function parseDoc(text: string): SketchDoc {
  return parseDocWithImages(text).doc;
}

/** 作品ファイル (画像データ入り) を読む。images は imageId → dataURL */
export function parseDocWithImages(text: string): { doc: SketchDoc; images: Record<string, string> } {
  const raw = JSON.parse(text) as Partial<SketchDoc> & { images?: Record<string, string> };
  const images = raw.images && typeof raw.images === "object" ? raw.images : {};
  return { doc: parseDocObject(raw), images };
}

function parseDocObject(raw: Partial<SketchDoc>): SketchDoc {
  if (raw.app !== "pp1-sketch" || !Array.isArray(raw.layers)) {
    throw new Error("PP1 Sketch のファイルではありません");
  }
  return {
    app: "pp1-sketch",
    version: 1,
    layers: raw.layers,
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
  };
}
