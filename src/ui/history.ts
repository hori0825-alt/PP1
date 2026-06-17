// 編集履歴 (Undo/Redo)。設計に関わる状態のスナップショットをスタックで保持する。
//
// 設計:
//   - スナップショットは JSON 直列化できる設計状態の部分集合のみ
//     (regions / オブジェクト層の id・baked / 設定 / plan / 縫い方など)。
//     raster (元画像) や source.data (dataURL) のような大きな非設計データは含めない。
//     画像はメモリ上 (state.raster) に残り続けるので、復元時もそのまま使える。
//   - render() の先頭で recordHistory を呼ぶ。前回スナップショットと同一なら積まない
//     ため、タブ・モード・表示の切替や選択だけの再描画では履歴が増えない。
//   - 復元中 (restoring) は記録しない。復元直後の render は同一スナップショットになり
//     どのみち no-op だが、二重防止のため明示的に止める。

import { recomputeStitches, refreshDerived, restoreObjectsFromProject } from "./state";
import type { AppState } from "./state";

/** 保持する履歴の最大数 (古いものから捨てる)。plan を含むためメモリと相談 */
const MAX_HISTORY = 30;

interface Snapshot {
  regions: AppState["regions"];
  objects: { id: number; baked?: AppState["objects"][number]["baked"]; name?: string }[];
  settings: AppState["project"]["settings"];
  plan: AppState["plan"];
  fillType: AppState["fillType"];
  photoMode: boolean;
  puffy: boolean;
  photoSettings: AppState["photoSettings"];
}

let past: string[] = [];
let future: string[] = [];
let present: string | null = null;
let restoring = false;

/** 設計状態を JSON 文字列に取り出す (循環参照になる region/cache は持たない) */
function capture(state: AppState): string {
  const snap: Snapshot = {
    regions: state.regions,
    objects: state.objects.map((o) => ({ id: o.id, baked: o.baked, name: o.name })),
    settings: state.project.settings,
    plan: state.plan,
    fillType: state.fillType,
    photoMode: state.photoMode,
    puffy: state.puffy,
    photoSettings: state.photoSettings,
  };
  return JSON.stringify(snap);
}

/**
 * 現在の設計状態を履歴に記録する。前回と完全に同じなら何もしない
 * (表示切替・選択などで設計が変わっていなければ履歴は増えない)。
 */
export function recordHistory(state: AppState): void {
  if (restoring) return;
  const snap = capture(state);
  if (snap === present) return; // 設計に変化なし → 履歴化しない
  if (present !== null) {
    past.push(present);
    if (past.length > MAX_HISTORY) past.shift();
  }
  future = []; // 新しい変更が入ったら redo 系列は無効
  present = snap;
}

/** スナップショットを state に適用し、派生 (診断・シーケンス・シミュレーション) を作り直す */
function apply(state: AppState, snapText: string): void {
  const d = JSON.parse(snapText) as Snapshot;
  state.regions = d.regions;
  state.project.regions = state.regions;
  state.project.settings = d.settings;
  state.project.objects = d.objects;
  state.fillType = d.fillType;
  state.photoMode = d.photoMode;
  state.puffy = d.puffy;
  state.photoSettings = d.photoSettings;
  state.plan = d.plan;
  state.project.plan = d.plan;
  // 編集モードや選択は復元状態と矛盾しうるので解除する
  state.vectorEdit = null;
  state.stitchEdit = null;
  state.penDraw = null;
  state.angleLineDraw = false;
  state.selectedRegionIndex = null;
  // オブジェクト層 (id・baked) を復元した領域へ再バインド (添字対応)
  restoreObjectsFromProject(state);
  // 復元した plan があればそれを使って派生だけ作り直す。無ければ領域から再生成。
  if (state.plan) {
    refreshDerived(state);
  } else if (state.regions.length > 0) {
    recomputeStitches(state);
  } else {
    state.diagnostics = null;
    state.sequence = null;
    state.simulation = null;
    state.stitchWarnings = [];
  }
}

/** 1つ前の状態に戻す。戻せたら true */
export function undo(state: AppState): boolean {
  if (past.length === 0) return false;
  const prev = past.pop() as string;
  if (present !== null) future.push(present);
  present = prev;
  restoring = true;
  apply(state, prev);
  restoring = false;
  return true;
}

/** 取り消した変更をやり直す。やり直せたら true */
export function redo(state: AppState): boolean {
  if (future.length === 0) return false;
  const next = future.pop() as string;
  if (present !== null) past.push(present);
  present = next;
  restoring = true;
  apply(state, next);
  restoring = false;
  return true;
}

export function canUndo(): boolean {
  return past.length > 0;
}

export function canRedo(): boolean {
  return future.length > 0;
}

/** 履歴を初期化する (新しいデザインを読み込んだときなど) */
export function resetHistory(): void {
  past = [];
  future = [];
  present = null;
}
