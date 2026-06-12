# 開発ステータス

最終更新: 2026-06-12 (Phase 2 完了)

## 完了フェーズ

### Phase 2: 画像入力 — PNG/SVG 読み込み + 色数削減 + 領域抽出 ✅

#### 追加ファイル

```
src/core/
  geometry.ts    … 符号付き面積 / 内外判定 / Douglas-Peucker / Chaikin / 自己交差検出
  region.ts      … Region 型 (outer + holes + color)。Phase 3 の入力
src/import/
  raster.ts      … RasterImage 型、透明・白背景マスク (縁からの BFS で内部の白は保護)
  quantize.ts    … Lab 空間 k-means 減色 (2〜15色)、ラベル平滑化、小成分統合
  regions.ts     … ピクセル境界エッジ追跡 → 閉ループ連結 → 外周/穴分類 → DP+Chaikin
  svg.ts         … 軽量 XML パーサー + パスデータ (M/L/H/V/C/S/Q/T/A/Z) + transform + 色
src/ui/
  loadImage.ts   … File → RasterImage (Canvas デコード、最大600px に縮小)
  main.ts        … Phase 2 確認ページ (読込/サイズ/色数/白背景除去/表示切替/色別面積)
test/
  geometry.test.ts / import.test.ts / svg.test.ts
```

#### 実装の要点

- **減色 (quantize.ts)**: Lab 色空間 k-means (決定的初期化、最大2万サンプル)。
  3×3 近傍多数決のラベル平滑化×2回 + 4連結の小成分統合 (デフォルト16px未満)
  で AA 由来の中間色・ゴミ領域を除去。針数爆発の主因対策。
- **領域抽出 (regions.ts)**: ピクセル4辺の境界エッジを向き付きで集め、頂点を
  辿って閉ループ化。角接触は最時計回り側を選び4連結に一致。符号付き面積で
  外周 (正) / 穴 (負) を分類し、穴は重心を含む最小外周に割り当てる。
- **平滑化**: DP 許容誤差はピクセル空間で `max(0.15mm, 0.75px)`
  (階段ノイズ振幅 ~0.5px を確実に除去) → Chaikin×2 → 再 DP。
- **SVG**: DOM 非依存の自前 XML/パスパーサー (vitest の node 環境でテスト可能)。
  evenodd の包含深度で外周/穴を分類。`fill="none"` はスキップ
  (線の刺繍化 = ランニング/サテンラインは Phase 3 以降)。
  読み込み時に全体を指定サイズ (デフォルト100mm) へ中心配置でフィット。
- 座標は全て内部単位 (0.1mm)・中心原点に正規化済み。Region の outer は
  signedArea 正 (画面座標系で時計回り)、穴は負で統一。

#### 検証状況 (Phase 2 時点で計48テスト)

- 3色+白背景 → パレット3色 / AA 中間色の統合 / 透明背景 → ラベル -1
- ドーナツ → 外周1+穴1 (符号も検証)、離れた同色矩形 → 2領域、3mm² 未満除去
- 円の輪郭点数がピクセル境界の 1/2 以下に削減され枠内に収まる
- SVG: 図形/パース/穴/スケール/transform 継承/style fill
- `npm run dev` で PNG/SVG を読み込み、元画像/減色後/ベクターを切替表示できる



### Phase 1: 基盤 — データモデル + PES/DST エクスポーター ✅

旧 v1 コード (src/, test/, scripts/) を全削除し、新アーキテクチャで再構築した。

#### ファイル構成

```
src/
  core/
    constants.ts   … 全数値パラメータ (枠サイズ・針数上限・糸切り閾値など)
    types.ts       … StitchPlan / ColorBlock / StitchRun / ThreadColor
    plan.ts        … 針数・糸切り・色替え集計、バウンディングボックス
  export/
    flatten.ts     … StitchPlan → MachineOp[] (共通ミシン命令列)
    binWriter.ts   … バイナリ書き込みユーティリティ
    brotherPalette.ts … Brother 標準64色 + 最近色割り当て
    pec.ts         … PEC ブロック書き出し (ステッチ・パレット・サムネイル)
    pes.ts         … PES v1 ラッパー
    dst.ts         … DST エクスポーター
    validate.ts    … 出力前バリデーション
  stitch/          … (空。Phase 3 でステッチジェネレーター)
  plan/            … (空。Phase 4 で縫い順・糸切り最適化)
  import/          … (空。Phase 2 で画像/SVG読み込み)
  ui/
    main.ts        … Phase 1 確認ページ (プレビュー + PES/DST ダウンロード)
    demo.ts        … デモ StitchPlan (2色のジグザグ矩形)
    app.css
test/
  helpers.ts       … PES/PEC・DST デコーダー (ラウンドトリップ検証用)
  flatten.test.ts / pes.test.ts / dst.test.ts / validate.test.ts
```

#### データモデルの要点 (糸切り問題の構造的対策)

- 糸切り・ジャンプは `StitchRun.connection` ('continuous' | 'jump' | 'trim')
  としてのみ存在。**Run の途中に糸切りを挿入できる構造が存在しない**。
- 内部座標: 0.1mm 単位の整数、原点はデザイン中心、+y 下。
- エクスポーターは `flattenPlan()` の MachineOp 列を忠実に変換するだけ。
  最適化判断は Phase 4 の src/plan/ に分離する。
