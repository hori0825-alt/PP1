// オートデジタイズ (Auto Trace): 画像 → 刺繍オブジェクト群。
// ステッチは作らず、編集可能な EmbObject (形状 + 縫い設定) を生成する。

import { quantize, type QuantizeResult, type RasterImage } from "../digitize/quantize";
import { loopArea, simplifyLoop, smoothLoop, traceContours, type Pt } from "../digitize/contour";
import {
  analyzeColorFragmentation,
  groupRegions,
  labelColorComponents,
  regionInteriorPoint,
  skeletonRunFromMask,
} from "../digitize/pipeline";
import {
  DEFAULT_GLOBAL,
  defaultObjectSettings,
  newObjectId,
  type EmbObject,
  type GlobalSettings,
  type StitchKind,
} from "./object";

/** 処理画像ピクセル ⇔ パターン座標 (0.1mm) の変換情報 */
export interface Transform {
  /** units / px */
  scale: number;
  cx: number;
  cy: number;
}

export interface ObjectizeResult {
  objects: EmbObject[];
  /** 既定の縫い順 (オブジェクトID)。断片化の激しい色 → 線画系の色 */
  order: string[];
  quant: QuantizeResult;
  transform: Transform;
  mmPerPx: number;
}

export function objectize(img: RasterImage, g: GlobalSettings): ObjectizeResult {
  const sizeUnits = Math.min(g.sizeMm, 100) * 10;
  const approxScale = sizeUnits / Math.max(img.width, img.height);
  const pxPerMm = 10 / approxScale;
  const minRegionPx = Math.max(1, Math.round(g.minRegionMm2 * pxPerMm * pxPerMm));
  const mergeTolTable: Record<number, number> = { 1: 3.5, 2: 6, 3: 10 };

  const quant = quantize(img, {
    maxColors: g.maxColors,
    alphaThreshold: 128,
    autoBackground: g.autoBackground,
    bgTolerance: 40,
    minRegionPx,
    mergeTol: mergeTolTable[Math.round(g.colorMergeLevel)] ?? 6,
  });

  // 前景バウンディングボックス → スケール/中心
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < quant.height; y++) {
    for (let x = 0; x < quant.width; x++) {
      if (quant.labels[y * quant.width + x] < 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) {
    return {
      objects: [],
      order: [],
      quant,
      transform: { scale: 1, cx: 0, cy: 0 },
      mmPerPx: approxScale / 10,
    };
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const scale = sizeUnits / Math.max(bw, bh);
  const cx = (minX + maxX + 1) / 2;
  const cy = (minY + maxY + 1) / 2;
  const mmPerPx = scale / 10;
  const toUnits = ([x, y]: Pt): Pt => [(x - cx) * scale, (y - cy) * scale];

  const objects: EmbObject[] = [];
  const objectsByColor = new Map<number, EmbObject[]>();

  for (let c = 0; c < quant.palette.length; c++) {
    const { compMap, comps } = labelColorComponents(quant.labels, quant.width, quant.height, c);

    // 輪郭 (px空間、平滑化済み) → 領域 → comp へ割当
    const rawLoops = traceContours(quant.labels, quant.width, quant.height, c);
    const loopsPx: Pt[][] = [];
    for (const raw of rawLoops) {
      if (Math.abs(loopArea(raw)) < 2) continue;
      const simplified = simplifyLoop(raw, 0.75);
      const smoothed = smoothLoop(simplified, g.outlineSmoothing);
      if (smoothed.length >= 3) loopsPx.push(smoothed);
    }
    const regions = groupRegions(loopsPx);
    const ringsByComp = new Map<number, Pt[][]>();
    for (const region of regions) {
      const ip = regionInteriorPoint(region);
      if (!ip) continue;
      const xi = Math.min(quant.width - 1, Math.max(0, Math.round(ip[0])));
      const yi = Math.min(quant.height - 1, Math.max(0, Math.round(ip[1])));
      const cid = compMap[yi * quant.width + xi];
      if (cid < 0) continue;
      const rings = [region.outer, ...region.holes];
      const prev = ringsByComp.get(cid);
      if (prev) prev.push(...rings);
      else ringsByComp.set(cid, rings);
    }

    const list: EmbObject[] = [];
    for (const comp of comps) {
      const rings = ringsByComp.get(comp.id);
      if (!rings || rings.length === 0) continue;

      // 縫いモードの自動判定: 幅 + 形状 (コンパクトネス)
      let kind: StitchKind = "tatami";
      let estWidthMm = Infinity;
      let mask: EmbObject["mask"] = null;
      const hydraulicMm = ((2 * comp.area) / Math.max(1, comp.boundary)) * mmPerPx;
      const compactness = (comp.boundary * comp.boundary) / Math.max(1, comp.area);
      const x0 = Math.max(0, comp.x0 - 1);
      const y0 = Math.max(0, comp.y0 - 1);
      const mw = Math.min(quant.width - 1, comp.x1 + 1) - x0 + 1;
      const mh = Math.min(quant.height - 1, comp.y1 + 1) - y0 + 1;

      if (
        g.autoThinDetect &&
        hydraulicMm <= g.satinMaxWidthMm * 1.8 &&
        compactness > 40 &&
        mw >= 2 &&
        mh >= 2
      ) {
        const data = new Uint8Array(mw * mh);
        for (let y = 0; y < mh; y++) {
          for (let x = 0; x < mw; x++) {
            if (compMap[(y + y0) * quant.width + (x + x0)] === comp.id) data[y * mw + x] = 1;
          }
        }
        const probe = skeletonRunFromMask(data, mw, mh, x0, y0, g, mmPerPx, toUnits);
        if (probe) {
          kind = probe.mode;
          estWidthMm = probe.widthMm;
          mask = { x0, y0, w: mw, h: mh, data };
        }
      }

      list.push({
        id: newObjectId(),
        name: "",
        paletteIndex: c,
        ringsPx: rings,
        mask,
        estWidthMm,
        areaPx: comp.area,
        settings: defaultObjectSettings(kind),
      });
    }
    // 面積順に並べて名前を付与
    list.sort((a, b) => b.areaPx - a.areaPx);
    list.forEach((o, i) => {
      o.name = `色${c + 1}-${i + 1}`;
      objects.push(o);
    });
    objectsByColor.set(c, list);
  }

  // 既定の縫い順: 断片化の激しい色を先に / 線画系の色を最後に。
  // 色内は重心の nearest-neighbor (Closest Point)
  const stats = analyzeColorFragmentation(
    quant.labels,
    quant.width,
    quant.height,
    mmPerPx,
    g.satinMaxWidthMm,
  );
  const colorIdxs = [...objectsByColor.keys()];
  const isLineLike = (c: number): boolean => {
    const s = stats.get(c);
    return !!s && s.totalArea > 0 && s.thinArea / s.totalArea > 0.6;
  };
  const byFrag = (a: number, b: number): number => {
    const sa = stats.get(a);
    const sb = stats.get(b);
    if ((sb?.compCount ?? 0) !== (sa?.compCount ?? 0)) {
      return (sb?.compCount ?? 0) - (sa?.compCount ?? 0);
    }
    return (sb?.totalArea ?? 0) - (sa?.totalArea ?? 0);
  };
  const colorOrder = [
    ...colorIdxs.filter((c) => !isLineLike(c)).sort(byFrag),
    ...colorIdxs.filter(isLineLike).sort(byFrag),
  ];

  const centroid = (o: EmbObject): Pt => {
    const ring = o.ringsPx[0];
    let sx = 0;
    let sy = 0;
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
    }
    return [sx / ring.length, sy / ring.length];
  };

  const order: string[] = [];
  let cur: Pt | null = null;
  for (const c of colorOrder) {
    const remaining = [...(objectsByColor.get(c) ?? [])];
    while (remaining.length > 0) {
      let best = 0;
      if (cur) {
        let bestD = Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const [x, y] = centroid(remaining[i]);
          const d = Math.hypot(x - cur[0], y - cur[1]);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      const obj = remaining.splice(best, 1)[0];
      order.push(obj.id);
      cur = centroid(obj);
    }
  }

  return { objects, order, quant, transform: { scale, cx, cy }, mmPerPx };
}

export { DEFAULT_GLOBAL };
