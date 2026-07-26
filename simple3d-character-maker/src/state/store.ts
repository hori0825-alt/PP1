import type { ProjectData } from '../core/params';
import { HistoryManager } from './history';

/**
 * JSON へ保存できる純粋データ（ProjectData）を唯一の正として保持するストア（方針11）。
 * Three.js のオブジェクトは一切保持しない。UI はこのストアを購読して再描画する。
 */
export class ProjectStore {
  private project: ProjectData;
  private readonly listeners = new Set<() => void>();
  readonly history = new HistoryManager();
  dirty = false;

  constructor(initial: ProjectData) {
    this.project = initial;
  }

  getProject(): ProjectData {
    return this.project;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** 変更前スナップショットを記録してから mutator を適用する（1操作 = 1スナップショット）。 */
  updateWithHistory(mutator: (project: ProjectData) => void): void {
    this.history.recordBeforeChange(this.project);
    mutator(this.project);
    this.dirty = true;
    this.notify();
  }

  /**
   * スライダーのドラッグ用: pointerdown で1回だけ呼び、ドラッグ開始時点のスナップショットを積む。
   * 以後 pointerup までの input イベントは {@link updateLive} で履歴を積まずに反映する。
   */
  recordHistorySnapshot(): void {
    this.history.recordBeforeChange(this.project);
  }

  /** 履歴を積まずに反映する（ドラッグ中の連続 input イベント用）。 */
  updateLive(mutator: (project: ProjectData) => void): void {
    mutator(this.project);
    this.dirty = true;
    this.notify();
  }

  /** スナップショット記録をしない軽微な更新（例: カメラ状態）に使う。 */
  updateSilently(mutator: (project: ProjectData) => void): void {
    mutator(this.project);
    this.notify();
  }

  undo(): boolean {
    const prev = this.history.undo(this.project);
    if (!prev) return false;
    this.project = prev;
    this.dirty = true;
    this.notify();
    return true;
  }

  redo(): boolean {
    const next = this.history.redo(this.project);
    if (!next) return false;
    this.project = next;
    this.dirty = true;
    this.notify();
    return true;
  }

  /** プロジェクト読込・初期化など、履歴をリセットして丸ごと差し替える。 */
  replaceProject(data: ProjectData): void {
    this.project = data;
    this.history.clear();
    this.dirty = false;
    this.notify();
  }

  markSaved(): void {
    this.dirty = false;
  }
}
