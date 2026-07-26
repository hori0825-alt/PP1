import { describe, expect, it } from 'vitest';
import { HistoryManager } from '../src/state/history';
import { createDefaultProjectData } from '../src/presets/eggplant';

describe('HistoryManager', () => {
  it('undo restores the previous snapshot and enables redo', () => {
    const history = new HistoryManager();
    const stateA = createDefaultProjectData();
    stateA.body.totalHeight = 50;

    history.recordBeforeChange(stateA);
    const stateB = structuredClone(stateA);
    stateB.body.totalHeight = 60;

    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);

    const restored = history.undo(stateB);
    expect(restored?.body.totalHeight).toBe(50);
    expect(history.canRedo).toBe(true);

    const redone = history.redo(restored!);
    expect(redone?.body.totalHeight).toBe(60);
  });

  it('caps the undo stack at maxSize', () => {
    const history = new HistoryManager(3);
    const base = createDefaultProjectData();
    for (let i = 0; i < 5; i++) {
      const snapshot = structuredClone(base);
      snapshot.body.totalHeight = i;
      history.recordBeforeChange(snapshot);
    }
    // 上限3を超えた分は古いものから捨てられるため、undo できる回数は3回だけ
    let current = structuredClone(base);
    let successfulUndos = 0;
    let result = history.undo(current);
    while (result) {
      successfulUndos++;
      current = result;
      result = history.undo(current);
    }
    expect(successfulUndos).toBe(3);
  });

  it('clears the redo stack after a new change is recorded', () => {
    const history = new HistoryManager();
    const stateA = createDefaultProjectData();
    history.recordBeforeChange(stateA);
    const stateB = structuredClone(stateA);
    history.undo(stateB);
    expect(history.canRedo).toBe(true);

    history.recordBeforeChange(stateA);
    expect(history.canRedo).toBe(false);
  });
});
