// StitchPlan → ミシン命令列 (MachineOp[]) への展開。
// PES/DST 両エクスポーターはこの共通命令列を入力にする。
// 接続属性を忠実に命令へ変換しつつ、糸切り・色替え・縫い始め/終わりの境界に
// 止め縫い (ロック) を自動挿入する (糸端のほつれ防止)。
//
// 重要: ロックは「糸が切れる/始まる境界」にのみ入れる。Run 内部 (= 1つの面) には
// 一切手を入れないため、糸切り根絶設計 (1面 = 1本の連続 Run) を壊さない。

import { MAX_STITCH_LEN, MIN_STITCH_LEN, mm } from "../core/constants";
import type { Point, StitchPlan } from "../core/types";

export type MachineOp =
  | { kind: "stitch"; x: number; y: number }
  | { kind: "jump"; x: number; y: number }
  | { kind: "trim" }
  | { kind: "colorChange" }
  | { kind: "end" };

/** ロック止め縫いの片振り長 (約 1mm)。既存ステッチに重ねて隠れる程度に小さく */
const LOCK_LEN = mm(1.0);

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
 * 止め縫い (ロック) ステッチ。anchor は直前に打たれている前提で、anchor から
 * toward 方向へ約 1mm 出て anchor へ戻る往復 1 組 (2 針) を返す。
 * - tie-in (縫い始め): toward = 次の針位置 → 縫い進む向きへ食い込んで戻る
 * - tie-off (縫い終わり): toward = 直前の針位置 → 縫ってきた向きへ戻って食い込む
 * いずれも anchor で終わるので、後続のステッチ/糸切りは anchor 位置から続く。
 */
function lockOps(anchor: Point, toward: Point): MachineOp[] {
  const dx = toward.x - anchor.x;
  const dy = toward.y - anchor.y;
  const d = Math.hypot(dx, dy);
  const len = Math.min(LOCK_LEN, d);
  if (len < MIN_STITCH_LEN) return []; // 近すぎて有効なロックにならない (極小針も作らない)
  const b = {
    x: Math.round(anchor.x + (dx / d) * len),
    y: Math.round(anchor.y + (dy / d) * len),
  };
  return [
    { kind: "stitch", x: b.x, y: b.y },
    { kind: "stitch", x: anchor.x, y: anchor.y },
  ];
}

/** stitches の中で from と異なる最初の点 (ロックの向き決定用)。無ければ null */
function firstDistinct(stitches: Point[], from: Point): Point | null {
  for (const p of stitches) {
    if (p.x !== from.x || p.y !== from.y) return p;
  }
  return null;
}

/**
 * StitchPlan をミシン命令列に展開する。
 * - ブロック間: colorChange (機械側で暗黙の糸切り) → ジャンプで次の開始点へ
 * - Run 間: connection に応じて continuous (通常ステッチ) / jump / trim+jump
 * - 上限を超える移動はジャンプ/ステッチを自動分割
 * - trim 命令の直後には必ず jump が続くことを保証する (移動が無い場合 trim は省略)
 * - 糸が切れる直前 (trim/colorChange/デザイン終端) に tie-off、糸が始まった直後
 *   (デザイン先頭/trim 後/colorChange 後) に tie-in のロックを入れる。
 *   options.lockStitches=false で無効化できる (既定 true)。
 */
export function flattenPlan(plan: StitchPlan, options?: { lockStitches?: boolean }): MachineOp[] {
  const lock = options?.lockStitches ?? true;
  const ops: MachineOp[] = [];
  let cur: Point | null = null;
  let prev: Point | null = null; // cur の1つ前の針位置 (tie-off の向き決定用)
  let emittedBlocks = 0; // 実際にステッチを出したブロック数 (空ブロックは数えない)

  for (let bi = 0; bi < plan.blocks.length; bi++) {
    const block = plan.blocks[bi];
    const runs = block.runs.filter((r) => r.stitches.length > 0);
    if (runs.length === 0) continue;
    // 色替えは「すでに別の色を縫った後」にだけ入れる (先頭の空ブロックで
    // 誤って色替えが入らないよう、ブロック番号ではなく出力済み数で判定)
    if (emittedBlocks > 0) {
      // 色替え (= 糸切り) の前に直前の色の糸端を止める
      if (lock && cur && prev) ops.push(...lockOps(cur, prev));
      ops.push({ kind: "colorChange" });
    }
    emittedBlocks++;

    for (let ri = 0; ri < runs.length; ri++) {
      const run = runs[ri];
      const start = run.stitches[0];
      // ブロック先頭 Run は色替え (または縫い始め) 後の位置合わせなので常にジャンプ
      const conn = ri === 0 ? "jump" : run.connection;
      // この Run の手前で糸が切れているか (= 縫い始めに tie-in が要る)。
      // デザイン先頭・ブロック先頭 (色替え後)・直前が trim のいずれか。
      const threadCutBefore = cur === null || ri === 0 || conn === "trim";

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
          if (conn === "trim") {
            // 糸切りの前に直前の糸端を止める
            if (lock && prev) ops.push(...lockOps(cur, prev));
            ops.push({ kind: "trim" });
          }
          for (const p of splitMove(cur, start, MAX_STITCH_LEN)) {
            ops.push({ kind: "jump", x: p.x, y: p.y });
          }
        }
      }
      prev = cur;
      cur = start;
      ops.push({ kind: "stitch", x: start.x, y: start.y });

      // 縫い始めのロック: 糸が切れた直後だけ、縫い進む向きへ食い込んで止める
      if (lock && threadCutBefore) {
        const nxt = firstDistinct(run.stitches, start);
        if (nxt) ops.push(...lockOps(start, nxt));
      }

      for (let si = 1; si < run.stitches.length; si++) {
        const p = run.stitches[si];
        if (p.x === cur.x && p.y === cur.y) continue;
        // Run 内は連続縫い。上限超の区間は中間点を打って分割する (糸は切らない)
        for (const q of splitMove(cur, p, MAX_STITCH_LEN)) {
          ops.push({ kind: "stitch", x: q.x, y: q.y });
        }
        prev = cur;
        cur = p;
      }
    }
  }

  // デザイン終端: 最後の糸端を止める
  if (lock && cur && prev) ops.push(...lockOps(cur, prev));
  ops.push({ kind: "end" });
  return ops;
}
