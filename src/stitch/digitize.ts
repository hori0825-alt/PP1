// Region[] → StitchPlan のデジタイズパイプライン (Phase 4: 縫い順最適化対応)。
//
// 手順:
//   1. 同色の領域を1つの ColorBlock にグループ化 (色替え最小化)
//   2. 色順は総面積の大きい順 (背景 → 前景でレイヤーが自然になる)
//   3. 同色内は重心の貪欲法 + 2-opt で巡回順を最適化 (Closest Join)
//   4. 各領域は「前のオブジェクトの終点」を startNear に渡して生成し、
//      開始点を自動的に近づける (Closest Point)
//   5. 接続は decideConnection: 3mm未満=continuous / 10mm未満=jump / 以遠=trim
//      (Always/Never/Auto Trim と Trim Distance を指定可能)
//   6. 同一領域内 (下縫い→本縫い等) は距離に関わらず糸切りしない

import { SATIN_DEFAULT, TATAMI_DEFAULT } from "../core/constants";
export type { FillType } from "../core/types";
import { polygonCentroid, signedArea } from "../core/geometry";
import type { EmbroideryObject } from "../core/object";
import type { DirectionLine, Region } from "../core/region";
import type { ColorBlock, Point, StitchPlan, StitchRun } from "../core/types";
import type { ConnectOptions, TrimMode } from "../plan/connect";
import { decideConnection } from "../plan/connect";
import { optimizeOrder } from "../plan/order";
import { compensateRegion, densityCompensatedSpacing, regionArea, regionMinExtent } from "./compensation";
import { postprocessRuns } from "./postprocess";
import { satinFromRegion } from "./satin";
import { tatamiFill } from "./tatami";
import { turningFill } from "./turning";
import { fillUnderlay } from "./underlay";
import type { FillType } from "../core/types";
import type { GeneratorResult, TatamiParams, UnderlayType } from "./types";

export interface DigitizeOptions {
  /** タタミ角度 (度) */
  angleDeg?: number;
  /** タタミ行間隔 */
  rowSpacing?: number;
  /** ステッチ長 */
  stitchLength?: number;
  /** 下縫い (デフォルトなし。布地レシピ連携は Phase 5.5) */
  underlay?: UnderlayType[];
  /** 縫い順最適化 (デフォルト true。false で入力順のまま) */
  optimizeOrder?: boolean;
  /** 糸切りモード: auto (距離判定) / never / always */
  trimMode?: TrimMode;
  /** auto 時の糸切り距離閾値 */
  trimDistance?: number;
  /** 面の塗り方 (デフォルト tatami)。文字刺繍で satin/auto を使う */
  fillType?: FillType;
  /** Pull 補正 (内部単位)。布地レシピ由来 */
  pullCompensation?: number;
  /** Push 補正 (内部単位) */
  pushCompensation?: number;
  /** 最小オブジェクト短辺 (内部単位)。これ未満は除外 (Small Object Protection) */
  minObjectExtent?: number;
  /** 小さい面の密度を自動で下げる */
  autoDensity?: boolean;
  /** サテンの間隔 (内部単位)。3D/パフィーで詰める用 */
  satinSpacing?: number;
  /** 色 (糸) の縫い順の手動指定 ("r,g,b" キーの並び)。縫い順編集で使う */
  colorOrder?: string[];
}

export interface DigitizeResult {
  plan: StitchPlan;
  warnings: string[];
}

/**
 * 領域の塗りを生成する。
 * - tatami: 常にタタミ (方向線が2本以上ならターニング = 流れる向き)
 * - satin: サテンを試み、分岐警告が出たらタタミにフォールバック
 *   (複雑なグリフでパーツが欠けるのを防ぐ)
 * - auto: 短辺が SATIN_DEFAULT.maxWidth 以下かつ穴なしならサテン、他はタタミ
 */
function generateFill(
  region: Region,
  params: TatamiParams,
  fillType: FillType,
  startNear: Point | null,
  exitNear: Point | null,
  satinSpacing?: number,
  angleLines?: DirectionLine[],
): GeneratorResult & { usedSatin: boolean } {
  const useSatin =
    fillType === "satin" ||
    (fillType === "auto" && region.holes.length === 0 && regionMinExtent(region) <= SATIN_DEFAULT.maxWidth);

  if (useSatin) {
    const satin = satinFromRegion(region, {
      spacing: satinSpacing ?? SATIN_DEFAULT.spacing,
      maxWidth: SATIN_DEFAULT.maxWidth,
    });
    const branched = satin.warnings.some((w) => w.includes("分岐"));
    // 分岐や生成失敗時はタタミにフォールバック (パーツ欠けを防ぐ)
    if (!branched && satin.runs.length > 0) return { ...satin, usedSatin: true };
  }
  // 方向線が2本以上なら「流れる向き」(ターニング) を試みる。失敗時はタタミ。
  if (angleLines && angleLines.length >= 2) {
    const t = turningFill(region, params, angleLines, startNear, exitNear);
    if (t.runs.length > 0) return { ...t, usedSatin: false };
  }
  return { ...tatamiFill(region, params, startNear, exitNear), usedSatin: false };
}

