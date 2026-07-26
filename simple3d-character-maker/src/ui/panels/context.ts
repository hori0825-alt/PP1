import type { ProjectStore } from '../../state/store';

/**
 * 各パネルモジュールに共通で渡すコンテキスト。
 * ジオメトリ・テクスチャアトラスの再生成やパネル表示値の同期はすべて
 * store.subscribe() 経由で一括して行うため（main.ts 参照）、
 * パネル側は store のミューテーションメソッドを呼ぶだけでよい。
 */
export interface PanelContext {
  store: ProjectStore;
}

export interface MountedPanel {
  /** undo/redo・プロジェクト読込などストア外部からの変更後に表示値を再同期する。 */
  refresh(): void;
}
