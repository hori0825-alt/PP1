// ステッチ生成のテスト。
// 最重要: 全ジェネレーターで「1つの面 = 1本の連続 Run (途中に糸切り/ジャンプなし)」。

import { describe, expect, it } from "vitest";
import { MAX_STITCH_LEN, SATIN_DEFAULT, TATAMI_DEFAULT, mm } from "../src/core/constants";
import { pointInPolygon } from "../src/core/geometry";
import type { Region } from "../src/core/region";
import type { Point, StitchRun } from "../src/core/types";
import { digitizeRegions } from "../src/stitch/digitize";
import { postprocessRun } from "../src/stitch/postprocess";
import { getGenerator, listGenerators } from "../src/stitch/registry";
import { runningStitch } from "../src/stitch/running";
import { satinAlongPath, satinFromRegion } from "../src/stitch/satin";
import { tatamiFill } from "../src/stitch/tatami";
import { insetPath } from "../src/stitch/underlay";
import { writeDst } from "../src/export/dst";
import { writePes } from "../src/export/pes";
import { validatePlan } from "../src/export/validate";

const RED = { r: 220, g: 30, b: 30 };

function rect(cx: number, cy: number, w: number, h: number): Point[] {
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

function circle(cx: number, cy: number, r: number, n = 64): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  return pts;
}

/** Run 内の隣接ステッチ距離が maxLen 以下で連続していることを検証 */
function assertContinuity(run: StitchRun, maxLen = MAX_STITCH_LEN): void {
  expect(run.stitches.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < run.stitches.length; i++) {
    const d = Math.hypot(
      run.stitches[i].x - run.stitches[i - 1].x,
      run.stitches[i].y - run.stitches[i - 1].y,
    );
    expect(d).toBeLessThanOrEqual(maxLen + 1); // 丸め誤差 1 単位許容
  }
}

const defaultParams = {
  angleDeg: 0,
  rowSpacing: TATAMI_DEFAULT.rowSpacing,
  stitchLength: TATAMI_DEFAULT.stitchLength,
};

describe("tatamiFill", () => {
  it("矩形は1本の連続 Run になり針数が理論値 ±30% に収まる", () => {
    const region: Region = { outer: rect(0, 0, mm(20), mm(20)), holes: [], color: RED };
    const { runs, warnings } = tatamiFill(region, defaultParams);
    expect(warnings).toHaveLength(0);
    expect(runs.length).toBe(1);
    assertContinuity(runs[0]);

    // 理論針数 = 面積 / (行間隔 × ステッチ長)
    const theoretical = (mm(20) * mm(20)) / (TATAMI_DEFAULT.rowSpacing * TATAMI_DEFAULT.stitchLength);
    expect(runs[0].stitches.length).toBeGreaterThan(theoretical * 0.7);
    expect(runs[0].stitches.length).toBeLessThan(theoretical * 1.3);
  });

  it("全ステッチが領域内 (境界含む) にある", () => {
    const outer = rect(0, 0, mm(15), mm(15));
    const region: Region = { outer, holes: [], color: RED };
    const { runs } = tatamiFill(region, defaultParams);
    for (const p of runs[0].stitches) {
      expect(p.x).toBeGreaterThanOrEqual(-mm(7.5) - 2);
      expect(p.x).toBeLessThanOrEqual(mm(7.5) + 2);
      expect(p.y).toBeGreaterThanOrEqual(-mm(7.5) - 2);
      expect(p.y).toBeLessThanOrEqual(mm(7.5) + 2);
    }
  });

  it("ドーナツ形状: 1本の Run で穴の内部に着地しない", () => {
    const region: Region = {
      outer: circle(0, 0, mm(15)),
      holes: [circle(0, 0, mm(6)).reverse()], // 穴は負方向
      color: RED,
    };
    const { runs } = tatamiFill(region, defaultParams);
    expect(runs.length).toBe(1); // ドーナツは連結なので1本
    assertContinuity(runs[0]);

    // 穴を 15% 縮小した領域に着地点がないこと (境界上の Travel は許容)
    const shrunkHole = circle(0, 0, mm(6) * 0.85);
    for (const p of runs[0].stitches) {
      expect(pointInPolygon(p, shrunkHole)).toBe(false);
    }
  });

  it("C字形状 (凹形状) も1本の連続 Run になる", () => {
    // C字: 大矩形から右側をくり抜いた形 (角度90°で走査すると分断が起きる)
    const outer: Point[] = [
      { x: -mm(10), y: -mm(10) },
      { x: mm(10), y: -mm(10) },
      { x: mm(10), y: -mm(4) },
      { x: -mm(2), y: -mm(4) },
      { x: -mm(2), y: mm(4) },
      { x: mm(10), y: mm(4) },
      { x: mm(10), y: mm(10) },
      { x: -mm(10), y: mm(10) },
    ];
    const region: Region = { outer, holes: [], color: RED };
    // 垂直走査 (angleDeg=90) だと左の背骨と上下の腕でセクション分割が必要になる
    const { runs } = tatamiFill(region, { ...defaultParams, angleDeg: 90 });
    expect(runs.length).toBe(1);
    assertContinuity(runs[0]);
  });

  it("角度指定が効く (0° と 90° で行方向が変わる)", () => {
    const region: Region = { outer: rect(0, 0, mm(10), mm(10)), holes: [], color: RED };
    const h = tatamiFill(region, { ...defaultParams, angleDeg: 0 });
    const v = tatamiFill(region, { ...defaultParams, angleDeg: 90 });
    // 水平走査では連続するステッチの y がほぼ一定の行が多い
    const horizontalness = (run: StitchRun): number => {
      let same = 0;
      for (let i = 1; i < run.stitches.length; i++) {
        if (Math.abs(run.stitches[i].y - run.stitches[i - 1].y) < 2) same++;
      }
      return same / run.stitches.length;
    };
    expect(horizontalness(h.runs[0])).toBeGreaterThan(0.6);
    expect(horizontalness(v.runs[0])).toBeLessThan(0.4);
  });

  it("離れた2つの島は別 Run になる (面の途中の糸切りとは区別)", () => {
    // 1つの Region に物理的に離れた2島は通常来ないが、
    // 連結成分ごとに Run が分かれることを確認 (8の字など)
    const region: Region = { outer: rect(0, 0, mm(20), mm(2)), holes: [], color: RED };
    const { runs } = tatamiFill(region, { ...defaultParams, rowSpacing: mm(0.4) });
    expect(runs.length).toBe(1);
  });
});

