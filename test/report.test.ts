// 作業指示書とデザインライブラリのテスト (Phase 11)。

import { describe, expect, it } from "vitest";
import { mm } from "../src/core/constants";
import type { Region } from "../src/core/region";
import type { Point } from "../src/core/types";
import { DesignLibrary, MemoryStore } from "../src/library/store";
import type { LibraryEntry } from "../src/library/store";
import { buildWorkOrder } from "../src/report/workorder";
import { digitizeRegions } from "../src/stitch/digitize";

function rect(cx: number, cy: number, w: number, h: number): Point[] {
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

describe("buildWorkOrder", () => {
  const regions: Region[] = [
    { outer: rect(-mm(15), 0, mm(15), mm(15)), holes: [], color: { r: 237, g: 23, b: 31 } },
    { outer: rect(mm(15), 0, mm(15), mm(15)), holes: [], color: { r: 10, g: 85, b: 163 } },
  ];
  const { plan } = digitizeRegions(regions, "WO");

  it("使用糸一覧・統計・推奨設定が揃う", () => {
    const wo = buildWorkOrder(plan, {
      projectId: "PP1-TEST-01",
      designName: "テスト",
      fileName: "test.png",
      createdAt: "2026-06-13T00:00:00Z",
      fabricId: "tshirt",
    });
    expect(wo.projectId).toBe("PP1-TEST-01");
    expect(wo.threads.length).toBe(2);
    // 縫い順が 1,2
    expect(wo.threads.map((t) => t.order)).toEqual([1, 2]);
    // Brother パレットに割り当て (赤#5, 青#2)
    expect(wo.threads.map((t) => t.pecIndex).sort()).toEqual([2, 5]);
    expect(wo.colorChanges).toBe(1);
    expect(wo.totalStitches).toBeGreaterThan(0);
    expect(wo.estMinutes).toBeGreaterThan(0);
    expect(wo.fabric.name).toBe("Tシャツ (ニット)");
    expect(wo.fabric.recommendedNeedle).toContain("ボールポイント");
    expect(wo.issuedAt).toBeTruthy();
  });

  it("各糸の針数合計が総針数に一致する", () => {
    const wo = buildWorkOrder(plan, {
      projectId: "X", designName: "X", fileName: "x", createdAt: "2026-01-01", fabricId: "standard",
    });
    const sum = wo.threads.reduce((n, t) => n + t.stitches, 0);
    expect(sum).toBe(wo.totalStitches);
  });

  it("糸長 (各色・合計) が正で、各色の合計が総糸長に一致する", () => {
    const wo = buildWorkOrder(plan, {
      projectId: "X", designName: "X", fileName: "x", createdAt: "2026-01-01", fabricId: "standard",
    });
    expect(wo.totalThreadMm).toBeGreaterThan(0);
    for (const t of wo.threads) expect(t.lengthMm).toBeGreaterThan(0);
    const sum = wo.threads.reduce((n, t) => n + t.lengthMm, 0);
    expect(sum).toBeCloseTo(wo.totalThreadMm, 5);
  });
});

describe("DesignLibrary", () => {
  function entry(id: string, name: string, tags: string[] = [], favorite = false): LibraryEntry {
    return {
      id, name, tags, favorite,
      sizeMm: { w: 50, h: 50 }, colorCount: 2, stitchCount: 1000,
      createdAt: "2026-01-01", updatedAt: "2026-01-01",
      threads: ["Red", "Blue"], note: "", projectJson: "{}",
    };
  }

  it("保存・取得・更新・削除ができる", () => {
    const lib = new DesignLibrary(new MemoryStore());
    lib.save(entry("a", "花柄"));
    expect(lib.get("a")?.name).toBe("花柄");
    lib.save({ ...entry("a", "花柄2"), createdAt: "2026-01-01" });
    expect(lib.get("a")?.name).toBe("花柄2"); // 同 id は置換
    expect(lib.list().length).toBe(1);
    lib.remove("a");
    expect(lib.get("a")).toBeNull();
  });

  it("名前・タグ・メモで検索できる", () => {
    const lib = new DesignLibrary(new MemoryStore());
    lib.save(entry("a", "ひまわり", ["花", "夏"]));
    lib.save(entry("b", "ロゴ", ["仕事"]));
    expect(lib.list({ query: "ひま" }).map((e) => e.id)).toEqual(["a"]);
    expect(lib.list({ query: "花" }).map((e) => e.id)).toEqual(["a"]);
    expect(lib.list({ tags: ["仕事"] }).map((e) => e.id)).toEqual(["b"]);
    expect(lib.list({ tags: ["花", "夏"] }).map((e) => e.id)).toEqual(["a"]);
    expect(lib.list({ tags: ["花", "存在しない"] })).toHaveLength(0);
  });

  it("お気に入りの切替とフィルター", () => {
    const lib = new DesignLibrary(new MemoryStore());
    lib.save(entry("a", "A"));
    lib.save(entry("b", "B"));
    lib.toggleFavorite("a");
    expect(lib.list({ favoriteOnly: true }).map((e) => e.id)).toEqual(["a"]);
    lib.toggleFavorite("a");
    expect(lib.list({ favoriteOnly: true })).toHaveLength(0);
  });

  it("最近使ったを記録し新しい順に返す", () => {
    const lib = new DesignLibrary(new MemoryStore());
    lib.save(entry("a", "A"));
    lib.save(entry("b", "B"));
    lib.markRecent("a");
    lib.markRecent("b");
    lib.markRecent("a"); // a が先頭に
    expect(lib.recent().map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("全タグを重複なく列挙する", () => {
    const lib = new DesignLibrary(new MemoryStore());
    lib.save(entry("a", "A", ["花", "夏"]));
    lib.save(entry("b", "B", ["花", "仕事"]));
    expect(lib.allTags()).toEqual(["仕事", "夏", "花"]);
  });

  it("永続化される (同じ store から読み戻せる)", () => {
    const store = new MemoryStore();
    new DesignLibrary(store).save(entry("a", "保存テスト"));
    const lib2 = new DesignLibrary(store);
    expect(lib2.get("a")?.name).toBe("保存テスト");
  });
});
