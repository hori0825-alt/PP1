// 細い線の認識デモ: 線画風の合成画像 (顔の輪郭・眉・口が細い線) を
// digitize して PES を書き出す。scripts/validate.py や手動レンダリングで確認する。

import { writeFileSync } from "node:fs";
import { digitize } from "../src/digitize/pipeline";
import { writePes } from "../src/embroidery/pes";

const w = 800;
const h = 800;
const data = new Uint8ClampedArray(w * h * 4);

function put(x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  data[i] = r;
  data[i + 1] = g;
  data[i + 2] = b;
  data[i + 3] = 255;
}

function disk(cx: number, cy: number, rad: number, r: number, g: number, b: number): void {
  for (let y = Math.floor(cy - rad); y <= cy + rad; y++) {
    for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= rad * rad) put(x, y, r, g, b);
    }
  }
}

function ring(cx: number, cy: number, rad: number, width: number, r: number, g: number, b: number): void {
  const ro = rad + width / 2;
  const ri = rad - width / 2;
  for (let y = Math.floor(cy - ro); y <= cy + ro; y++) {
    for (let x = Math.floor(cx - ro); x <= cx + ro; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= ro && d >= ri) put(x, y, r, g, b);
    }
  }
}

function stroke(x0: number, y0: number, x1: number, y1: number, width: number, r: number, g: number, b: number): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(len);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    disk(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, r, g, b);
  }
}

// 顔: 肌色の円 + 細い輪郭線 (6px ≈ 元画像の線画)
disk(400, 400, 280, 250, 235, 228);
ring(400, 400, 280, 6, 90, 50, 45);

// 髪: 上半分の帯
for (let y = 80; y <= 240; y++) {
  for (let x = 140; x <= 660; x++) {
    const dx = x - 400;
    const dy = y - 400;
    if (dx * dx + dy * dy <= 280 * 280) put(x, y, 165, 90, 75);
  }
}

// 眉: 細い線 (5px)
stroke(280, 320, 360, 305, 5, 90, 50, 45);
stroke(440, 305, 520, 320, 5, 90, 50, 45);

// 目: 塗りつぶし楕円風
disk(320, 390, 28, 200, 60, 50);
disk(480, 390, 28, 200, 60, 50);

// 口: 細い曲線 (4px)
stroke(360, 520, 400, 535, 4, 90, 50, 45);
stroke(400, 535, 440, 520, 4, 90, 50, 45);

const result = digitize(
  { data, width: w, height: h },
  { sizeMm: 70, maxColors: 5, autoBackground: false },
);
result.pattern.name = "FACE";
console.log("stats:", JSON.stringify(result.stats));
console.log(
  "threads:",
  result.pattern.threads.map((t) => `${t.name}(#${t.catalog})`).join(", "),
);
writeFileSync("/tmp/face.pes", writePes(result.pattern));
console.log("wrote /tmp/face.pes");
