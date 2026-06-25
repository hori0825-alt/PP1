// ラベルマップから色ごとのベクター領域 (Region) を抽出する。
//
// 手法: ピクセル境界エッジ追跡。
//   各ピクセルの4辺のうち「隣が別ラベル」の辺を向き付きエッジとして集め、
//   頂点 (ピクセル角) を辿って閉ループに連結する。
//   ループの符号付き面積が正 → 外周、負 → 穴。
//   交点で複数の出エッジがある場合は最も時計回り側を選ぶ (4連結に一致)。
//
// 抽出後に Douglas-Peucker で点数削減 → Chaikin でスムージングを行い、
// ガタガタしたピクセル輪郭を滑らかな閉路に変換する。

import { mm } from "../core/constants";
import {
  chaikinClosedPreserveCorners,
  polygonCentroid,
  pointInPolygon,
  selfIntersects,
  signedArea,
  simplifyClosed,
} from "../core/geometry";
import type { Region } from "../core/region";
import type { Point } from "../core/types";
import { rgbToLab, labDist2 } from "./quantize";
import type { LabelMap } from "./raster";

export interface ExtractOptions {
  /** 1ピクセルあたりの内部単位 (0.1mm) 数 */
  unitsPerPixel: number;
  /** これ未満の面積 (内部単位²) の領域は捨てる。デフォルト 3mm² */
  minRegionArea?: number;
  /** Douglas-Peucker の許容誤差 (内部単位)。デフォルト 0.15mm */
  simplifyTolerance?: number;
  /** Chaikin スムージングの回数。デフォルト 2 */
  smoothingIterations?: number;
  /**
   * 小特徴保護のコントラスト閾値 (Lab ΔE)。面積不足の領域でも、パレット内の
   * 他色とこれ以上のコントラストがあれば保持する。既定 25。0 で無効。
   */
  featureContrast?: number;
}

/** 面積不足で除外された領域 (キャンバスハイライト + 復元用) */
export interface ExcludedRegion {
  outer: Point[];
  color: { r: number; g: number; b: number };
  /** 面積 (mm²) */
  areaMm2: number;
}

export interface ExtractResult {
  regions: Region[];
  excludedRegions: ExcludedRegion[];
}

/** 画像を target サイズ (内部単位) に収めるときの unitsPerPixel を返す */
export function fitUnitsPerPixel(width: number, height: number, targetUnits = mm(100)): number {
  return targetUnits / Math.max(width, height);
}

interface Loop {
  /** ピクセル角座標のループ */
  vertices: Point[];
  area: number;
}

/** 1色分の境界エッジを閉ループ群に連結する */
function traceLoops(map: LabelMap, color: number): Loop[] {
  const { width: w, height: h, labels } = map;
  const vw = w + 1; // 頂点グリッド幅
  const at = (x: number, y: number): number =>
    x < 0 || x >= w || y < 0 || y >= h ? -2 : labels[y * w + x];

  // 始点頂点 → 終点頂点のリスト (1頂点から最大2本)
  const edges = new Map<number, number[]>();
  const addEdge = (sx: number, sy: number, ex: number, ey: number): void => {
    const key = sy * vw + sx;
    const list = edges.get(key);
    if (list) list.push(ey * vw + ex);
    else edges.set(key, [ey * vw + ex]);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (labels[y * w + x] !== color) continue;
      // 時計回り (画面座標系) にピクセルを囲む向きでエッジを張る
      if (at(x, y - 1) !== color) addEdge(x, y, x + 1, y); // 上辺 →
      if (at(x + 1, y) !== color) addEdge(x + 1, y, x + 1, y + 1); // 右辺 ↓
      if (at(x, y + 1) !== color) addEdge(x + 1, y + 1, x, y + 1); // 下辺 ←
      if (at(x - 1, y) !== color) addEdge(x, y + 1, x, y); // 左辺 ↑
    }
  }

  const loops: Loop[] = [];
  for (const [startKey, list] of edges) {
    while (list.length > 0) {
      // 1本取り出してループを辿る
      let curKey = startKey;
      let nextKey = list.pop() as number;
      const verts: Point[] = [{ x: curKey % vw, y: (curKey / vw) | 0 }];

      while (nextKey !== startKey) {
        verts.push({ x: nextKey % vw, y: (nextKey / vw) | 0 });
        const candidates = edges.get(nextKey);
        if (!candidates || candidates.length === 0) break; // 不整合 (理論上起きない)
        let chosen = 0;
        if (candidates.length > 1) {
          // 角接触: 入射方向に対して最も時計回り側のエッジを選ぶ
          const dx = (nextKey % vw) - (curKey % vw);
          const dy = ((nextKey / vw) | 0) - ((curKey / vw) | 0);
          const cwX = -dy; // 画面座標系で時計回りに90°回した方向
          const cwY = dx;
          for (let c = 0; c < candidates.length; c++) {
            const ex = (candidates[c] % vw) - (nextKey % vw);
            const ey = ((candidates[c] / vw) | 0) - ((nextKey / vw) | 0);
            if (ex === cwX && ey === cwY) chosen = c;
          }
        }
        curKey = nextKey;
        nextKey = candidates.splice(chosen, 1)[0];
      }
      loops.push({ vertices: verts, area: signedArea(verts) });
    }
  }
  return loops;
}