export function digitizeRegions(
  regions: Region[],
  name: string,
  options: DigitizeOptions = {},
  objects?: readonly EmbroideryObject[],
): DigitizeResult {
  const warnings: string[] = [];
  // 永続オブジェクトが渡されたら、領域→オブジェクトを引けるようにする。
  // 安定 id (選択・縫い順の同一性) と baked (マニュアル編集済み針列) に使う。
  const objectOfRegion = new Map<Region, EmbroideryObject>();
  if (objects) for (const o of objects) objectOfRegion.set(o.region, o);
  const params: TatamiParams = {
    angleDeg: options.angleDeg ?? 45,
    rowSpacing: options.rowSpacing ?? TATAMI_DEFAULT.rowSpacing,
    stitchLength: options.stitchLength ?? TATAMI_DEFAULT.stitchLength,
  };
  const connectOptions: ConnectOptions = {
    trimMode: options.trimMode ?? "auto",
    trimDistance: options.trimDistance,
  };
  const doOptimize = options.optimizeOrder ?? true;
  const minExtent = options.minObjectExtent ?? 0;
  const pull = options.pullCompensation ?? 0;
  const push = options.pushCompensation ?? 0;
  const autoDensity = options.autoDensity ?? false;

  // --- 0. Small Object Protection: 短辺が閾値未満の小片を除外 ---
  // ただし baked (マニュアル針列・手動の線など) を持つオブジェクトは常に残す。
  const survivors =
    minExtent > 0
      ? regions.filter(
          (r) =>
            regionMinExtent(r) >= minExtent || (objectOfRegion.get(r)?.baked?.length ?? 0) > 0,
        )
      : regions;
  const dropped = regions.length - survivors.length;
  if (dropped > 0) warnings.push(`小さすぎる ${dropped} 個のオブジェクトを除外しました`);

  // --- 1. 同色グループ化 ---
  const groups = new Map<string, { color: Region["color"]; regions: Region[]; area: number }>();
  for (const region of survivors) {
    const key = `${region.color.r},${region.color.g},${region.color.b}`;
    const net =
      Math.abs(signedArea(region.outer)) -
      region.holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
    const g = groups.get(key);
    if (g) {
      g.regions.push(region);
      g.area += net;
    } else {
      groups.set(key, { color: region.color, regions: [region], area: net });
    }
  }

  // --- 2. 色順 ---
  const groupList = [...groups.values()];
  const colorKey = (c: Region["color"]): string => `${c.r},${c.g},${c.b}`;
  if (options.colorOrder && options.colorOrder.length > 0) {
    // 手動指定の色順を最優先 (未指定の色は面積順で後ろに回す)
    const order = options.colorOrder;
    const rank = (c: Region["color"]): number => {
      const i = order.indexOf(colorKey(c));
      return i < 0 ? Number.POSITIVE_INFINITY : i;
    };
    groupList.sort((a, b) => {
      const ra = rank(a.color);
      const rb = rank(b.color);
      if (ra !== rb) return ra - rb;
      return b.area - a.area;
    });
  } else if (doOptimize) {
    // 総面積の大きい順 (背景が先)
    groupList.sort((a, b) => b.area - a.area);
  }

  const blocks: ColorBlock[] = [];
  let currentEnd: Point | null = null; // 直前に縫った位置 (色をまたいで引き継ぐ)
  let objectIdCounter = 0; // オブジェクト (領域) 単位の通し番号

  for (const group of groupList) {
    // --- 3. 同色内の巡回順最適化 (Closest Join) ---
    let ordered = group.regions;
    if (doOptimize && group.regions.length > 1) {
      const centroids = group.regions.map((r) => polygonCentroid(r.outer));
      const order = optimizeOrder(centroids, currentEnd);
      ordered = order.map((i) => group.regions[i]);
    }

    const runs: StitchRun[] = [];
    for (let idx = 0; idx < ordered.length; idx++) {
      const source = ordered[idx];
      const obj = objectOfRegion.get(source);
      // 安定 id があればそれを、なければ通し番号を使う
      const objectId = obj ? obj.id : objectIdCounter++;
      const exitNear =
        doOptimize && idx + 1 < ordered.length ? polygonCentroid(ordered[idx + 1].outer) : null;

      const bakedRuns = obj?.baked?.filter((r) => r.stitches.length > 0);
      // processed = このオブジェクトの本体ラン (接続決定前、stitchType 付き)
      let processed: StitchRun[];

      if (bakedRuns && bakedRuns.length > 0) {
        // マニュアル編集済みオブジェクト: 再生成せず針列をそのまま使う (Phase 7 の土台)
        processed = bakedRuns.map((r) => ({
          stitches: r.stitches.slice(),
          connection: r.connection,
          stitchType: r.stitchType ?? "manual",
        }));
      } else {
        // パーツ固有のステッチ角度 (未設定なら全体角度) と縫い方を解決
        const objectAngleDeg = source.angleDeg ?? params.angleDeg;
        const regionFillType = source.fillType ?? options.fillType ?? "tatami";
        // 方向線 (ターニング): 2本以上で「流れる向き」になる
        const angleLines = source.angleLines && source.angleLines.length >= 2 ? source.angleLines : undefined;
        // --- 差分再生成 (Phase 2): 形状・パラメータ・前後文脈が同じなら本体を再利用 ---
        const paramsSig = JSON.stringify([
          objectAngleDeg,
          regionFillType,
          params.rowSpacing,
          params.stitchLength,
          options.satinSpacing ?? 0,
          (options.underlay ?? []).join("+"),
          pull,
          push,
          autoDensity,
          angleLines
            ? angleLines.map((l) => `${Math.round(l.a.x)},${Math.round(l.a.y)},${Math.round(l.b.x)},${Math.round(l.b.y)}`).join(";")
            : "",
        ]);
        const ctxSig = `${currentEnd ? `${currentEnd.x},${currentEnd.y}` : "-"}|${
          exitNear ? `${Math.round(exitNear.x)},${Math.round(exitNear.y)}` : "-"
        }`;
        const cache = obj?.cache;
        if (
          cache &&
          cache.outerRef === source.outer &&
          cache.paramsSig === paramsSig &&
          cache.ctxSig === ctxSig
        ) {
          // 変更なし: 前回生成した本体をそのまま使い、この面は縫い直さない
          processed = cache.runs;
          warnings.push(...cache.warnings);
        } else {
          const objectSewRad = (objectAngleDeg * Math.PI) / 180;
          // Pull/Push 補正を適用した領域で下縫い・本縫いを生成する (補正方向もパーツ角度に合わせる)
          const region = compensateRegion(source, { pull, push, sewAngleRad: objectSewRad });
          const localWarnings: string[] = [];
          const regionRuns: StitchRun[] = [];

          // 密度補正: 小さい面では行間隔を広げる (Auto Density)。角度はパーツ固有を使う
          const regionParams: TatamiParams = {
            ...params,
            angleDeg: objectAngleDeg,
            rowSpacing: densityCompensatedSpacing(regionArea(region), params.rowSpacing, autoDensity),
          };

          // 下縫い → 本縫い。各ランに stitchType を付けておく (キャッシュにも残る)
          if (options.underlay && options.underlay.length > 0) {
            const u = fillUnderlay(region, { types: options.underlay, topAngleDeg: objectAngleDeg });
            for (const r of u.runs) regionRuns.push({ ...r, stitchType: "underlay" });
            localWarnings.push(...u.warnings);
          }

          const fillStart =
            regionRuns.length > 0
              ? regionRuns[regionRuns.length - 1].stitches[
                  regionRuns[regionRuns.length - 1].stitches.length - 1
                ]
              : currentEnd;
          const fill = generateFill(region, regionParams, regionFillType, fillStart ?? null, exitNear, options.satinSpacing, angleLines);
          const fillTag: NonNullable<StitchRun["stitchType"]> = fill.usedSatin ? "satin" : "tatami";
          for (const r of fill.runs) regionRuns.push({ ...r, stitchType: fillTag });
          localWarnings.push(...fill.warnings);

          processed = postprocessRuns(regionRuns);
          warnings.push(...localWarnings);
          if (obj) obj.cache = { outerRef: source.outer, paramsSig, ctxSig, runs: processed, warnings: localWarnings };
        }
      }

      // --- 接続決定 (常に最新の文脈で計算。キャッシュした本体ランは書き換えない) ---
      const emitted: StitchRun[] = [];
      for (let i = 0; i < processed.length; i++) {
        // i === 0: 前の領域からの接続 (糸切り許可)。i > 0: 同一領域内 (糸切り禁止)
        const prevRun = i === 0 ? (runs.length > 0 ? runs[runs.length - 1] : null) : emitted[i - 1];
        const from =
          prevRun && prevRun.stitches.length > 0
            ? prevRun.stitches[prevRun.stitches.length - 1]
            : i === 0
              ? currentEnd
              : null;
        emitted.push({
          stitches: processed[i].stitches,
          connection: decideConnection(from, processed[i].stitches[0], i > 0, connectOptions),
          objectId,
          stitchType: processed[i].stitchType ?? "tatami",
        });
      }
      runs.push(...emitted);
      if (runs.length > 0) {
        const lastRun = runs[runs.length - 1];
        currentEnd = lastRun.stitches[lastRun.stitches.length - 1];
      }
    }
    if (runs.length > 0) {
      blocks.push({ thread: group.color, runs });
    }
  }

  return { plan: { name, blocks }, warnings };
}
