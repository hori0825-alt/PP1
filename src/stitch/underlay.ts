// 下縫い生成。
// 下縫いと本縫いは同一オブジェクト内の連続した Run 列として出力し、
// 間に糸切りを入れない (digitize 側で connection を設定する)。

import { TATAMI_DEFAULT, mm } from "../core/constants";
import type { Region } from "../core/region";
import type { Point } from "../core/types";
import { runningStitch } from "./running";
import { satinAlongPath } from "./satin";
import { tatamiFill } from "./tatami";
import type { GeneratorResult, TatamiParams, UnderlayType } from "./types";

/**
 * 頂点法線によるポリゴンの内側オフセット (近似)。
 * 外周 (符号付き面積 正) にも穴 (負) にも同じ式で「縫い領域の内側」へ寄る。
 * 小さいオフセット (〜1mm) の下縫い用途に十分な精度。
 */
export function insetPath(path: Point[], inset: number): Point[] {
  const n = path.length;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const prev = path[(i - 1 + n) % n];
    const cur = path[i];
    const next = path[(i + 1) % n];
    // 前後辺の内向き法線 (画面座標系・時計回り外周で (-dy, dx) が内側)
    const d1x = cur.x - prev.x;
    const d1y = cur.y - prev.y;
    const l1 = Math.hypot(d1x, d1y) || 1;
    const d2x = next.x - cur.x;
    const d2y = next.y - cur.y;
    const l2 = Math.hypot(d2x, d2y) || 1;
    let nx = -d1y / l1 - d2y / l2;
    let ny = d1x / l1 + d2x / l2;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    out.push({ x: cur.x + nx * inset, y: cur.y + ny * inset });
  }
  return out;
}

export interface FillUnderlayOptions {
  types: UnderlayType[];
  /** エッジ下縫いの内側オフセット。デフォルト 0.8mm */
  edgeInset?: number;
  /** タタミ下縫いの行間隔。デフォルト 3mm */
  tatamiSpacing?: number;
  /** 本縫いの角度 (タタミ下縫いは +90° で交差させる) */
  topAngleDeg?: number;
}

/** 面 (タタミ/領域サテン) 用の下縫いを生成する */
export function fillUnderlay(region: Region, options: FillUnderlayOptions): GeneratorResult {
  const runs: GeneratorResult["runs"] = [];
  const warnings: string[] = [];
  for (const type of options.types) {
    switch (type) {
      case "edge": {
        const inset = options.edgeInset ?? mm(0.8);
        const paths = [region.outer, ...region.holes].map((p) => insetPath(p, inset));
        for (const p of paths) {
          const r = runningStitch(p, {}, true);
          runs.push(...r.runs);
          warnings.push(...r.warnings);
        }
        break;
      }
      case "tatami": {
        // 本縫いと交差する向きの粗いタタミで土台を作る
        const params: TatamiParams = {
          angleDeg: (options.topAngleDeg ?? 45) + 90,
          rowSpacing: options.tatamiSpacing ?? mm(3),
          stitchLength: TATAMI_DEFAULT.stitchLength,
        };
        const r = tatamiFill(region, params);
        runs.push(...r.runs);
        warnings.push(...r.warnings);
        break;
      }
      case "center":
      case "zigzag":
        // center/zigzag はサテン用 (satinUnderlay)。面ではエッジ/タタミを使う
        warnings.push(`下縫い '${type}' は面オブジェクトでは未対応です (edge/tatami を使用)`);
        break;
    }
  }
  return { runs, warnings };
}

export interface SatinUnderlayOptions {
  types: UnderlayType[];
  /** サテン本縫いの中心線 */
  centerline: Point[];
  /** サテン本縫いの幅 */
  width: number;
}

/** サテンライン用の下縫いを生成する */
export function satinUnderlay(options: SatinUnderlayOptions): GeneratorResult {
  const runs: GeneratorResult["runs"] = [];
  const warnings: string[] = [];
  for (const type of options.types) {
    switch (type) {
      case "center": {
        const r = runningStitch(options.centerline, {}, false);
        runs.push(...r.runs);
        break;
      }
      case "zigzag": {
        // 本縫いより細い幅・粗い間隔のジグザグ
        const r = satinAlongPath(options.centerline, options.width * 0.6, mm(1.5));
        runs.push(...r.runs);
        break;
      }
      case "edge": {
        // 両レール近くを往復するランニング
        const r = runningStitch(options.centerline, { double: true }, false);
        runs.push(...r.runs);
        break;
      }
      case "tatami":
        warnings.push("下縫い 'tatami' はサテンラインでは未対応です");
        break;
    }
  }
  return { runs, warnings };
}
