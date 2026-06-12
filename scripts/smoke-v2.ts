// v2 パイプライン (objectizer → planner) の E2E スモークテスト
import { writeFileSync } from "node:fs";
import { DEFAULT_GLOBAL } from "../src/core/object";
import { objectize } from "../src/core/objectizer";
import { compileWithLimit } from "../src/core/planner";
import { diagnose, worstLevel } from "../src/core/diagnostics";
import { writePes } from "../src/embroidery/pes";
import { writeDst } from "../src/embroidery/dst";

const w = 240;
const h = 240;
const data = new Uint8ClampedArray(w * h * 4);
const set = (x: number, y: number, r: number, g: number, b: number) => {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  data[i] = r;
  data[i + 1] = g;
  data[i + 2] = b;
  data[i + 3] = 255;
};
// 青い円 + 黄色い星形ブロック + 黒いリング線
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    const d1 = Math.hypot(x - 120, y - 120);
    if (d1 < 100) set(x, y, 47, 126, 194);
    if (d1 < 45) set(x, y, 247, 201, 72);
    if (d1 >= 96 && d1 <= 100) set(x, y, 35, 40, 48);
  }

const g = { ...DEFAULT_GLOBAL, sizeMm: 80, autoBackground: false };
const oz = objectize({ data, width: w, height: h }, g);
console.log(`objects: ${oz.objects.length}`);
for (const o of oz.objects) {
  console.log(`  ${o.name} kind=${o.settings.kind} area=${o.areaPx}px width=${o.estWidthMm === Infinity ? "-" : o.estWidthMm.toFixed(1) + "mm"}`);
}
const { plan, overLimit } = compileWithLimit(oz.objects, oz.order, g, oz.quant, oz.transform, oz.mmPerPx);
plan.pattern.name = "SMOKEV2";
console.log("stats:", JSON.stringify(plan.stats), "overLimit:", overLimit);
console.log(
  "segments:",
  plan.segments.map((s) => `${s.objectId.slice(-4)}:${s.joinType}@${s.joinDistMm}mm/${s.stitches}針`).join(" "),
);
const items = diagnose(plan, g);
console.log("diagnosis:", worstLevel(items));
for (const i of items) if (i.level !== "ok") console.log(`  [${i.level}] ${i.label}: ${i.value}`);
writeFileSync("/tmp/smokev2.pes", writePes(plan.pattern));
writeFileSync("/tmp/smokev2.dst", writeDst(plan.pattern));
console.log("wrote /tmp/smokev2.pes /tmp/smokev2.dst");