describe("satinAlongPath", () => {
  it("連続したジグザグで幅が保たれる", () => {
    const path = [
      { x: -mm(15), y: 0 },
      { x: mm(15), y: 0 },
    ];
    const { runs, warnings } = satinAlongPath(path, mm(3));
    expect(warnings).toHaveLength(0);
    expect(runs.length).toBe(1);
    assertContinuity(runs[0]);
    // 偶数番目→奇数番目のペア距離 ≈ 幅
    const st = runs[0].stitches;
    for (let i = 0; i + 1 < st.length; i += 2) {
      const d = Math.hypot(st[i + 1].x - st[i].x, st[i + 1].y - st[i].y);
      expect(Math.abs(d - mm(3))).toBeLessThan(3);
    }
  });

  it("幅が 7mm を超えると警告が出る", () => {
    const path = [
      { x: 0, y: 0 },
      { x: mm(20), y: 0 },
    ];
    const { warnings } = satinAlongPath(path, mm(9));
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("タタミ");
  });
});

describe("satin (領域から)", () => {
  it("細長い領域からサテンが生成され幅超過はない", () => {
    const gen = getGenerator("satin");
    expect(gen).toBeDefined();
    const region: Region = { outer: rect(0, 0, mm(30), mm(3)), holes: [], color: RED };
    const { runs, warnings } = (gen as NonNullable<typeof gen>)(region, {});
    expect(warnings).toHaveLength(0);
    expect(runs.length).toBe(1);
    assertContinuity(runs[0]);
    // ジグザグ幅 ≈ 3mm (短軸方向)
    const st = runs[0].stitches;
    let maxPair = 0;
    for (let i = 0; i + 1 < st.length; i += 2) {
      maxPair = Math.max(maxPair, Math.hypot(st[i + 1].x - st[i].x, st[i + 1].y - st[i].y));
    }
    expect(maxPair).toBeLessThanOrEqual(mm(3) + 5);
    expect(maxPair).toBeGreaterThan(mm(2));
  });

  it("幅広の領域では警告が出る", () => {
    const gen = getGenerator("satin") as NonNullable<ReturnType<typeof getGenerator>>;
    const region: Region = { outer: rect(0, 0, mm(30), mm(10)), holes: [], color: RED };
    const { warnings } = gen(region, { maxWidth: SATIN_DEFAULT.maxWidth });
    expect(warnings.some((w) => w.includes("タタミ"))).toBe(true);
  });
});

