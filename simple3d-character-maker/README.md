# Simple3D Character Maker

3D モデリング未経験者でも、参考画像を見ながらナス・牛のような単純なデフォルメ
キャラクターをブラウザ上で調整し、フルカラー3Dプリント用データ（OBJ / MTL /
PNG / GLB / STL）を書き出せる Web アプリです。

外部サーバー・APIキーは不要で、すべてブラウザ内で完結します。ユーザーの
参照画像やプロジェクトデータは外部へ送信されません。

既存の刺しゅうデジタイザアプリ（PP1 Stitch Studio）とは別プロジェクトとして、
このリポジトリのサブディレクトリに独立した Vite プロジェクトを構成しています。

## 現在の実装状況（ナス：Phase 1 MVP／牛：参考画像ベースで先行実装）

開発指示書 rev.2 の Phase 1（6章）をナスで実装したのち、ユーザー提供の参考画像
（デフォルメイラスト+その「3D化」試作品）をもとに、Phase 1.5/2 のゲート前に
牛のモデリングも先行して実装しています（本体上部の「キャラクター」切り替え）。

- 単位・座標系（mm・Z-up・原点=底面中心）
- 断面制御点の Catmull-Rom 補間 + スーパー楕円による本体表面関数 `S(t, θ)`
- ナス: 本体・ヘタ(5枚)・茎・目・口のメッシュ生成（すべて `S(t, θ)` を直接評価。
  レイキャストは不使用のため本体の形状変更に自動追従）
- 牛: 胴体・頭を `S(t, θ)` ベースの「浮いたカプセル」として水平向きに配置し、
  脚(4本)・耳・角・しっぽ(+房)・斑点模様・目・鼻先/鼻孔をすべて本体表面上の
  位置として評価して追従させる（同じく自動追従・レイキャスト不使用）
- 参照画像オーバーレイ + 2点クリック+実寸mm入力によるキャリブレーション
- 単一マテリアル・単一テクスチャアトラス方式（2048×2048、パーツごとの単色パッチ。
  ナス・牛のパッチを両方常時保持し、切り替え時にテクスチャを作り直さない）
- ナス（本体・ヘタ・茎・顔・色）・牛（胴体・頭・脚・耳・角・しっぽ・目・鼻・
  斑点・色）それぞれのパラメータUI + 印刷設定UI（スライダーはドラッグ中
  1操作に畳んで Undo/Redo に積む）
- プロジェクトの保存・読込（JSON、バージョンチェック付き、キャラクタータイプ込み）、
  Undo/Redo、未保存時の離脱確認
- OBJ(+MTL 後挿入)・STL(バイナリ)・GLB(mm/Z-up→m/Y-up変換)・ZIP一括出力
  （キャラクタータイプに関わらず共通のパイプライン）
- 3Dプリント前検査（ウォータータイト・非多様体・法線一貫性・縮退三角形・
  連結成分数・パーツ間埋め込み・最小径・寸法・接地・原点・三角形数・
  テクスチャ有無・three-mesh-bvh による近似最小肉厚）。ナス・牛それぞれの
  構成に応じた項目（茎/葉 vs 脚/しっぽ/角の最小径など）で評価する。

Phase 1.5（Boolean Union による本体結合・厳密な自己交差判定）は未着手です。
牛は開発指示書の想定 Phase より前倒しで実装しているため、指示書 8章の詳細仕様
との厳密な整合は取れていません（参考画像から起こしたプリセット値が中心）。

## 動作環境

- Windows の Chrome / Edge を優先動作確認環境とします。
- スマートフォンは閲覧・簡易調整程度を想定しています（詳細編集はPC向け）。

## セットアップ

```bash
npm install
```

## 開発

```bash
npm run dev
```

`http://localhost:5174/simple3d-character-maker/` が開きます（`vite.config.ts`
の `base` に合わせたパスです）。

## テスト

```bash
npm test        # vitest（vitest.config.ts）
npm run lint     # ESLint
npm run format   # Prettier で整形
```

## ビルド

```bash
npm run build
```

型チェック（`tsc --noEmit`）と本番ビルドを行い、`dist/` に静的ファイルが
生成されます。

## GitHub Pages への配置

