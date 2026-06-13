# 開発ステータス

最終更新: 2026-06-13 (Phase 5 完了)

## 完了フェーズ

### Phase 5: UI・シーケンスビュー・シミュレーター・診断 ✅

#### 追加ファイル

```
src/core/
  project.ts      … 独自プロジェクト形式 (JSON) の保存/読込・ID発行・前方互換
src/plan/
  diagnostics.ts  … diagnose(): validate + stats を OK/注意/修正必須の3段階に。
                    針数超過は autofix='reduce-stitches' を付与
  simulate.ts     … buildSimulation(): flattenPlan の MachineOp を針単位フレームに展開。
                    色替え/糸切りフレーム位置を記録 (ステッチプレイヤー用)
  sequence.ts     … buildSequence(): 縫製順のエントリ列 (色/タイプ/針数/接続/渡り/
                    開始終了点/色替え/糸切り)。reorderBlocks で D&D 並べ替え
src/ui/
  state.ts        … AppState + 再計算 (source→regions→plan→診断/シーケンス/シミュ)
  canvas.ts       … 100mm枠/グリッド/各表示モード/開始(▶)終了(■)マーカー/
                    シミュ再生位置/Viewport 座標変換
  sequenceView.ts … シーケンスビュー描画・選択・表示切替・D&D・フィルター
  main.ts         … 全面再構築。ヘッダー統計チップ + かんたん/プロモード +
                    タブ (デザイン/色/ステッチ/縫い順/布地/診断/出力) +
                    シミュレーターバー
test/
  phase5.test.ts (12) … diagnose / buildSimulation / buildSequence / project
  ui-smoke.test.ts (3, jsdom) … state ロジック + シーケンスビュー描画
```

#### 型拡張

- StitchRun に objectId?・stitchType? を追加 (シーケンスビューのオブジェクト
  グループ化用、optional なので既存構造・連続性ルールに影響なし)
- digitize が領域ごとに objectId を採番、下縫い/本縫いに stitchType を付与

#### UI 機能

- かんたんモード: デザイン/色/診断/出力の4タブ。
  プロモード: + ステッチ/縫い順/布地
- 中央キャンバス: 元画像/減色/ベクター/ステッチ表示切替、ズーム枠固定、
  渡り糸 (jump=灰点線, trim=赤点線)、選択オブジェクトの開始終了マーカー、
  クリックでオブジェクト選択
- シミュレーター: 再生/停止/リセット/スライダー/前後の糸切りへジャンプ、
  現在針数・色番号表示。flattenPlan のフレームを忠実に再生
- シーケンスビュー: 縫製順一覧 (番号/色/タイプ/針数/色替え/糸切り/渡り距離)、
  すべて/糸切りのみ/警告のみフィルター、目アイコンで表示切替、
  D&D で色ブロック順変更 (→ 再診断)
- 診断タブ: 3段階表示 + 針数超過時の自動削減ボタン
- 出力タブ: PES/DST ダウンロード (critical 時はブロック)、
  プロジェクト保存/読込 (.json)

#### 検証状況 (計99テスト)

- diagnose: 正常=ok / 枠外=critical / 針数超過=autofix付与
- buildSimulation: フレーム数=総ステッチ数、色替え/最終位置の整合
- buildSequence: 縫製順連続・色替え/糸切り記録・objectId グループ化・reorder
- project: ラウンドトリップ・欠損補完・不正バージョン例外
- ui-smoke (jsdom): state 再計算・シーケンス描画・目アイコン・フィルター



### Phase 4: 縫い順・糸切り最適化 ✅ (前作の最重要問題への対策)

#### 追加ファイル

```
src/plan/
  order.ts     … optimizeOrder: 貪欲法(最近傍) + 2-opt による巡回順最適化
  connect.ts   … decideConnection: 3mm未満=continuous / 10mm未満=jump / 以遠=trim。
                 TrimMode (auto/never/always) と trimDistance 指定可。
                 同一オブジェクト内は全モードで糸切り禁止
  branching.ts … 線群のグラフ化 + DFS二重走行 (再走行) で連結線群を
                 1本の連続 Run に。branchOrder (単純貪欲) も提供
  stats.ts     … planStats: 針数/色別/糸切り/ジャンプ/渡り距離(最大・平均)/推定時間
  reduce.ts    … autoReduce: 密度↓ → 小領域削除 → 針長↑ → サイズ↓ の順で
                 12,000針以下まで自動削減、適用内容を報告
test/plan.test.ts (18テスト)
```

#### Closest Join / Travel on Edge (糸切り削減の本体)

- digitizeRegions: 色順=面積大→小 (背景先)。同色内は重心の貪欲+2-opt。
  各領域は前の終点を startNear、次の領域の重心を exitNear として生成
- tatamiFill に入口/出口トラベルを追加:
  - 入口: 前のオブジェクトに最も近い境界点から縁沿いに走査入口へ移動
  - 出口: 縫い終わりに次のオブジェクトに最も近い境界点まで縁沿いに移動
  - どちらも「接続距離が 1mm 以上縮む場合のみ」実行 (無駄な travel 抑制)
  - これにより接続距離 = オブジェクト間の実ギャップになり、
    近接オブジェクトの糸切りが構造的に消える
- scanline.ts に nearestOnRing (リング周上の最近点) を追加

#### サンプル実測 (3色・9オブジェクト分散配置、100mm枠)

- 糸切り 6回 = 全て 10mm 超の遠隔ジャンプのみ (近接接続の糸切りゼロ)
- 最適化で総渡り距離 228mm → 185mm (-19%)、針数 1,853 / 色替え 2
- テスト: 近接3個(ギャップ2mm)→糸切り0 / 遠隔2個(50mm)→糸切り1 /
  trimMode=never→0・always→全間 / Y字分岐→再走行込み1本Run