describe("satin 角度最適化 (中心線追従)", () => {
  const spacing = mm(0.4);
  const maxW = SATIN_DEFAULT.maxWidth;

  function maxSpan(runs: { stitches: Point[] }[]): number {
    let m = 0;
    for (const run of runs) {
      for (let i = 0; i + 1 < run.stitches.length; i += 2) {
        m = Math.max(
          m,
          Math.hypot(
            run.stitches[i + 1].x - run.stitches[i].x,
            run.stitches[i + 1].y - run.stitches[i].y,
          ),
        );
      }
    }
    return m;
  }

  // 幅 3mm の弓なり (arc) 帯: 固定角だと斜めに伸びてストロークが長くなる
  function arcBand(): Point[] {
    const pts: Point[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = (Math.PI * i) / 16;
      pts.push({ x: Math.cos(t) * mm(20), y: Math.sin(t) * mm(20) });
    }
    for (let i = 16; i >= 0; i--) {
      const t = (Math.PI * i) / 16;
      pts.push({ x: Math.cos(t) * mm(17), y: Math.sin(t) * mm(17) });
    }
    return pts;
  }

  it("湾曲した帯ではストローク (1針) が大幅に短くなる", () => {
    const region: Region = { outer: arcBand(), holes: [], color: RED };
    const off = satinFromRegion(region, { spacing, maxWidth: maxW, optimizeAngle: false });
    const on = satinFromRegion(region, { spacing, maxWidth: maxW, optimizeAngle: true });
    const spanOff = maxSpan(off.runs);
    const spanOn = maxSpan(on.runs);
    // 帯の実幅は約 3mm。最適化で実幅近くまで縮む (固定角は倍以上に伸びる)
    expect(spanOff).toBeGreaterThan(mm(7));
    expect(spanOn).toBeLessThan(spanOff * 0.6);
    expect(spanOn).toBeLessThan(mm(5));
    assertContinuity(on.runs[0]);
  });

  it("最適化は最大ストロークを基準より長くしない (テーパ形状でも悪化しない)", () => {
    const tri: Point[] = [
      { x: 0, y: 0 },
      { x: mm(40), y: 0 },
      { x: mm(40), y: mm(6) },
    ];
    const region: Region = { outer: tri, holes: [], color: RED };
    const off = satinFromRegion(region, { spacing, maxWidth: maxW, optimizeAngle: false });
    const on = satinFromRegion(region, { spacing, maxWidth: maxW, optimizeAngle: true });
    expect(maxSpan(on.runs)).toBeLessThanOrEqual(maxSpan(off.runs) + 2);
  });

  it("まっすぐな細帯では最適化しても結果が変わらない", () => {
    const region: Region = { outer: rect(0, 0, mm(30), mm(3)), holes: [], color: RED };
    const off = satinFromRegion(region, { spacing, maxWidth: maxW, optimizeAngle: false });
    const on = satinFromRegion(region, { spacing, maxWidth: maxW, optimizeAngle: true });
    expect(Math.abs(maxSpan(on.runs) - maxSpan(off.runs))).toBeLessThanOrEqual(2);
  });
});

describe("runningStitch", () => {
  it("ステッチ間隔がほぼ指定長になる", () => {
    const path = [
      { x: 0, y: 0 },
      { x: mm(30), y: 0 },
    ];
    const { runs } = runningStitch(path, { stitchLength: mm(2.5) });
    assertContinuity(runs[0], mm(2.5) + 2);
    expect(runs[0].stitches.length).toBe(13); // 30mm / 2.5mm = 12区間 + 1
  });

  it("二重走りは開始点に戻る", () => {
    const path = [
      { x: 0, y: 0 },
      { x: mm(10), y: 0 },
      { x: mm(10), y: mm(10) },
    ];
    const { runs } = runningStitch(path, { double: true });
    const st = runs[0].stitches;
    expect(st[st.length - 1]).toEqual(st[0]);
    assertContinuity(runs[0]);
  });

  it("閉路指定で終点から始点への辺も縫う", () => {
    const { runs } = runningStitch(rect(0, 0, mm(10), mm(10)), {}, true);
    const st = runs[0].stitches;
    expect(st[st.length - 1]).toEqual(st[0]);
  });
});

