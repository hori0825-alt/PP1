// アップリケの工程生成。DOM 非依存・テスト可能。
//
// アップリケは「布を置く→縫い留める→切る→縁を仕上げる」工程で、
// 各工程の境目でミシンを止める必要がある。本実装では各工程を別 ColorBlock
// として表現する。flattenPlan はブロック間に色替え (= 実機では停止して確認) を
// 入れるため、これが工程停止として機能する。工程名は thread.name に入れ、
// シーケンスビューと作業指示書に「工程」として表示される。
//
// 工程:
//   1. 配置線 (placement): 外周のランニング。ここで布を枠に合わせて置く
//   2. 仮止め (tackdown): やや内側のランニング。布を固定。ここで余分をカット
//   3. 仕上げ (satin): 外周のサテン縁取り

import { mm } from "../core/constants";
import { signedArea } from "../core/geometry";
import type { Region } from "../core/region";
import type { ColorBlock, StitchPlan, ThreadColor } from "../core/types";
import { postprocessRuns } from "../stitch/postprocess";
import { runningStitch } from "../stitch/running";
import { satinAlongPath } from "../stitch/satin";
import { insetPath } from "../stitch/underlay";

export interface AppliqueOptions {
  /** 仕上げサテンの幅 (mm) */
  satinWidthMm?: number;
  /** 仮止めの内側オフセット (mm) */
  tackdownInsetMm?: number;
  /** 配置線・仮止めの糸色 (ガイド色)。仕上げは region.color */
  guideColor?: ThreadColor;
}

const GUIDE = { r: 120, g: 120, b: 120, name: "ガイド" };

/** 1つの領域からアップリケ工程の ColorBlock 列を生成する */
export function appliqueBlocks(region: Region, options: AppliqueOptions = {}): ColorBlock[] {
  const satinWidth = mm(options.satinWidthMm ?? 2.5);
  const inset = mm(options.tackdownInsetMm ?? 1.5);
  const guide = options.guideColor ?? GUIDE;
  const blocks: ColorBlock[] = [];

  // 1. 配置線 (外周ランニング)
  const placement = runningStitch(region.outer, {}, true);
  if (placement.runs.length > 0) {
    blocks.push({
      thread: { ...guide, name: "配置線" },
      runs: postprocessRuns(placement.runs.map((r) => ({ ...r, stitchType: "running" }))),
    });
  }

  // 2. 仮止め (内側ランニング)
  const tack = runningStitch(insetPath(region.outer, inset), {}, true);
  if (tack.runs.length > 0) {
    blocks.push({
      thread: { ...guide, name: "仮止め" },
      runs: postprocessRuns(tack.runs.map((r) => ({ ...r, stitchType: "running" }))),
    });
  }

  // 3. 仕上げサテン (外周を閉じてサテン縁取り)
  const closed = [...region.outer, region.outer[0]];
  const satin = satinAlongPath(closed, satinWidth);
  if (satin.runs.length > 0) {
    blocks.push({
      thread: { ...region.color, name: region.color.name ?? "仕上げ" },
      runs: postprocessRuns(satin.runs.map((r) => ({ ...r, stitchType: "satin" }))),
    });
  }

  return blocks;
}

/** 複数領域をアップリケ化して1つの StitchPlan にする (工程順に並ぶ) */
export function appliquePlan(regions: Region[], name: string, options: AppliqueOptions = {}): StitchPlan {
  const blocks: ColorBlock[] = [];
  for (const region of regions) {
    blocks.push(...appliqueBlocks(region, options));
  }
  return { name, blocks };
}

/** 仕上げサテン幅が広すぎないかの警告 (mm) */
export function appliqueWarnings(options: AppliqueOptions = {}): string[] {
  const w = options.satinWidthMm ?? 2.5;
  const warnings: string[] = [];
  if (w > 6) warnings.push(`仕上げサテン幅 ${w}mm が広すぎます (6mm 以下を推奨)`);
  void signedArea;
  return warnings;
}
