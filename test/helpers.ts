// テスト用デコーダー。実体は src/export/decode.ts に昇格済み (Phase 6)。
// 既存テストの import パスを保つための再エクスポート。

export {
  decodeDst,
  decodeDstRecord,
  decodePes,
  dstStitchPoints,
  pesStitchPoints,
  type DecodedDst,
  type DecodedDstRecord,
  type DecodedPecOp,
  type DecodedPes,
} from "../src/export/decode";