1. `vite.config.ts` の `base`（既定 `/simple3d-character-maker/`）を、実際に
   配置するパスに合わせて環境変数 `BASE_PATH` で上書きするか、直接編集します。
   ```bash
   BASE_PATH=/実際のパス/ npm run build
   ```
2. `dist/` の内容を GitHub Pages で配信するブランチ・ディレクトリに配置します。
3. API キーや外部サーバーは不要なため、静的ホスティングのみで動作します。

> **TODO（未決事項 #4、指示書13節）**: このプロジェクトは既存の刺しゅうアプリと
> 同一リポジトリのサブディレクトリに置かれているため、GitHub Pages 上で
> どのパスに配置するか（モノレポ内の1プロジェクトとして出すか、別リポジトリに
> 切り出すか）は未確定です。確定次第 `vite.config.ts` の `base` を調整してください。

## アーキテクチャ

```
src/
  core/       params.ts（データモデル）  spline.ts  migrate.ts  units.ts
  geometry/   surface.ts（S(t,θ)）  bodyMesh.ts  calyxMesh.ts  stemMesh.ts
              faceMesh.ts  capsuleMesh.ts（浮いたカプセル・牛の胴体/頭用）
              cowMesh.ts（牛の全パーツ組み立て）
              meshUtils.ts（共通シェル生成・テーパー円柱・巻き順補正）
  texture/    atlas.ts（パッチ配置定数。ナス5+牛5の計10パッチ）  canvasPainter.ts
  export/     obj.ts  glb.ts  stl.ts  zip.ts  readme.ts
  inspect/    topology.ts（境界・非多様体・法線・連結成分）
              checks.ts（6.8節13項目。ナス/牛それぞれの構成に対応）  report.ts
  state/      store.ts（唯一の正としての ProjectData）  history.ts  persistence.ts
  viewer/     scene.ts  cameras.ts  overlay.ts  controls.ts
  ui/         panels/（本体・ヘタ・茎・顔・色・牛・印刷設定・プロジェクト）
              graphs/  widgets.ts  referencePanel.ts
  presets/    eggplant.ts（ナスの初期パラメータ一式）  cow.ts（牛の初期パラメータ一式）
```

- TypeScript strict。
- UI 状態と3Dシーン状態を分離し、Three.js のオブジェクトを状態として
  保持しません。`ProjectData`（JSON化できる純粋データ）のみを唯一の正とし、
  3Dシーンはそこからの再生成物として扱います。
- `npm test` で断面補間・表面関数・各パーツのウォータータイト性・巻き順の
  一貫性・エクスポート形式・検査ロジックなどを検証しています。

## 印刷業者仕様（確認済み・未決事項#1・#2 回答）

- 受入データ形式: モデリングデータ `.OBJ` / テクスチャデータ `.PNG`・`.JPG` /
  マテリアルデータ `.MTL`。本アプリの ZIP 出力（OBJ+MTL+PNG）で対応済みです。
- 実寸1mm未満の部分は折れやすいため太くする必要があります。
  `PrintSettings`・`inspect/checks.ts`・`geometry/stemMesh.ts` はこの確定値
  （半径0.5mm未満・肉厚1mm未満で赤警告）を反映済みです。黄警告のしきい値
  （`PrintSettings`）は安全マージンとして調整可能です。
- 本体から離れた薄い部分（リボン状の突起等）は接地面を設ける必要があります。
- メガネのレンズ等、透ける素材を意図した部分は白色で出力されます。
- 色は CMYK 出力（Pantone指定不可）。本アプリは RGB で出力するため、
  印刷会社側の CMYK 変換で色味が変化する場合があります。

## 既知の制約・TODO

- ナスの寸法（最大幅 36.7mm 等）は仮値です。実寸参照画像が確定次第
  `src/presets/eggplant.ts` を差し替えてください（未決事項 #3）。
- 口の彫り込み（`relief < 0`）は見た目のみで、実際のジオメトリ凹みは
  Phase 1.5 の Boolean 減算まで実装しません。
- 本体・ヘタ・茎・顔・牛の各パーツは、Phase 1 の間は別パーツのまま保持し、
  Boolean Union による結合と厳密な自己交差判定は Phase 1.5 で行います。
- 牛のプリセット寸法・角/耳の配置は、ユーザー提供の参考イラストを見ながら
  目視で調整した値であり、実寸参照や開発指示書 8章の詳細仕様との厳密な
  すり合わせはできていません。
