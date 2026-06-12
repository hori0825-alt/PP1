// ステッチ後処理。
// - 最小ステッチ長未満の点を統合 (短すぎるステッチは糸絡み・目詰まりの原因)
// - 最大ステッチ長超の区間を分割 (DST の ±12.1mm 制限にも対応)
// Run の本数・接続属性は変更しない (連続性を壊さない)。

import { MAX_STITCH_LEN, MIN_STITCH_LEN } from "../core/constants";
import type { StitchRun } from "../core/types";

export interface PostprocessOptions {
  minStitchLength?: number;
  maxStitchLength?: number;
}

export function postprocessRun(run: StitchRun, options: PostprocessOptions = {}): StitchRun {
  const minLen = options.minStitchLength ?? MIN_STITCH_LEN;
  const maxLen = options.maxStitchLength ?? MAX_STITCH_LEN;
  const src = run.stitches;
  if (src.length === 0) return run;

  // 短すぎる区間の統合 (端点は保持)
  const merged = [src[0]];
  for (let i = 1; i < src.length; i++) {
    const last = merged[merged.length - 1];
    const p = src[i];
    const d = Math.hypot(p.x - last.x, p.y - last.y);
    if (d < minLen && i < src.length - 1) continue;
    if (d < 1e-9 && i === src.length - 1) continue; // 終点が完全重複なら捨てる
    merged.push(p);
  }

  // 長すぎる区間の分割
  const out = [merged[0]];
  for (let i = 1; i < merged.length; i++) {
    const a = out[out.length - 1];
    const b = merged[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > maxLen) {
      const n = Math.ceil(d / maxLen);
      for (let k = 1; k < n; k++) {
        out.push({
          x: Math.round(a.x + ((b.x - a.x) * k) / n),
          y: Math.round(a.y + ((b.y - a.y) * k) / n),
        });
      }
    }
    out.push(b);
  }

  return { stitches: out, connection: run.connection };
}

export function postprocessRuns(runs: StitchRun[], options?: PostprocessOptions): StitchRun[] {
  return runs.map((r) => postprocessRun(r, options)).filter((r) => r.stitches.length >= 2);
}
