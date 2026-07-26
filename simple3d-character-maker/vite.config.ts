import { defineConfig } from 'vite';

// TODO(未決事項 #4, 指示書 13節): GitHub Pages 上の最終的な公開パス（リポジトリ内の
// サブディレクトリとしてこのプロジェクトをどう配置するか）が未確定のため、
// 環境変数 BASE_PATH で上書きできるようにしておく。既定値は開発用のルート。
const base = process.env.BASE_PATH ?? '/simple3d-character-maker/';

export default defineConfig({
  base,
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5174,
  },
});
