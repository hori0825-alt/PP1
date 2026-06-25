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

import { SATIN_DEFAULT, TATAMI_DEFAULT, mm } from "../core/constants";
export type { FillType } from "../core/types";
import { polygonCentroid, signedArea } from "../core/geometry";
import type { EmbroideryObject } from "../core/object";
import type { DirectionLine, Region } from "../core/region";
import type { ColorBlock, Point, StitchPlan, StitchRun } from "../core/types";
import { rgbToLab, labDist2 } from "../import/quantize";
import type { ConnectOptions, TrimMode } from "../plan/connect";
import { decideConnection } from "../plan/connect";
import { optimizeOrder } from "../plan/order";
import { compensateRegion, compensateSatinColumn, densityCompensatedSpacing, regionArea, regionMinExtent } from "./compensation";
import { postprocessRuns } from "./postprocess";
import { satinFromRegion } from "./satin";
import { skeletonStitch } from "./skeleton";
import { strokeStitch } from "./stroke";
import { tatamiFill } from "./tatami";
import { turningFill } from "./turning";
import { fillUnderlay, satinUnderlay } from "./underlay";
import type { FillType, SatinUnderlayMode } from "../core/types";
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
  /** 下縫いを付ける最小短辺 (内部単位)。これ未満の細い面は下縫いを省く。デフォルト 2.5mm */
  underlayMinExtent?: number;
  /** サテン列の下縫い種別 (デフォルト auto = 一般下縫い設定から導出) */
  satinUnderlay?: SatinUnderlayMode;
  /** 小さい面の密度を自動で下げる */
  autoDensity?: boolean;
  /** サテンの間隔 (内部単位)。3D/パフィーで詰める用 */
  satinSpacing?: number;
  /** 色 (糸) の縫い順の手動指定 ("r,g,b" キーの並び)。縫い順編集で使う */
  colorOrder?: string[];
  /** 同色内のオブジェクト縫い順の手動指定 (オブジェクト id の並び)。縫い順編集で使う */
  objectOrder?: number[];
}

export interface DigitizeResult {
  plan: StitchPlan;
  warnings: string[];
}

/**
 * 極小領域のフォールバック: 外周輪郭に沿った走り縫いを生成する。
 * サテンもタタミも走査行が通らない小領域 (白目・ハイライト等) を救う。
 */
function microFill(region: Region, stitchLength: number): Point[] {
  const outer = region.outer;
  if (outer.length < 3) return [];
  const stitches: Point[] = [{ x: Math.round(outer[0].x), y: Math.round(outer[0].y) }];
  let accum = 0;
  for (let i = 1; i <= outer.length; i++) {
    const a = outer[i - 1];
    const b = outer[i % outer.length];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    accum += d;
    if (accum >= stitchLength || i === outer.length) {
      stitches.push({ x: Math.round(b.x), y: Math.round(b.y) });
      accum = 0;
    }
  }
  const first = stitches[0];
  const last = stitches[stitches.length - 1];
  if (stitches.length >= 2 && Math.hypot(last.x - first.x, last.y - first.y) > 1) {
    stitches.push({ x: first.x, y: first.y });
  }
  return stitches.length >= 2 ? stitches : [];
}

/** サテン下縫いを付ける最小幅 (内部単位)。これ未満の極細列は下縫い不要 (糸の盛りすぎ防止) */
const SATIN_UNDERLAY_MIN_WIDTH = mm(1.2);
/** サテン下縫いにジグザグを足す最小幅 (内部単位)。細い列はセンターのみで十分 */
const SATIN_ZIGZAG_MIN_WIDTH = mm(2.5);

/**
 * サテン本縫い (1本の連続 Run = 左右ペアのジグザグ) から中心線と最大幅を取り出す。
 * 偶数番=左レール / 奇数番=右レールの中点列が列の中心線になる。
 * これをサテン下縫い (中心線ランニング / ジグザグ) の経路に使う。
 */
