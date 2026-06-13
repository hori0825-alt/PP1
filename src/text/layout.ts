// 文字列のレイアウト計算 (DOM 非依存・テスト可能)。
// 各グリフの advance (送り幅) を外から注入し、横書き/縦書き/円弧配置で
// 各グリフの基準位置と回転を計算する。グリフのアウトライン取得は
// ブラウザ層 (src/ui/textTool.ts) が担当する。
//
// 座標は内部単位 (0.1mm)、原点はデザイン中心。+y 下。

export interface GlyphMetric {
  char: string;
  /** 送り幅 (内部単位)。空白や全角もここで表現する */
  advance: number;
}

export type LayoutMode = "horizontal" | "vertical" | "arc";

export interface LayoutOptions {
  mode: LayoutMode;
  /** 文字の高さ (内部単位)。配置の基準サイズ */
  fontSize: number;
  /** 字間の追加スペース (内部単位) */
  letterSpacing?: number;
  /** 行間 (内部単位)。改行文字で使用 */
  lineHeight?: number;
  /** 円弧配置の半径 (内部単位) */
  arcRadius?: number;
  /** 円弧の中心角 (ラジアン)。文字列の中央がこの角度に来る。0 = 真上 */
  arcCenterAngle?: number;
  /** 円弧の上下: true で文字を外向き (上弧)、false で内向き (下弧) */
  arcConcaveDown?: boolean;
}

export interface GlyphPlacement {
  char: string;
  /** グリフ中心の位置 (内部単位) */
  x: number;
  y: number;
  /** 回転 (ラジアン) */
  rotation: number;
  /** このグリフの advance (スケール計算用) */
  advance: number;
}

/** 全グリフ配置のバウンディング (中心化に使う) */
function recenter(placements: GlyphPlacement[]): GlyphPlacement[] {
  if (placements.length === 0) return placements;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of placements) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return placements.map((p) => ({ ...p, x: p.x - cx, y: p.y - cy }));
}

/**
 * グリフ列のレイアウトを計算する。
 * metrics の char が "\n" の場合は改行として扱う (横書きのみ)。
 */
export function layoutText(metrics: GlyphMetric[], options: LayoutOptions): GlyphPlacement[] {
  const spacing = options.letterSpacing ?? 0;
  const lineHeight = options.lineHeight ?? options.fontSize * 1.4;

  if (options.mode === "arc") {
    return layoutArc(metrics, options, spacing);
  }
  if (options.mode === "vertical") {
    return layoutVertical(metrics, options, spacing, lineHeight);
  }
  return layoutHorizontal(metrics, options, spacing, lineHeight);
}

function layoutHorizontal(
  metrics: GlyphMetric[],
  options: LayoutOptions,
  spacing: number,
  lineHeight: number,
): GlyphPlacement[] {
  const placements: GlyphPlacement[] = [];
  let penX = 0;
  let penY = 0;
  for (const m of metrics) {
    if (m.char === "\n") {
      penX = 0;
      penY += lineHeight;
      continue;
    }
    placements.push({
      char: m.char,
      x: penX + m.advance / 2,
      y: penY,
      rotation: 0,
      advance: m.advance,
    });
    penX += m.advance + spacing;
  }
  return recenter(placements);
}

function layoutVertical(
  metrics: GlyphMetric[],
  options: LayoutOptions,
  spacing: number,
  lineWidth: number,
): GlyphPlacement[] {
  const placements: GlyphPlacement[] = [];
  let penY = 0;
  let colX = 0;
  for (const m of metrics) {
    if (m.char === "\n") {
      penY = 0;
      colX -= lineWidth; // 次の列は左へ (縦書きは右→左)
      continue;
    }
    // 縦書きは1文字 1 行高ぶん送る (全角想定で fontSize を使う)
    placements.push({
      char: m.char,
      x: colX,
      y: penY + options.fontSize / 2,
      rotation: 0,
      advance: m.advance,
    });
    penY += options.fontSize + spacing;
  }
  return recenter(placements);
}

function layoutArc(metrics: GlyphMetric[], options: LayoutOptions, spacing: number): GlyphPlacement[] {
  const radius = options.arcRadius ?? options.fontSize * 4;
  const centerAngle = options.arcCenterAngle ?? 0;
  const concaveDown = options.arcConcaveDown ?? false;

  const glyphs = metrics.filter((m) => m.char !== "\n");
  const totalArc = glyphs.reduce((s, m) => s + m.advance + spacing, -spacing);
  // 各グリフ中心の弧長位置 (文字列中央を 0 に)
  let arcPos = -totalArc / 2;
  const placements: GlyphPlacement[] = [];
  for (const m of glyphs) {
    const center = arcPos + m.advance / 2;
    // 角度: 弧長 / 半径。上弧は時計回りに増やす
    const angle = centerAngle + (concaveDown ? -1 : 1) * (center / radius);
    const dir = concaveDown ? 1 : -1;
    placements.push({
      char: m.char,
      x: radius * Math.sin(angle),
      y: dir * radius * Math.cos(angle),
      // 接線方向に回転 (文字の上が円の外/内を向く)
      rotation: concaveDown ? -angle + Math.PI : -angle,
      advance: m.advance,
    });
    arcPos += m.advance + spacing;
  }
  return recenter(placements);
}
