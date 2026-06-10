// 輪郭のランニングステッチ生成: 閉ループを一定ピッチで再サンプリングする

import type { Pt } from "./contour";

export function runningStitch(loop: Pt[], stitchLen: number): Pt[] {
  if (loop.length < 3) return [];
  const closed = loop.concat([loop[0]]);
  const out: Pt[] = [closed[0]];
  let carry = 0;
  for (let i = 0; i + 1 < closed.length; i++) {
    const [x0, y0] = closed[i];
    const [x1, y1] = closed[i + 1];
    const segLen = Math.hypot(x1 - x0, y1 - y0);
    if (segLen < 1e-9) continue;
    let d = stitchLen - carry;
    while (d < segLen) {
      const t = d / segLen;
      out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      d += stitchLen;
    }
    carry = segLen - (d - stitchLen);
    // 角を正確に縫う: 頂点が直近の点から離れていれば追加
    const last = out[out.length - 1];
    if (Math.hypot(x1 - last[0], y1 - last[1]) > stitchLen * 0.3) {
      out.push([x1, y1]);
      carry = 0;
    }
  }
  // 終点を始点に一致させて閉じる
  const last = out[out.length - 1];
  if (Math.hypot(last[0] - loop[0][0], last[1] - loop[0][1]) > 0.5) {
    out.push([loop[0][0], loop[0][1]]);
  }
  return out;
}
