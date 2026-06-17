// タタミ縫い (面のフィル)。
//
// 最重要ルール: 1つの連結領域は必ず1本の連続した StitchRun として生成する。
// 面の途中で糸切り・ジャンプは発生させない。
//
// アルゴリズム:
//   1. 角度付きスキャンラインで内部区間 (Seg) を行ごとに求める
//   2. 隣接行で x 区間が重なる Seg を親子として繋ぎ、
//      「1行1区間が一直線に続く範囲」をセクションに分解する
//      (穴や凹みで分岐する箇所がセクション境界になる)
//   3. セクション同士の接続グラフを DFS で辿り、
//      セクション間は領域の縁に沿った移動ステッチ (Travel on Edge) で繋ぐ
//   4. 各セクションは行を交互方向 (ジグザグ) に縫い、行内は
//      ステッチ長間隔 + 行ごとの半ピッチずらし (レンガ状) で点を打つ

import type { Region } from "../core/region";
import type { Point, StitchRun } from "../core/types";
import { TATAMI_RANDOM_FACTOR, mm } from "../core/constants";
import type { CrossRef, Seg } from "./scanline";
import { nearestOnRing, rotatePoint, scanRegion, travelAlongRing } from "./scanline";
import type { GeneratorResult, TatamiParams } from "./types";

interface Section {
  segs: Seg[]; // 連続する行 (上から下)
  component: number;
}

/** x 区間の重なり判定 (角の点接触は除く) */
function overlaps(a: Seg, b: Seg): boolean {
  return Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 1e-6;
}

/** 折れ線を最大 step 間隔で再サンプルする (両端を含む) */
function resample(path: Point[], step: number): Point[] {
  const out: Point[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= n; k++) {
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
  }
  return out;
}

