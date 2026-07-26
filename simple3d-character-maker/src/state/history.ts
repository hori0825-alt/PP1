import type { ProjectData } from '../core/params';

/**
 * Undo/Redo 用のスナップショットスタック（6.10節）。
 * データ量が小さいため、構造共有を使わずスナップショット丸ごとのスタック方式でよい。
 * 上限50段。「変更前」のスナップショットを push し、undo/redo で現在値と入れ替える。
 */
export class HistoryManager {
  private undoStack: ProjectData[] = [];
  private redoStack: ProjectData[] = [];

  constructor(private readonly maxSize = 50) {}

  /** 変更を適用する直前に、変更前の状態を記録する。 */
  recordBeforeChange(current: ProjectData): void {
    this.undoStack.push(structuredClone(current));
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(current: ProjectData): ProjectData | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(structuredClone(current));
    return prev;
  }

  redo(current: ProjectData): ProjectData | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(structuredClone(current));
    return next;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
