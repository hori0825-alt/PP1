// StitchPlan → ミシン命令列 (MachineOp[]) への展開。
// PES/DST 両エクスポーターはこの共通命令列を入力にする。
// ここでは最適化は一切行わず、StitchPlan の接続属性を忠実に命令へ変換する。

import { MAX_STITCH_LEN } from "../core/constants";
import type { Point, StitchPlan } from "../core/types";

export type MachineOp =
  | { kind: "stitch"; x: number; y: number }
  | { kind: "jump"; x: number; y: number }
  | { kind: "trim" }
  | { kind: "colorChange" }
  | { kind: "end" };

/**
 * 移動を1針あたりの上限 (MAX_STITCH_LEN = DST の ±12.1mm 制限) 以下に分割する。
 * 中間点も含めた絶対座標列を返す。
 */
function splitMove(from: Point, to: Point, maxLen: number): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / maxLen));
  const pts: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    pts.push({
      x: from.x + Math.round((dx * i) / steps),
      y: from.y + Math.round((dy * i) / steps),
    });
  }
  return pts;
}

/**
 * StitchPlan をミシン命令列に展開する。
 * - ブロック間: colorChange (機械側で暗黙の糸切り) → ジャンプで次の開始点へ
 * - Run 間: connection に応じて continuous (通常ステッチ) / jump / trim+jump
 * - 上限を超える移動はジャンプ/ステッチを自動分割
 * - trim 命令の直後には必ず jump が続くことを保証する (移動が無い場合 trim は省略)
 */
export function flattenPlan(plan: StitchPlan): MachineOp[] {
  const ops: MachineOp[] = [];
  let cur: Point | null = null;

  for (let bi = 0; bi < plan.blocks.length; bi++) {
    const block = plan.blocks[bi];
    const runs = block.runs.filter((r) => r.stitches.length > 0);
    if (runs.length === 0) continue;
    if (bi > 0) ops.push({ kind: "colorChange" });

    for (let ri = 0; ri < runs.length; ri++) {
      const run = runs[ri];
      const start = run.stitches[0];
      // ブロック先頭 Run は色替え (または縫い始め) 後の位置合わせなので常にジャンプ
      const conn = ri === 0 ? "jump" : run.connection;

      if (cur === null) {
        // 縫い始め: 原点からジャンプで開始点へ
        for (const p of splitMove({ x: 0, y: 0 }, start, MAX_STITCH_LEN)) {
          ops.push({ kind: "jump", x: p.x, y: p.y });
        }
      } else if (cur.x !== start.x || cur.y !== start.y) {
        if (conn === "continuous") {
          for (const p of splitMove(cur, start, MAX_STITCH_LEN)) {
            ops.push({ kind: "stitch", x: p.x, y: p.y });
          }
        } else {
          if (conn === "trim") ops.push({ kind: "trim" });
          for (const p of splitMove(cur, start, MAX_STITCH_LEN)) {
            ops.push({ kind: "jump", x: p.x, y: p.y });
          }
        }
      }
      cur = start;
      ops.push({ kind: "stitch", x: start.x, y: start.y });

      for (let si = 1; si < run.stitches.length; si++) {
        const p = run.stitches[si];
        if (p.x === cur.x && p.y === cur.y) continue;
        // Run 内は連続縫い。上限超の区間は中間点を打って分割する (糸は切らない)
        for (const q of splitMove(cur, p, MAX_STITCH_LEN)) {
          ops.push({ kind: "stitch", x: q.x, y: q.y });
        }
        cur = p;
      }
    }
  }

  ops.push({ kind: "end" });
  return ops;
}
