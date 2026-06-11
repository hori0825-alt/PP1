// 線画デモ: スケルトンベースの線縫いの品質確認用
import { writeFileSync } from "node:fs";
import { digitize } from "../src/digitize/pipeline";
import { writePes } from "../src/embroidery/pes";

const w = 300;
const h = 300;
const data = new Uint8ClampedArray(w * h * 4);

const paint = (x: number, y: number, r: number, g: number, b: number) => {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  data[i] = r;
  data[i + 1] = g;
  data[i + 2] = b;
  data[i + 3] = 255;
};

// 太めのストロークを描く
const stroke = (x0: number, y0: number, x1: number, y1: number, width: number, rgb: [number, number, number]) => {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.ceil(len * 2);
  for (let i = 0; i <= n; i++) {
    const cx = x0 + ((x1 - x0) * i) / n;
    const cy = y0 + ((y1 - y0) * i) / n;
    const r = width / 2;
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        if (dx * dx + dy * dy <= r * r) paint(Math.round(cx + dx), Math.round(cy + dy), ...rgb);
      }
    }
  }
};

// 1. 塗りの円 (タタミ確認用)
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    if (Math.hypot(x - 80, y - 80) < 45) paint(x, y, 240, 180, 60);
  }
}

// 2. 連結した線ネットワーク (分岐あり) — 髪の毛のようなストローク
const dark: [number, number, number] = [50, 40, 40];
stroke(160, 40, 270, 40, 5, dark); // 横線
stroke(215, 40, 215, 150, 5, dark); // 縦線 (分岐)
stroke(215, 150, 160, 200, 5, dark); // 斜め
stroke(215, 150, 270, 200, 5, dark); // 斜め (もう一方)

// 3. リング (閉じた輪の線)
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const r = Math.hypot(x - 80, y - 230);
    if (r >= 32 && r <= 37) paint(x, y, 50, 40, 40);
  }
}

// 4. 離れた短い線 (同色・separate component)
stroke(250, 250, 290, 270, 4, dark);

const result = digitize(
  { data, width: w, height: h },
  { sizeMm: 90, maxColors: 3, autoBackground: false, minRegionMm2: 0.5 },
);
result.pattern.name = "LINEART";
console.log("stats:", JSON.stringify(result.stats));
writeFileSync("/tmp/lineart.pes", writePes(result.pattern));
console.log("wrote /tmp/lineart.pes");