function satinSpine(runs: StitchRun[]): { centerline: Point[]; width: number } {
  let best: StitchRun | null = null;
  for (const r of runs) if (!best || r.stitches.length > best.stitches.length) best = r;
  const centerline: Point[] = [];
  let width = 0;
  if (best) {
    for (let i = 0; i + 1 < best.stitches.length; i += 2) {
      const a = best.stitches[i];
      const b = best.stitches[i + 1];
      centerline.push({ x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) });
      width = Math.max(width, Math.hypot(b.x - a.x, b.y - a.y));
    }
  }
  return { centerline, width };
}

/**
 * ユーザー/レシピの下縫い指定を、サテン列向けの下縫い種別に対応づける。
 * - edge/center → center (中心線ランニング: 細い列を安定させる土台)
 * - tatami/zigzag → zigzag (幅のある列の支え。細い列には付けない)
 * 何も対応しなければ最低限 center を敷く (サテンに edge 下縫いはオフセットが潰れるため)。
 */
function satinUnderlayTypesFor(types: UnderlayType[], width: number): UnderlayType[] {
  const out: UnderlayType[] = [];
  if (types.includes("center") || types.includes("edge")) out.push("center");
  if ((types.includes("tatami") || types.includes("zigzag")) && width >= SATIN_ZIGZAG_MIN_WIDTH) {
    out.push("zigzag");
  }
  if (out.length === 0) out.push("center");
  return out;
}

/**
 * サテン列の下縫い種別を解決する。
 * - auto: 一般下縫い設定 (generalTypes) から導出。一般下縫いが無ければ付けない。
 * - none: 付けない。
 * - center: 中心線ランニングのみ。
 * - center-zigzag: センター + ジグザグ (ジグザグは極細列では過剰なので幅で制限)。
 * mode が auto 以外なら一般下縫い設定とは独立にサテン列へ下縫いを付けられる。
 */
function resolveSatinUnderlayTypes(
  mode: SatinUnderlayMode,
  generalTypes: UnderlayType[],
  width: number,
): UnderlayType[] {
  switch (mode) {
    case "none":
      return [];
    case "center":
      return ["center"];
    case "center-zigzag":
      return width >= SATIN_ZIGZAG_MIN_WIDTH ? ["center", "zigzag"] : ["center"];
    case "auto":
    default:
      return generalTypes.length > 0 ? satinUnderlayTypesFor(generalTypes, width) : [];
  }
}

