# 開発ステータス

最終更新: 2026-06-12 (Phase 1 完了)

## 完了フェーズ

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

## 次フェーズへの引き継ぎ事項 (Phase 2: 画像入力)

- 実装先: `src/import/` (PNG/JPG/BMP 読み込み、k-means 減色、領域抽出、
  輪郭追跡 + Douglas-Peucker + スムージング、SVG パース)
- 出力する型: `Region { outer: Path, holes: Path[], color: ThreadColor }`
  を `src/core/` に追加すること (Phase 3 のステッチ生成の入力になる)
- 座標は読み込み時に内部単位 (0.1mm 整数、中心原点) に正規化すること
- コアロジックは DOM 非依存に保つこと。Canvas/ImageData が必要な部分は
  薄いアダプター越しに使い、ピクセル処理自体は Uint8Array ベースで
  テスト可能にすること
- 100mm 枠への自動スケールとサイズプリセット (10/7/5/3/2cm/任意) は
  src/import/ の責務

## 未解決・保留

- PES ラッパーは最小構成 (truncated v1)。実機で問題があれば PES v6 +
  CEmbOne/CSewSeg の実装を検討 (Phase 6 の実機検証で判断)
- PEC サムネイルはステッチ点のプロット (線描画なし)。見栄えが悪ければ
  Phase 6 で Bresenham 線描画に改善
- DST の trim 3連ジャンプは慣例実装。PP1 は PES 主体なので優先度低