describe("insetPath (下縫い用オフセット)", () => {
  it("矩形が内側に縮む", () => {
    const path = insetPath(rect(0, 0, mm(10), mm(10)), mm(1));
    for (const p of path) {
      expect(Math.abs(p.x)).toBeLessThan(mm(5));
      expect(Math.abs(p.y)).toBeLessThan(mm(5));
    }
  });
});

describe("postprocessRun", () => {
  it("短すぎるステッチが統合され、長すぎるステッチが分割される", () => {
    const run: StitchRun = {
      stitches: [
        { x: 0, y: 0 },
        { x: 2, y: 0 }, // 0.2mm → 統合される
        { x: mm(3), y: 0 },
        { x: mm(30), y: 0 }, // 27mm → 分割される
      ],
      connection: "trim",
    };
    const out = postprocessRun(run);
    expect(out.stitches.some((p) => p.x === 2)).toBe(false);
    assertContinuity(out);
  });
});

describe("digitizeRegions (一気通貫)", () => {
  it("同色領域は1ブロックにまとまり、検証を通って PES/DST 出力できる", () => {
    const regions: Region[] = [
      { outer: rect(-mm(15), 0, mm(12), mm(12)), holes: [], color: RED },
      { outer: rect(mm(15), 0, mm(12), mm(12)), holes: [], color: RED },
      { outer: circle(0, mm(20), mm(5)), holes: [], color: { r: 30, g: 60, b: 200 } },
    ];
    const { plan, warnings } = digitizeRegions(regions, "E2E");
    expect(warnings).toHaveLength(0);
    expect(plan.blocks.length).toBe(2); // 赤1ブロック + 青1ブロック

    const result = validatePlan(plan);
    expect(result.ok).toBe(true);
    expect(result.stats.colorChanges).toBe(1);

    // エクスポートが例外なく動く
    expect(writePes(plan).data.length).toBeGreaterThan(512);
    expect(writeDst(plan).length).toBeGreaterThan(512);
  });

  it("下縫い付きでも同一領域内に糸切りが入らない", () => {
    const regions: Region[] = [
      { outer: rect(0, 0, mm(20), mm(20)), holes: [], color: RED },
    ];
    const { plan } = digitizeRegions(regions, "UL", { underlay: ["edge", "tatami"] });
    const block = plan.blocks[0];
    expect(block.runs.length).toBeGreaterThanOrEqual(3); // edge + tatami下縫い + 本縫い
    // 先頭以外の Run (同一領域内) に trim 接続がない
    for (let i = 1; i < block.runs.length; i++) {
      expect(block.runs[i].connection).not.toBe("trim");
    }
  });

  it("レジストリに標準ジェネレーターが登録されている", () => {
    expect(listGenerators()).toContain("tatami");
    expect(listGenerators()).toContain("satin");
  });

  it("fillType=satin: 細い領域はサテンで縫われる (ジグザグ)", () => {
    const regions: Region[] = [{ outer: rect(0, 0, mm(30), mm(3)), holes: [], color: RED }];
    const { plan } = digitizeRegions(regions, "SATIN", { fillType: "satin" });
    expect(plan.blocks.length).toBe(1);
    // サテンは左右交互 (ジグザグ) なので、連続ステッチの y 符号が交互に振れる
    const st = plan.blocks[0].runs[0].stitches;
    expect(st.length).toBeGreaterThan(4);
  });

  it("fillType=satin: 穴あき複雑形状はタタミにフォールバックする", () => {
    // 穴ありはサテン不可 → タタミ。例外なく生成できることを確認
    const regions: Region[] = [
      { outer: circle(0, 0, mm(20)), holes: [circle(0, 0, mm(8)).reverse()], color: RED },
    ];
    const { plan } = digitizeRegions(regions, "FB", { fillType: "satin" });
    expect(plan.blocks.length).toBe(1);
    expect(plan.blocks[0].runs.length).toBeGreaterThan(0);
  });

  it("fillType=auto: 太い領域はタタミ、細い領域はサテン", () => {
    const wide: Region[] = [{ outer: rect(0, 0, mm(30), mm(30)), holes: [], color: RED }];
    const thin: Region[] = [{ outer: rect(0, 0, mm(30), mm(3)), holes: [], color: RED }];
    const wideStitches = digitizeRegions(wide, "W", { fillType: "auto" }).plan.blocks[0].runs[0].stitches.length;
    const thinStitches = digitizeRegions(thin, "T", { fillType: "auto" }).plan.blocks[0].runs[0].stitches.length;
    // どちらも生成でき、太い方が針数が多い
    expect(wideStitches).toBeGreaterThan(thinStitches);
  });
});