/**
 * 領域の塗りを生成する。
 * - tatami: 常にタタミ (方向線が2本以上ならターニング = 流れる向き)
 * - satin: サテンを試み、分岐警告が出たらタタミにフォールバック
 *   (複雑なグリフでパーツが欠けるのを防ぐ)
 * - auto: 短辺が SATIN_DEFAULT.maxWidth 以下かつ穴なしならサテン、他はタタミ
 * 全て空なら microFill (輪郭走り縫い) にフォールバック。
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
    if (!satin.branched && satin.runs.length > 0) return { ...satin, usedSatin: true };
  }
  if (angleLines && angleLines.length >= 2) {
    const t = turningFill(region, params, angleLines, startNear, exitNear);
    if (t.runs.length > 0) return { ...t, usedSatin: false };
  }
  const tatami = tatamiFill(region, params, startNear, exitNear);
  if (tatami.runs.length > 0 && tatami.runs.some((r) => r.stitches.length > 0)) {
    return { ...tatami, usedSatin: false };
  }
  // マイクロフィル: サテンもタタミも空なら輪郭に沿った走り縫いにフォールバック
  const micro = microFill(region, params.stitchLength);
  if (micro.length >= 2) {
    return {
      runs: [{ stitches: micro, connection: "continuous" as const }],
      warnings: [],
      usedSatin: false,
    };
  }
  return { ...tatami, usedSatin: false };
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
  // ただし baked を持つオブジェクトと、高コントラストな小特徴は常に残す。
  const FEATURE_CONTRAST_DE = 25;
  const featureContrast2 = FEATURE_CONTRAST_DE * FEATURE_CONTRAST_DE;
  const isHighContrastFeature = (r: Region): boolean => {
    const lab = rgbToLab(r.color.r, r.color.g, r.color.b);
    for (const other of regions) {
      if (other === r) continue;
      const oLab = rgbToLab(other.color.r, other.color.g, other.color.b);
      if (labDist2(lab, oLab) > featureContrast2) return true;
    }
    return false;
  };
  const survivors =
    minExtent > 0
      ? regions.filter(
          (r) =>
            regionMinExtent(r) >= minExtent ||
            (objectOfRegion.get(r)?.baked?.length ?? 0) > 0 ||
            isHighContrastFeature(r),
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
    // --- 3. 同色内の縫い順 ---
    let ordered = group.regions;
    if (options.objectOrder && options.objectOrder.length > 0) {
      // 手動指定: オブジェクト id の並び順 (未指定の id は後ろへ、元順を維持)
      const objOrder = options.objectOrder;
      const rank = (r: Region): number => {
        const id = objectOfRegion.get(r)?.id;
        const i = id != null ? objOrder.indexOf(id) : -1;
        return i < 0 ? Number.POSITIVE_INFINITY : i;
      };
      ordered = [...group.regions].sort((a, b) => rank(a) - rank(b));
    } else if (doOptimize && group.regions.length > 1) {
      // 自動: 重心の貪欲法 + 2-opt (Closest Join)
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
          options.satinUnderlay ?? "auto",
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
          const localWarnings: string[] = [];
          const regionRuns: StitchRun[] = [];

          // --- 線画 (アウトライン) モード: 領域を骨格化して中心線をサテン/ビーンで縫う ---
          // 分岐した線ネットワークも扱える。塗らないので針数・糸切りが激減する。
          // 白 (紙) や太い面は線でないのでスキップ (縫わない)。
          const nearWhite = source.color.r > 235 && source.color.g > 235 && source.color.b > 235;
          if (regionFillType === "outline") {
            if (!nearWhite) {
              const sk = skeletonStitch(source, { stitchLength: params.stitchLength });
              for (const r of sk.runs) regionRuns.push({ ...r, stitchType: "satin" });
              localWarnings.push(...sk.warnings);
            }
            // runs が空 (白/太い面/骨格なし) ならこの領域は縫わない (塗りに落とさない)
            processed = postprocessRuns(regionRuns);
            warnings.push(...localWarnings);
            if (obj) obj.cache = { outerRef: source.outer, paramsSig, ctxSig, runs: processed, warnings: localWarnings };
            // 以降のフィル処理はスキップ
          } else {

          // --- ストローク (線): 細長い領域は中心線サテン/ランニングで縫う ---
          // リボン化した線画の二重縫いと針数増を解消する。stroke は明示指定、
          // auto は自動判定 (細長さ+幅)。下縫いは付けない (細帯に不要・針数増の元)。
          const strokeRes =
            regionFillType === "stroke" || regionFillType === "auto"
              ? strokeStitch(source, {
                  force: regionFillType === "stroke",
                  spacing: options.satinSpacing ?? SATIN_DEFAULT.spacing,
                  runStitchLength: params.stitchLength,
                })
              : null;

          if (strokeRes && strokeRes.runs.length > 0) {
            for (const r of strokeRes.runs) regionRuns.push({ ...r, stitchType: strokeRes.tag });
            localWarnings.push(...strokeRes.warnings);
          } else {
            const objectSewRad = (objectAngleDeg * Math.PI) / 180;
            // この領域がサテン (細い列) になる見込みか (補正前の素の形状で判定。
            // generateFill と同じ条件。Pull 補正は幅をわずかに変えるだけで判定は揺らさない)。
            const willTrySatin =
              regionFillType === "satin" ||
              (regionFillType === "auto" &&
                source.holes.length === 0 &&
                regionMinExtent(source) <= SATIN_DEFAULT.maxWidth);

            // Pull/Push 補正を適用した領域で下縫い・本縫いを生成する。
            // サテン列は糸の張力で「列幅」が縮むため、長軸直交方向 (=幅) を広げる専用補正を使う
            // (汎用の compensateRegion は幅 2mm 未満を弾くうえ、サテンの縫い方向と軸が合わない)。
            // 面 (タタミ) は従来どおりステッチ直交方向を広げる。
            const region = willTrySatin
              ? compensateSatinColumn(source, pull)
              : compensateRegion(source, { pull, push, sewAngleRad: objectSewRad });

            // 密度補正: 小さい面では行間隔を広げる (Auto Density)。角度はパーツ固有を使う
            const regionParams: TatamiParams = {
              ...params,
              angleDeg: objectAngleDeg,
              rowSpacing: densityCompensatedSpacing(regionArea(region), params.rowSpacing, autoDensity),
            };

            // 下縫い → 本縫い。各ランに stitchType を付けておく (キャッシュにも残る)。
            const underlayTypes = options.underlay ?? [];
            const hasUnderlay = underlayTypes.length > 0;
            const satinUnderlayMode = options.satinUnderlay ?? "auto";
            const underlayMinExtent = options.underlayMinExtent ?? 25; // 2.5mm

            if (willTrySatin) {
              // サテン列: 本縫いを先に生成して中心線を確定してから、中心線下縫いを敷く。
              // (startNear/exitNear はタタミ/ターニングの順序にのみ効き、サテンは無視するため、
              //  下縫いより先に本縫いを生成しても結果は変わらない)
              const fill = generateFill(region, regionParams, regionFillType, currentEnd ?? null, exitNear, options.satinSpacing, angleLines);
              if (fill.usedSatin) {
                // 細い列は edge/tatami 下縫いがオフセット潰れで無意味なため従来はスキップしていた。
                // 中心線に沿うサテン下縫い (center/zigzag) は細い列でも有効なので、ここで敷く。
                // 種別は satinUnderlay 設定で決める (auto なら一般下縫い設定から導出)。
                const spine = satinSpine(fill.runs);
                const types = resolveSatinUnderlayTypes(satinUnderlayMode, underlayTypes, spine.width);
                if (types.length > 0 && spine.centerline.length >= 2 && spine.width >= SATIN_UNDERLAY_MIN_WIDTH) {
                  const u = satinUnderlay({ types, centerline: spine.centerline, width: spine.width });
                  for (const r of u.runs) regionRuns.push({ ...r, stitchType: "underlay" });
                  localWarnings.push(...u.warnings);
                }
              } else if (hasUnderlay && regionMinExtent(region) >= underlayMinExtent) {
                // サテンに失敗してタタミへフォールバックした場合は面の下縫い
                const u = fillUnderlay(region, { types: underlayTypes, topAngleDeg: objectAngleDeg });
                for (const r of u.runs) regionRuns.push({ ...r, stitchType: "underlay" });
                localWarnings.push(...u.warnings);
              }
              const fillTag: NonNullable<StitchRun["stitchType"]> = fill.usedSatin ? "satin" : "tatami";
              for (const r of fill.runs) regionRuns.push({ ...r, stitchType: fillTag });
              localWarnings.push(...fill.warnings);
            } else {
              // 面 (タタミ/ターニング): 従来どおり 下縫い → 本縫い。
              // 本縫いの開始点を下縫い終端に寄せて渡り (同一面内・糸切りなし) を短くする。
              // 短辺が閾値未満の細い面は edge 下縫いの内側オフセットが潰れるためスキップ。
              if (hasUnderlay && regionMinExtent(region) >= underlayMinExtent) {
                const u = fillUnderlay(region, { types: underlayTypes, topAngleDeg: objectAngleDeg });
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
              for (const r of fill.runs) regionRuns.push({ ...r, stitchType: fill.usedSatin ? "satin" : "tatami" });
              localWarnings.push(...fill.warnings);
            }
          }

          processed = postprocessRuns(regionRuns);
          warnings.push(...localWarnings);
          if (obj) obj.cache = { outerRef: source.outer, paramsSig, ctxSig, runs: processed, warnings: localWarnings };
          }
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