/** 整数/実数シードから 0..1 の決定的擬似乱数 (sin ハッシュ)。再生成で同一結果になる */
function hashUnit(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * 1行分のステッチ点 (端点を含み、内部はレンガ状オフセット)。
 * randomFactor > 0 のとき、中間針を ±(stitchLength×randomFactor) だけ決定的に揺らして
 * 針の縦整列 (モアレ) を崩す。端点 (x1/x2) は境界上に固定し、はみ出し・隙間を防ぐ。
 */
function rowPoints(
  seg: Seg,
  leftToRight: boolean,
  parity: number,
  stitchLength: number,
  randomFactor: number,
): Point[] {
  const pts: Point[] = [];
  const offset = parity % 2 === 0 ? 0 : stitchLength / 2;
  const amp = stitchLength * randomFactor;
  // 揺らしても端から離れすぎず・隣と交差しないよう、中間針はこの範囲に収める
  const lo = seg.x1 + stitchLength * 0.25;
  const hi = seg.x2 - stitchLength * 0.25;
  const xs: number[] = [seg.x1];
  let k = 0;
  for (let x = seg.x1 + (offset > 1e-9 ? offset : stitchLength); x < seg.x2 - stitchLength * 0.25; x += stitchLength) {
    let xj = x;
    if (amp > 0) {
      // 行 (seg.y) と行内位置 (k)・パリティを混ぜて、行ごと・点ごとに別の揺らぎにする
      const j = (hashUnit(Math.round(seg.y) * 0.137 + k + parity * 7) - 0.5) * 2 * amp;
      xj = Math.min(hi, Math.max(lo, x + j));
    }
    xs.push(xj);
    k++;
  }
  xs.push(seg.x2);
  if (!leftToRight) xs.reverse();
  for (const x of xs) pts.push({ x, y: seg.y });
  return pts;
}

/**
 * @param startNear 縫い始めをこの点 (デザイン座標) の近くにする。
 *   前のオブジェクトの終点を渡すと Closest Point 接続になる。
 *   開始点が走査の入口から遠い場合は、縁に沿った移動ステッチ
 *   (Travel on Edge) を先頭に挿入して接続距離を最短化する。
 * @param exitNear 縫い終わりをこの点の近くにする。
 *   次のオブジェクトの位置を渡すと、縁に沿って出口まで移動してから
 *   終わるため、次への渡り距離が最短になる (糸切り回避)。
 */
export function tatamiFill(
  region: Region,
  params: TatamiParams,
  startNear: Point | null = null,
  exitNear: Point | null = null,
): GeneratorResult {
  const warnings: string[] = [];
  const angleRad = (params.angleDeg * Math.PI) / 180;
  const randomFactor = params.randomFactor ?? TATAMI_RANDOM_FACTOR;
  const { rows, rings } = scanRegion(region, angleRad, params.rowSpacing);
  // startNear / exitNear を走査空間 (回転済み座標) へ変換
  const cosNeg = Math.cos(-angleRad);
  const sinNeg = Math.sin(-angleRad);
  const startRot = startNear ? rotatePoint(startNear, cosNeg, sinNeg) : null;
  const exitRot = exitNear ? rotatePoint(exitNear, cosNeg, sinNeg) : null;

  const allSegs: Seg[] = rows.flat();
  if (allSegs.length === 0) {
    warnings.push("領域が細すぎてタタミを生成できません (ランニングへの変換を検討)");
    return { runs: [], warnings };
  }

  // --- 親子リンク (隣接行の重なり) と連結成分 ---
  const children = new Map<Seg, Seg[]>();
  const parents = new Map<Seg, Seg[]>();
  for (const s of allSegs) {
    children.set(s, []);
    parents.set(s, []);
  }
  for (let r = 0; r + 1 < rows.length; r++) {
    for (const a of rows[r]) {
      for (const b of rows[r + 1]) {
        if (overlaps(a, b)) {
          (children.get(a) as Seg[]).push(b);
          (parents.get(b) as Seg[]).push(a);
        }
      }
    }
  }

  const component = new Map<Seg, number>();
  let compCount = 0;
  for (const s of allSegs) {
    if (component.has(s)) continue;
    const id = compCount++;
    const stack = [s];
    component.set(s, id);
    while (stack.length > 0) {
      const cur = stack.pop() as Seg;
      for (const nb of [...(children.get(cur) as Seg[]), ...(parents.get(cur) as Seg[])]) {
        if (!component.has(nb)) {
          component.set(nb, id);
          stack.push(nb);
        }
      }
    }
  }

  // --- セクション分解: 1行1区間で一直線に続く範囲 ---
  const sectionOf = new Map<Seg, Section>();
  const sections: Section[] = [];
  for (const row of rows) {
    for (const seg of row) {
      if (sectionOf.has(seg)) continue;
      const sec: Section = { segs: [seg], component: component.get(seg) as number };
      sectionOf.set(seg, sec);
      // 下方向に「自分の子が1つ & その子の親が1つ」の間だけ延長する
      let cur = seg;
      for (;;) {
        const ch = children.get(cur) as Seg[];
        if (ch.length !== 1) break;
        const next = ch[0];
        if ((parents.get(next) as Seg[]).length !== 1 || sectionOf.has(next)) break;
        sec.segs.push(next);
        sectionOf.set(next, sec);
        cur = next;
      }
      sections.push(sec);
    }
  }

  // --- セクション接続グラフ ---
  const adj = new Map<Section, Set<Section>>();
  for (const sec of sections) adj.set(sec, new Set());
  for (const s of allSegs) {
    for (const c of children.get(s) as Seg[]) {
      const a = sectionOf.get(s) as Section;
      const b = sectionOf.get(c) as Section;
      if (a !== b) {
        (adj.get(a) as Set<Section>).add(b);
        (adj.get(b) as Set<Section>).add(a);
      }
    }
  }

  // --- 連結成分ごとに DFS でセクションを縫い、1本の Run にする ---
  const runs: StitchRun[] = [];
  const visited = new Set<Section>();

  // セクションと点の最短距離 (端点4候補で近似)
  const sectionDist = (sec: Section, p: Point): number => {
    const first = sec.segs[0];
    const last = sec.segs[sec.segs.length - 1];
    let best = Infinity;
    for (const seg of [first, last]) {
      best = Math.min(
        best,
        Math.hypot(seg.x1 - p.x, seg.y - p.y),
        Math.hypot(seg.x2 - p.x, seg.y - p.y),
      );
    }
    return best;
  };

  for (let comp = 0; comp < compCount; comp++) {
    const compSections = sections.filter((s) => s.component === comp);
    if (compSections.length === 0) continue;

    const order: Section[] = [];
    const dfs = (sec: Section): void => {
      visited.add(sec);
      order.push(sec);
      // 近い順に訪問すると移動が短くなる
      const nbs = [...(adj.get(sec) as Set<Section>)].filter((n) => !visited.has(n));
      nbs.sort((a, b) => a.segs[0].y - b.segs[0].y);
      for (const nb of nbs) {
        if (!visited.has(nb)) dfs(nb);
      }
    };
    // startNear が指定されていれば最も近いセクションから縫い始める
    let root = compSections[0];
    if (startRot) {
      let bestD = Infinity;
      for (const sec of compSections) {
        const d = sectionDist(sec, startRot);
        if (d < bestD) {
          bestD = d;
          root = sec;
        }
      }
    }
    dfs(root);

    const stitches: Point[] = [];
    let pos: Point | null = null;
    let posRef: CrossRef | null = null;

    for (const sec of order) {
      // 入口: 先頭行 or 最終行 × 左端 or 右端 の4候補から現在位置に最も近いものを選ぶ
      const first = sec.segs[0];
      const last = sec.segs[sec.segs.length - 1];
      const candidates: { seg: Seg; fromTop: boolean; left: boolean; p: Point; ref: CrossRef }[] = [];
      for (const [seg, fromTop] of [
        [first, true],
        [last, false],
      ] as [Seg, boolean][]) {
        candidates.push({ seg, fromTop, left: true, p: { x: seg.x1, y: seg.y }, ref: seg.c1 });
        candidates.push({ seg, fromTop, left: false, p: { x: seg.x2, y: seg.y }, ref: seg.c2 });
      }
      let entry = candidates[0];
      const ref = pos ?? startRot;
      if (ref !== null) {
        let best = Infinity;
        for (const c of candidates) {
          const d = Math.hypot(c.p.x - ref.x, c.p.y - ref.y);
          if (d < best) {
            best = d;
            entry = c;
          }
        }
      }

      // セクション間の移動: 同一リング上なら縁沿い (Travel on Edge)、
      // 異なるリング間は直線 (隣接セクション間なので距離は行間隔程度)
      if (pos !== null && posRef !== null) {
        const path =
          posRef.ring === entry.ref.ring
            ? travelAlongRing(rings[posRef.ring], posRef.s, entry.ref.s)
            : [pos, entry.p];
        const travel = resample(path, params.stitchLength);
        // 現在位置と重複する先頭は除く
        for (let i = 1; i < travel.length; i++) stitches.push(travel[i]);
      } else if (startRot !== null) {
        // 入口トラベル (Travel on Edge): 前のオブジェクトに最も近い境界点から
        // 縁に沿って走査の入口まで移動する。接続距離が縮む場合のみ行う
        const ring = rings[entry.ref.ring];
        const near = nearestOnRing(ring, startRot);
        const dDirect = Math.hypot(entry.p.x - startRot.x, entry.p.y - startRot.y);
        if (near.dist + mm(1) < dDirect) {
          const travel = resample(travelAlongRing(ring, near.s, entry.ref.s), params.stitchLength);
          for (const p of travel) stitches.push(p);
        }
      }

      // セクション本体をジグザグに縫う
      const segsInOrder = entry.fromTop ? sec.segs : [...sec.segs].reverse();
      let leftToRight = entry.left;
      for (const seg of segsInOrder) {
        const pts = rowPoints(seg, leftToRight, seg.row, params.stitchLength, randomFactor);
        // 直前の行末と同じ点が続く場合はスキップ
        for (const p of pts) {
          const lastP = stitches[stitches.length - 1];
          if (lastP && Math.hypot(p.x - lastP.x, p.y - lastP.y) < 1e-6) continue;
          stitches.push(p);
        }
        pos = { x: leftToRight ? seg.x2 : seg.x1, y: seg.y };
        posRef = leftToRight ? seg.c2 : seg.c1;
        leftToRight = !leftToRight;
      }
    }

    // 出口トラベル (Travel on Edge): 次のオブジェクトに最も近い境界点まで
    // 縁に沿って移動してから終わる。渡り距離が縮む場合のみ行う
    if (exitRot !== null && pos !== null && posRef !== null) {
      const ring = rings[posRef.ring];
      const near = nearestOnRing(ring, exitRot);
      const dDirect = Math.hypot(exitRot.x - pos.x, exitRot.y - pos.y);
      if (near.dist + mm(1) < dDirect) {
        const travel = resample(travelAlongRing(ring, posRef.s, near.s), params.stitchLength);
        for (let i = 1; i < travel.length; i++) stitches.push(travel[i]);
      }
    }

    // 回転を元に戻し、整数座標へ丸める
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const unrotated = stitches.map((p) => {
      const q = rotatePoint(p, cos, sin);
      return { x: Math.round(q.x), y: Math.round(q.y) };
    });
    runs.push({ stitches: unrotated, connection: "trim" });
  }

  return { runs, warnings };
}
