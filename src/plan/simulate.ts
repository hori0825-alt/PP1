// ステッチプレイヤー用のシミュレーションフレーム計算 (DOM 非依存・テスト可能)。
// flattenPlan の MachineOp 列を「針単位の再生フレーム」に展開する。
// 各フレームは縫い針の位置と、その針が通常縫い/ジャンプ/糸切り直後/色替え
// のどれかを示す。UI はこのフレーム列をスライダー・再生で参照する。

import type { StitchPlan, ThreadColor } from "../core/types";
import { flattenPlan } from "../export/flatten";

export interface SimFrame {
  x: number;
  y: number;
  /** 現在の色ブロックのインデックス */
  colorIndex: number;
  /** この針までの実ステッチ数 (ジャンプ・色替えは含まない) */
  stitchNumber: number;
  /** 直前の移動がジャンプ (渡り糸) だった */
  fromJump: boolean;
  /** 直前に糸切りがあった */
  afterTrim: boolean;
  /** この針で色替えが起きた (新しい色の最初の針) */
  colorChanged: boolean;
}

export interface Simulation {
  frames: SimFrame[];
  threads: ThreadColor[];
  /** 色替えが起きるフレーム番号 */
  colorChangeFrames: number[];
  /** 糸切り直後のフレーム番号 */
  trimFrames: number[];
  totalStitches: number;
}

export function buildSimulation(plan: StitchPlan): Simulation {
  const ops = flattenPlan(plan);
  const threads = plan.blocks.map((b) => b.thread);
  const frames: SimFrame[] = [];
  const colorChangeFrames: number[] = [];
  const trimFrames: number[] = [];

  let x = 0;
  let y = 0;
  let colorIndex = 0;
  let stitchNumber = 0;
  let pendingJump = false;
  let pendingTrim = false;
  let pendingColorChange = false;

  for (const op of ops) {
    switch (op.kind) {
      case "stitch": {
        x = op.x;
        y = op.y;
        stitchNumber++;
        const frame: SimFrame = {
          x,
          y,
          colorIndex,
          stitchNumber,
          fromJump: pendingJump,
          afterTrim: pendingTrim,
          colorChanged: pendingColorChange,
        };
        if (pendingColorChange) colorChangeFrames.push(frames.length);
        if (pendingTrim) trimFrames.push(frames.length);
        frames.push(frame);
        pendingJump = false;
        pendingTrim = false;
        pendingColorChange = false;
        break;
      }
      case "jump": {
        x = op.x;
        y = op.y;
        pendingJump = true;
        break;
      }
      case "trim": {
        pendingTrim = true;
        break;
      }
      case "colorChange": {
        colorIndex++;
        pendingColorChange = true;
        break;
      }
      case "end":
        break;
    }
  }

  return {
    frames,
    threads,
    colorChangeFrames,
    trimFrames,
    totalStitches: stitchNumber,
  };
}