### Phase 3: ステッチ生成 — タタミ/サテン/ランニング/下縫い ✅

#### 追加ファイル

```
src/stitch/
  types.ts       … TatamiParams / SatinParams / RunningParams / GeneratorResult
  scanline.ts    … 角度付きスキャンライン (交点にリング弧長位置を記録)、
                   travelAlongRing (Travel on Edge の経路計算)
  tatami.ts      … タタミ生成。セクション分解 + DFS + 縁沿い移動で
                   1連結領域 = 1本の連続 Run を保証
  satin.ts       … satinFromRails / satinAlongPath (中心線+幅) /
                   satinFromRegion (PCA 主軸スライス)
  running.ts     … ランニング (二重走り対応) / ジグザグライン
  underlay.ts    … 下縫い (edge=内側オフセット周回 / tatami=交差方向の粗いフィル /
                   center / zigzag)、insetPath (頂点法線オフセット)
  postprocess.ts … 最小ステッチ長統合 / 最大ステッチ長分割 (Run 連続性は不変)
  registry.ts    … ジェネレーター登録 (tatami / satin。将来の Wave 等もここに追加)
  digitize.ts    … Region[] → StitchPlan。同色を1ブロックに集約、
                   接続を距離で continuous/jump/trim 判定
test/stitch.test.ts (18テスト)
```

#### タタミの連続性保証 (前作の「面の途中で糸切り」対策の本体)

1. 角度付きスキャンラインで行ごとの内部区間 (Seg) を抽出。各交点には
   「どのリング (外周/穴) の周上何 mm か」(CrossRef) を記録
2. 隣接行の x 重なりで Seg を親子リンクし、分岐 (穴・凹み) のない範囲を
   「セクション」に分解
3. セクション接続グラフを DFS で辿り、セクション間は
   travelAlongRing による縁沿い移動ステッチ (Travel on Edge) で接続。
   異リング間は直線 (隣接セクションなので行間隔程度)
4. 連結成分ごとに 1本の StitchRun として出力。
   Run 内に jump/trim が構造上入らない (テストで隣接距離 ≤ 12.1mm を検証)

#### 同一領域内の糸切り禁止

digitize.ts の decideConnection は sameObject フラグを持ち、
下縫い→本縫い・連結成分間 (同一領域内) では距離に関わらず trim を返さない
(continuous または jump のみ)。テストで検証済み。

#### 検証状況 (Phase 3 時点で計66テスト)

- 矩形タタミ: 1本 Run / 連続性 / 針数が理論値 (面積÷行間隔÷針長) ±30%
- ドーナツ: 1本 Run / 穴の内部 (15% 縮小判定) に着地点ゼロ
- C字 (凹形状) を分断方向に走査しても 1本 Run
- 角度 0°/90° で行方向が変わる
- サテン: 幅保持 / 7mm 超過警告 / 領域からの生成 (PCA スライス)
- ランニング: 間隔 / 二重走り / 閉路
- digitize→validate→PES/DST の一気通貫、下縫い付きで領域内 trim ゼロ

#### UI (Phase 3 時点)

読み込み → サイズ/色数/角度設定 → 元画像/減色後/ベクター/ステッチ表示切替
→ 診断 (針数/色数/糸切り/警告) → 実デザインの PES/DST ダウンロード。
渡り糸は点線表示。検証エラー時は出力ボタンを無効化。

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

## 次フェーズへの引き継ぎ事項 (Phase 6: 実機検証準備・仕上げ)

- 実装内容:
  1. samples/ に実機テスト用サンプル3種を生成・保存:
     (a) 単色の円 (タタミ・連続性確認) (b) 2色・穴あき (穴/色替え確認)
     (c) 3色・同色分散 (糸切り最適化確認)。各々に期待糸切り/色替え/針数を明記
  2. PES バイナリの最終検証: 出力 PES を test/helpers.ts の decodePes で
     読み戻し、針数/色/座標一致のラウンドトリップを samples で確認
  3. エッジケース: 1針 Run・空 ColorBlock・枠ぴったりデザイン
  4. README.md を v2 内容に全面更新 (使い方・実機テスト手順)
  5. docs/ に実機テスト手順書
- サンプル生成は Node スクリプト (scripts/) で digitizeRegions →
  writePes/writeDst → ファイル書き出し。合成 Region を直接組む
  (画像不要、決定的)
- 既知の制約 (将来改善):
  - 色順は面積降順のみ (重なり検出による厳密レイヤー判定は未実装)
  - 開始点/終了点マーカーは表示・自動配置のみ (ドラッグ変更は未実装。
    tatamiFill の startNear/exitNear をユーザー上書きする経路が必要)
  - シーケンスビューの D&D は色ブロック単位 (同色内オブジェクトの
    並べ替えは未実装)
  - satinFromRegion は startNear/exitNear 未対応 (タタミのみ)
  - PES は最小構成 v1 (CEmbOne なし)。実機で問題あれば v6 検討

## 未解決・保留

- PES ラッパーは最小構成 (truncated v1)。実機で問題があれば PES v6 +
  CEmbOne/CSewSeg の実装を検討 (Phase 6 の実機検証で判断)
- PEC サムネイルはステッチ点のプロット (線描画なし)。見栄えが悪ければ
  Phase 6 で Bresenham 線描画に改善
- DST の trim 3連ジャンプは慣例実装。PP1 は PES 主体なので優先度低
