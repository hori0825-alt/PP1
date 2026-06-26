// 線画アウトライン: 各領域の輪郭 (外周 + 穴) を三重 (ビーン) ランニングステッチでなぞる。
//
// 目的:
//   - ロゴ・アニメ絵・手描き線画を、塗り (タタミ) ではなく「線」として縫う。
//   - 領域の輪郭は抽出済みの滑らかな閉ループ (region.outer / region.holes) なので、
//     これをそのままなぞれば断片化しない。1領域 = 少数の連続ループになり、
//     塗りに比べ針数・糸切りが大幅に減る。
//   - ビーン (三重) 縫いで線に厚み・存在感を持たせる。
//
// 旧実装はラスタ化 → 細線化 (Zhang-Suen) → 中心線サテンで「線の中心」を狙ったが、
// 手描き線画では太さが不均一・分岐が多く、断片的で品質が出なかった。輪郭追従に変更。

import { mm } from "../core/constants";
import type { Region } from "../core/region";
import type { Point, StitchRun } from "../core/types";
import { resamplePolyline } from "./satin";
import type { GeneratorResult } from "./types";

export interface SkeletonStitchParams {
  /** ステッチ長 (輪郭の再サンプル間隔)。既定 2.0mm */
  stitchLength?: number;
  /** 旧 API 互換 (未使用): ラスタ化解像度 */
  unitsPerPixel?: number;
  /** 旧 API 互換 (未使用): サテン化する最小幅 */
  satinMinWidth?: number;
  /** 旧 API 互換 (未使用): 線とみなす最大幅 */
  maxWidth?: number;
}

const round = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** 折れ線の総長 (内部単位) */
function pathLength(pts: Point[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return s;
}

/**
 * 閉じた輪郭を三重 (ビーン) ランニングで縫う Run を作る。
 * 1周 (前進) → 1周 (後退) → 1周 (前進) と各セグメントを3回なぞり、
 * 線に厚みを持たせる。始点 ≈ 終点なので次のループへの渡りが短くなる。
 */
function beanLoop(ring: Point[], stitchLength: number): StitchRun | null {
  if (ring.length < 3) return null;
  // 閉じる (始点を末尾に追加)
  const last = ring[ring.length - 1];
  const closed =
    last.x === ring[0].x && last.y === ring[0].y ? ring.slice() : [...ring, ring[0]];
  // 周長が短すぎる極小ループは捨てる (1.5mm 未満)
  if (pathLength(closed) < mm(1.5)) return null;
  const sampled = resamplePolyline(closed, stitchLength).map(round);
  if (sampled.length < 3) return null;
  const fwd = sampled;
  const back = [...fwd].reverse();
  // 前進 → 後退 → 前進 (三重)。重複点を除いて連結。
  const stitches = [...fwd, ...back.slice(1), ...fwd.slice(1)];
  return { stitches, connection: "trim" };
}

/**
 * Run を最近端点順に並べ、ループ間の渡り (ジャンプ) を最短化する。
 * 各ループは始点 ≈ 終点なので、前のループ終点に最も近い始点のループを次に選ぶ。
 * 同一領域内の Run は呼び出し側 (digitize) で糸切りされない (jump/continuous)。
 */
function orderRunsByNearest(runs: StitchRun[]): StitchRun[] {
  if (runs.length <= 1) return runs;
  const out: StitchRun[] = [];
  const used = new Set<number>();
  // 最も長い (周長の大きい) ループから開始すると安定する
  let start = 0;
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].stitches.length > runs[start].stitches.length) start = i;
  }
  out.push(runs[start]);
  used.add(start);
  while (out.length < runs.length) {
    const prev = out[out.length - 1];
    const end = prev.stitches[prev.stitches.length - 1];
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < runs.length; i++) {
      if (used.has(i)) continue;
      const a = runs[i].stitches[0];
      const d = (a.x - end.x) ** 2 + (a.y - end.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) break;
    out.push(runs[best]);
    used.add(best);
  }
  return out;
}

/**
 * 領域を「線」として輪郭 (外周 + 穴) で縫う。
 * 各輪郭を三重 (ビーン) ランニングでなぞる。塗らないので針数・糸切りが激減する。
 * 縫える輪郭が無ければ runs 空を返す (呼び出し側はこの領域を縫わない)。
 */
export function skeletonStitch(region: Region, params: SkeletonStitchParams = {}): GeneratorResult {
  const stitchLength = params.stitchLength ?? mm(2.0);
  const rings = [region.outer, ...region.holes];
  const runs: StitchRun[] = [];
  for (const ring of rings) {
    const run = beanLoop(ring, stitchLength);
    if (run) runs.push(run);
  }
  if (runs.length === 0) return { runs: [], warnings: [] };
  return { runs: orderRunsByNearest(runs), warnings: [] };
}