- 12.1mm 超の移動は flatten が自動分割 (Run 内は中間ステッチ、Run 間はジャンプ)。

#### PES/PEC バイナリレイアウト実装メモ

PES (最小構成 v1、PP1 が読むのは PEC 部分):
```
0x00  "#PES0001"
0x08  u32le: PEC ブロックへのオフセット
0x0C  u16le 0x0001 (scale to fit)
0x0E  u16le 0x0000 (フープ 0 = 100×100mm ← PP1 向け)
0x10  u16le 0x0000 (セグメントブロック数 0)
0x12  u16le 0xFFFF, u16le 0x0000 (CEmbOne セクションなし)
0x16  PEC ブロック
```

PEC ブロック (オフセットはブロック先頭基準):
```
0x000 "LA:" + ラベル16字(空白詰め) + 0x0D
0x014 0x20×12
0x020 FF 00 06 26 (サムネイル 6byte幅=48px × 38px)
0x024 0x20×12
0x030 色数-1
0x031 パレットインデックス列 (1色1byte、Brother 64色の番号)
      … 0x20 詰めで 0x200 まで
0x200 00 00 / u24le ブロック長(0x200起点〜0xFF終端) / 31 FF F0 /
      幅 u16le / 高 u16le / E0 01 / B0 01 /
      u16be 0x9000|(-minX) / u16be 0x9000|(-minY)
      ステッチデータ / 0xFF
以降  サムネイル 228byte × (1 + 色数)
```

PEC ステッチエンコード:
- 短形式: dx,dy とも -64..63 → 各1byte (7bit 2の補数)
- 長形式: 2byte/座標。上位byte = 0x80 | flags | (v>>8 & 0x0F)、v は 12bit 2の補数
  - flags: 0x10 = jump, 0x20 = trim
- trim は「次のジャンプ移動の1針目に trim フラグを付与」で表現
- ジャンプ後、通常ステッチ再開前に 00 00 (0移動アンカー) を1針挿入
- 色替え: FE B0 + 交互の 02/01。終端: FF

DST:
- 512byte ヘッダー (LA/ST/CO/+X/-X/+Y/-Y/AX/AY/MX/MY/PD + 0x1A + 0x20詰め)
- 3byte/レコード。移動量は平衡三進法 (±1,3,9,27,81) で ±121 (12.1mm)
- b2: bit0,1 常時セット、bit7 = jump、bit7+6 = 色替え。終端 00 00 F3
- Y軸は上が正 (内部座標から反転して出力)
- 糸切りコードがないため trim は (+2,+2)(-4,-4)(+2,+2) の3連ジャンプで表現

#### 検証状況

- `npm run test`: 23テスト全通過
  - DST レコード ±121 全値ラウンドトリップ
  - PES/DST 出力 → 自前デコーダーで座標・色・色替え数を照合
  - 12.1mm 超移動の自動分割、trim→jump 順序、Run 内連続性
  - バリデーター (枠外 / 12,000針超過 / 短ステッチ / continuous 距離)
- `npm run build`: 成功
- `npm run dev` でデモページから phase1-demo.pes / .dst をダウンロード可能

## 次フェーズへの引き継ぎ事項 (Phase 3: ステッチ生成)

- 実装先: `src/stitch/`。入力は `Region` (src/core/region.ts)、出力は
  `StitchRun[]` (1つの面 = 1本の連続 Run。これが最重要ルール)
- ジェネレーターはプラグイン構造にする:
  `interface StitchGenerator { generate(region, params): StitchRun[] }`
- タタミ: 角度指定スキャンライン。セグメント間は領域の縁を通る移動ステッチ
  (Travel on Edge) で接続し1本の Run にする。穴をまたがない。
  凹形状はサブ領域分割 + 縁経由接続で連続性を保つ
- サテン: 中心線+幅からジグザグ。幅 7mm 超は警告フラグ + タタミ切替提案。
  細い Region からの中心線抽出 (スケルトン) も必要
- ランニング/ジグザグライン、下縫い3種 (中心/エッジ/ジグザグ、複数指定可)。
  下縫いと本縫いは同一 ColorBlock 内の連続 Run (間に糸切りなし)
- 後処理: 最小ステッチ長未満の統合 / 最大ステッチ長超の分割
  (constants.ts の MIN_STITCH_LEN / MAX_STITCH_LEN を使う)
- Region.outer/holes は浮動小数。ステッチ点の生成時に整数へ丸めること
- テスト必須項目: 全ジェネレーターの Run 連続性 (隣接距離 ≤ MAX_STITCH_LEN)、
  ドーナツで穴に着地点がない、C字形状で Run が1本、針数が理論値 ±30%

## 未解決・保留

- PES ラッパーは最小構成 (truncated v1)。実機で問題があれば PES v6 +
  CEmbOne/CSewSeg の実装を検討 (Phase 6 の実機検証で判断)
- PEC サムネイルはステッチ点のプロット (線描画なし)。見栄えが悪ければ
  Phase 6 で Bresenham 線描画に改善
- DST の trim 3連ジャンプは慣例実装。PP1 は PES 主体なので優先度低
