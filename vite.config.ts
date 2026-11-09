import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __AI_API_URL__: JSON.stringify(process.env.VITE_AI_API_URL ?? ""),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        // iPad 向けお絵かき刺繍アプリ
        sketch: resolve(root, "sketch.html"),
      },
    },
  },
});
