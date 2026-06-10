// E2E スモークテスト: 合成画像 → digitize → PES/DST 書き出し (Node で実行)
// 出力した PES を pyembroidery で読み戻して検証する (scripts/validate.py)

import { writeFileSync } from "node:fs";
import { digitize } from "../src/digitize/pipeline";
import { writePes } from "../src/embroidery/pes";
import { writeDst } from "../src/embroidery/dst";

const w = 200;
const h = 200;
const data = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const dx = x - 100;
    const dy = y - 100;
    const r2 = dx * dx + dy * dy;
    if (r2 > 90 * 90) {
      data[i + 3] = 0; // 透明背景
    } else if (r2 < 40 * 40) {
      data[i] = 247;
      data[i + 1] = 201;
      data[i + 2] = 72; // 黄
      data[i + 3] = 255;
    } else if (Math.abs(dx) < 12 || Math.abs(dy) < 12) {
      data[i] = 240;
      data[i + 1] = 240;
      data[i + 2] = 240; // 白の十字
      data[i + 3] = 255;
    } else {
      data[i] = 47;
      data[i + 1] = 126;
      data[i + 2] = 194; // 青
      data[i + 3] = 255;
    }
  }
}

const result = digitize({ data, width: w, height: h }, { sizeMm: 80, maxColors: 4 });
result.pattern.name = "SMOKE";
console.log("stats:", JSON.stringify(result.stats));
console.log(
  "threads:",
  result.pattern.threads.map((t) => `${t.name}(#${t.catalog})`).join(", "),
);

writeFileSync("/tmp/smoke.pes", writePes(result.pattern));
writeFileSync("/tmp/smoke.dst", writeDst(result.pattern));
console.log("wrote /tmp/smoke.pes and /tmp/smoke.dst");