/**
 * ラベルマップから全色の Region を抽出する。
 * 出力座標は内部単位 (0.1mm)、原点はラベルマップ中心。
 */
export function extractRegions(map: LabelMap, options: ExtractOptions): ExtractResult {
  const scale = options.unitsPerPixel;
  const minArea = options.minRegionArea ?? 300; // 3mm²
  // ピクセル空間で適用。ピクセル境界の階段ノイズ (振幅 ~0.5px) を確実に
  // 除去するため、最低 0.75px の許容誤差を保証する
  const tolerance = Math.max((options.simplifyTolerance ?? mm(0.15)) / scale, 0.75);
  const smoothing = options.smoothingIterations ?? 2;
  const { width: w, height: h } = map;

  // コントラスト保護: パレット各色の Lab 値を事前計算
  const featureContrastDE = options.featureContrast ?? 25;
  const contrast2 = featureContrastDE * featureContrastDE;
  const paletteLab = map.palette.map((c) => rgbToLab(c.r, c.g, c.b));
  // 高コントラスト小特徴は面積閾値を大幅に下げて保持する (白目・ハイライト等)
  const minFeatureArea = Math.max(4, Math.round(minArea / 30));

  const toUnits = (p: Point): Point => ({
    x: (p.x - w / 2) * scale,
    y: (p.y - h / 2) * scale,
  });

  const refine = (path: Point[]): Point[] => {
    // DP で階段ノイズを除去 → 角を保存しつつ曲線だけ平滑化 → 再 DP で冗長点を除く。
    // ロゴ・文字の直角やセリフが鈍らないよう、鋭い屈曲は固定する。
    let p = simplifyClosed(path, tolerance);
    p = chaikinClosedPreserveCorners(p, smoothing);
    p = simplifyClosed(p, tolerance / 2);
    return p.map(toUnits);
  };

  const regions: Region[] = [];
  const excludedRegions: ExcludedRegion[] = [];

  for (let color = 0; color < map.palette.length; color++) {
    const loops = traceLoops(map, color);
    const outers = loops.filter((l) => l.area > 0);
    const holes = loops.filter((l) => l.area < 0);

    // 穴を「重心を含む最小の外周」に割り当てる
    const holeOf = new Map<Loop, Loop[]>();
    for (const o of outers) holeOf.set(o, []);
    for (const hole of holes) {
      const c = polygonCentroid(hole.vertices);
      const holeMag = Math.abs(hole.area);
      let best: Loop | null = null;
      for (const o of outers) {
        // 穴は必ず外周より小さい。大きければ誤包含なので候補から外す
        // (誤割り当てで net 面積が負になり、白目などの領域が丸ごと消える不具合を防ぐ)
        if (o.area <= holeMag) continue;
        if (o.area > (best?.area ?? Infinity)) continue;
        if (pointInPolygon(c, o.vertices)) best = o;
      }
      if (best) (holeOf.get(best) as Loop[]).push(hole);
    }

    for (const o of outers) {
      const oHoles = holeOf.get(o) as Loop[];
      const netAreaPx = o.area + oHoles.reduce((s, hh) => s + hh.area, 0); // 穴は負
      const areaUnits2 = netAreaPx * scale * scale;
      if (areaUnits2 < minArea) {
        // コントラスト保護: この色が他のパレット色と高コントラストなら閾値を緩和
        let keep = false;
        if (featureContrastDE > 0 && areaUnits2 >= minFeatureArea) {
          const thisLab = paletteLab[color];
          for (let c2 = 0; c2 < paletteLab.length; c2++) {
            if (c2 === color) continue;
            if (labDist2(thisLab, paletteLab[c2]) > contrast2) { keep = true; break; }
          }
        }
        if (!keep) {
          const outerPath = refine(o.vertices);
          if (outerPath.length >= 3) {
            excludedRegions.push({
              outer: outerPath,
              color: map.palette[color],
              areaMm2: Math.round(areaUnits2) / 100,
            });
          }
          continue;
        }
      }

      const outerPath = refine(o.vertices);
      if (outerPath.length < 3) continue;
      const holePaths = oHoles
        .map((hh) => refine(hh.vertices))
        // 穴は小さくても残す: 線画の白目・リボンの抜きを塗り潰さない
        // (穴 = 非縫い域なので針数も減る)。極小ノイズだけ落とす floor を維持。
        .filter((p) => p.length >= 3 && Math.abs(signedArea(p)) >= Math.max(4, minArea / 32));

      const region: Region = {
        outer: outerPath,
        holes: holePaths,
        color: map.palette[color],
      };
      if (selfIntersects(outerPath)) region.selfIntersecting = true;
      regions.push(region);
    }
  }
  return { regions, excludedRegions };
}
