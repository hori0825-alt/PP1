// シーケンスビューのビューモデル。
// StitchPlan を「実際の縫製順」のエントリ列に変換する。
// 各エントリは Run 1本に対応し、色・タイプ・針数・接続・渡り距離・
// 開始/終了点・色替え/糸切りの有無を持つ。
//
// 重要: ここで作る順序は flattenPlan が縫う順序と完全に一致する
// (blocks → runs の順をそのまま辿る)。

import type { Point, StitchPlan, ThreadColor } from "../core/types";

export interface SequenceEntry {
  blockIndex: number;
  runIndex: number;
  /** 0 から始まる通し番号 (縫製順) */
  order: number;
  thread: ThreadColor;
  objectId: number | null;
  stitchType: string;
  stitchCount: number;
  /** 前のエントリからの接続 (このエントリの connection) */
  connection: "continuous" | "jump" | "trim";
  /** 前のエントリ終点からこのエントリ始点までの距離 (内部単位) */
  travel: number;
  start: Point;
  end: Point;
  /** このエントリで色替えが起きる (ブロックの最初の Run) */
  colorChange: boolean;
  /** このエントリの前に糸切りがある */
  trim: boolean;
}

export interface SequenceModel {
  entries: SequenceEntry[];
  /** objectId ごとのエントリインデックス (グループ化表示用) */
  byObject: Map<number, number[]>;
}

export function buildSequence(plan: StitchPlan): SequenceModel {
  const entries: SequenceEntry[] = [];
  const byObject = new Map<number, number[]>();
  let order = 0;
  let prevEnd: Point | null = null;

  for (let bi = 0; bi < plan.blocks.length; bi++) {
    const block = plan.blocks[bi];
    for (let ri = 0; ri < block.runs.length; ri++) {
      const run = block.runs[ri];
      if (run.stitches.length === 0) continue;
      const start = run.stitches[0];
      const end = run.stitches[run.stitches.length - 1];
      const isBlockStart = ri === 0 || entries[entries.length - 1]?.blockIndex !== bi;
      const travel = prevEnd ? Math.hypot(start.x - prevEnd.x, start.y - prevEnd.y) : 0;
      // ブロック先頭は色替え (暗黙の糸切り)。それ以外は connection が trim なら糸切り
      const trim = isBlockStart ? bi > 0 : run.connection === "trim";

      const entry: SequenceEntry = {
        blockIndex: bi,
        runIndex: ri,
        order,
        thread: block.thread,
        objectId: run.objectId ?? null,
        stitchType: run.stitchType ?? "tatami",
        stitchCount: run.stitches.length,
        connection: run.connection,
        travel,
        start,
        end,
        colorChange: isBlockStart && bi > 0,
        trim,
      };
      entries.push(entry);
      if (run.objectId !== undefined) {
        const list = byObject.get(run.objectId) ?? [];
        list.push(entries.length - 1);
        byObject.set(run.objectId, list);
      }
      prevEnd = end;
      order++;
    }
  }

  return { entries, byObject };
}

/**
 * 色ブロックの順序を入れ替えた新しい StitchPlan を返す (シーケンスビューの
 * D&D 並べ替え用)。接続属性は保持する (ブロック間は色替えなので影響なし)。
 */
export function reorderBlocks(plan: StitchPlan, fromIndex: number, toIndex: number): StitchPlan {
  const blocks = plan.blocks.slice();
  const [moved] = blocks.splice(fromIndex, 1);
  blocks.splice(toIndex, 0, moved);
  return { name: plan.name, blocks };
}
