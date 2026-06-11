# PP1 Stitch Studio

**Brother SKiTCH PP1 専用・ブラウザで動く刺しゅうデータ作成ツール**

PNG / JPG の画像から刺しゅうデータ (PES / DST) を生成します。すべての処理はブラウザ内で完結し、サーバーへのアップロードはありません。生成した PES を Artspira アプリでインポートすれば、Bluetooth で PP1 へ転送して縫えます。

## 背景

PP1 の純正アプリ Artspira は、画像 (PNG など) からの刺しゅうデータ変換の精度が低く、変換結果の修正も困難です。本ツールは Artistic Digitizer のような専用デジタイザの考え方を参考に、**変換パラメータをすべて自分でコントロールできる**ことを目指しています。

- Artspira は PES / DST ファイルのインポートに対応しています ([Brother 公式 FAQ](https://help.brother-usa.com/app/answers/detail/a_id/185209/~/file-formats-to-use-with-skitch))
- インポート → 編集 → PP1 へ Bluetooth 転送のワークフローは公式にサポートされています ([参考記事](https://hoopingstation.com/blogs/articles/artspira-brother-skitch-pp1-the-calm-repeatable-workflow-for-picking-designs-importing-pes-dst-and-nailing-placement-with-ar-preview))

## 使い方

### 起動

```bash
npm install
npm run dev      # http://localhost:5173
```

### ワークフロー

1. **画像を読み込む** — PNG (透明背景推奨) / JPG をドロップ。「サンプルデザインで試す」でも動作確認できます
2. **パラメータを調整** — プレビューを見ながらリアルタイムに変換結果を確認
3. **不要な部分を抜く** — プレビューの塗り領域をクリックすると、その領域を「縫わない (抜き)」にできます。×印を再クリックで解除
4. **糸色を確認** — Brother 標準糸の色番号に自動マッピング。不要な色はチェックを外して除外
5. **PES をダウンロード** — スマホに送り、Artspira の「インポート」から読み込んで PP1 へ転送

### パラメータの目安

| 項目 | 既定値 | 説明 |
| --- | --- | --- |
| サイズ | 90mm | 長辺の仕上がり寸法。PP1 の枠は 100×100mm |
| 色数 | 6 | 糸の本数。少ないほど縫製が速く仕上がりが安定 |
| 行間隔 | 0.4mm | タタミ縫いの密度。薄い生地は 0.45〜0.5mm に |
| 最大ステッチ長 | 3mm | 長いほど速いが表面が粗くなる |
| 縫い角度 | 45° | タタミ縫いの方向 |
| 最小領域 | 1mm² | これより小さいゴミ領域を除去 (細長い線状領域は対象外)。ノイズの多い画像は大きく |
| サテン適用幅 | 6mm | この推定幅以下の領域はサテン縫い (1針クロス) になる |
| センターライン閾値 | 1.5mm | この幅以下の極細線は中心線をランニングで縫う。線画の輪郭・眉・口などを表現 |
| 糸切りを減らす | ON | 同色内の短い移動を糸切りせずつなぎ縫いで接続する |
| 同色の最大接続距離 | 7mm | これ以下の移動はつなぎ縫い。超えると糸切り+ジャンプ |
| アウトライン滑らかさ | 2 | 角を保持しつつ輪郭のガタガタを平滑化 (0=なし〜3=強) |

## 変換パイプライン

```
画像 → ①減色 → ②輪郭抽出 → ③ステッチ生成 → ④PES/DST 書き出し
```

1. **減色** (`src/digitize/quantize.ts`) — 透明部と画像端の均一色を背景として除去し、k-means で指定色数に減色。モードフィルタと小領域マージでノイズを除去
2. **輪郭抽出** (`src/digitize/contour.ts`) — 色ごとに領域の輪郭ループ (外周+穴) を抽出し、Douglas-Peucker で簡略化 → 角保持つき Chaikin 平滑化でピクセル境界のガタガタを除去
3. **ステッチ生成** (`src/digitize/fill.ts`, `outline.ts`) — 領域 (外周+穴のまとまり) ごとに推定幅から縫いモードを自動選択:
   - 広い領域 → 走査線方式のタタミ縫い (レンガ状の針落ち、穴をまたぐ移動は渡り糸に変換)
   - 細い領域 (〜6mm) → サテン縫い (領域の長軸に直交する1針クロス)
   - 極細の線 (〜1.5mm) → センターライン縫い (開いた線は中心線スキャン、閉じた輪っか状の線は輪郭をなぞる)
4. **縫い順とつなぎ** (`src/digitize/pipeline.ts`) — 実機で糸切りが多発しないことを最優先:
   - 同色内は nearest-neighbor で最短移動順に並べ替え (run の反転も考慮)
   - 移動が「同色の最大接続距離」以下なら糸を切らずつなぎ縫い (最大ステッチ長以下の針目) で接続
   - 糸切り (TRIM) は長距離移動と色替え前のみ。面の途中では絶対に切らない
5. **書き出し** (`src/embroidery/pes.ts`, `dst.ts`) — PES v1 (CEmbOne/CSewSeg + PEC ブロック) と Tajima DST。糸切りは TRIM 明示時のみ出力 (PEC: 0x20 フラグ / DST: 3連微小ジャンプ)。[pyembroidery](https://github.com/EmbroidePy/pyembroidery) のリファレンス実装を移植し、読み戻し検証済み

## 開発

```bash
npm run dev      # 開発サーバー
npm test         # ユニットテスト (vitest)
npm run build    # 型チェック + プロダクションビルド
```

E2E スモークテスト (要 Python + pyembroidery):

```bash
npx tsx scripts/smoke.ts        # /tmp/smoke.pes, /tmp/smoke.dst を生成
python3 scripts/validate.py     # pyembroidery で読み戻し検証
```

## 既知の制限とロードマップ

- [ ] **サテンステッチ** — 細い帯状領域の自動検出とサテン柱生成 (文字・縁取りの品質向上)
- [ ] **下打ち (アンダーレイ)** — 生地の安定化。現状は密度調整で代用
- [ ] **引き縮み補正 (pull compensation)** — 領域の縫い方向への拡張
- [ ] **SVG 入力** — ベクターデータからの直接変換 (ラスタライズなし)
- [ ] **手動編集** — 領域の統合・分割、色ごとの角度指定、縫い順の入れ替え
- [x] **渡り糸の最適化** — 同色内 nearest-neighbor 並べ替え + つなぎ縫い (v0.5.0)

## ライセンス・参考

- PES/PEC/DST フォーマットの実装は [pyembroidery](https://github.com/EmbroidePy/pyembroidery) (MIT) を参考にしています
- 糸色は Brother 標準の PEC 64色パレットを使用
