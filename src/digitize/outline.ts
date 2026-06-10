// 輪郭のランニングステッチ / 3重ランニングステッチ生成

import type { Pt } from "./contour";

/** 閉ループを一定ピッチで再サンプリングして 1重のランニングステッチを返す */
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
    const last = out[out.length - 1];
    if (Math.hypot(x1 - last[0], y1 - last[1]) > stitchLen * 0.3) {
      out.push([x1, y1]);
      carry = 0;
    }
  }
  const last = out[out.length - 1];
  if (Math.hypot(last[0] - loop[0][0], last[1] - loop[0][1]) > 0.5) {
    out.push([loop[0][0], loop[0][1]]);
  }
  return out;
}

/**
 * 3重ランニングステッチ: 前進→後退→前進 の3パスを連結して返す。
 * 1重より糸が重なり線が太く・濃く見える。
 * 輪郭のアクセントや細い線の強調に使う。
 */
export function tripleRunningStitch(loop: Pt[], stitchLen: number): Pt[] {
  const pass1 = runningStitch(loop, stitchLen);
  if (pass1.length < 2) return pass1;
  const pass2 = [...pass1].reverse();
  const pass3 = pass1.slice();
  // pass1終端 → pass2(逆走) → pass3(再前進) を1本のパスに連結
  return [...pass1, ...pass2.slice(1), ...pass3.slice(1)];
}
