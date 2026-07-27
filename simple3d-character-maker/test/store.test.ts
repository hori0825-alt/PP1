import { describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../src/state/store';
import { createDefaultProjectData } from '../src/presets/eggplant';

describe('ProjectStore', () => {
  it('notifies subscribers and marks dirty on updateWithHistory', () => {
    const store = new ProjectStore(createDefaultProjectData());
    const listener = vi.fn();
    store.subscribe(listener);

    store.updateWithHistory((p) => (p.body.totalHeight = 60));

    expect(store.getProject().body.totalHeight).toBe(60);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.dirty).toBe(true);
  });

  it('undo restores the previous value and redo re-applies it', () => {
    const store = new ProjectStore(createDefaultProjectData());
    store.updateWithHistory((p) => (p.body.totalHeight = 60));
    store.updateWithHistory((p) => (p.body.totalHeight = 70));

    expect(store.undo()).toBe(true);
    expect(store.getProject().body.totalHeight).toBe(60);
    expect(store.undo()).toBe(true);
    expect(store.getProject().body.totalHeight).toBe(42);
    expect(store.undo()).toBe(false); // 履歴が尽きた

    expect(store.redo()).toBe(true);
    expect(store.getProject().body.totalHeight).toBe(60);
  });

  it('collapses a drag into a single history entry via recordHistorySnapshot + updateLive', () => {
    const store = new ProjectStore(createDefaultProjectData());
    store.recordHistorySnapshot(); // pointerdown
    store.updateLive((p) => (p.body.totalHeight = 55)); // input
    store.updateLive((p) => (p.body.totalHeight = 58)); // input
    store.updateLive((p) => (p.body.totalHeight = 60)); // input (pointerup 相当)

    expect(store.getProject().body.totalHeight).toBe(60);
    expect(store.undo()).toBe(true);
    expect(store.getProject().body.totalHeight).toBe(42); // 1回のundoでドラッグ開始前まで戻る
  });

  it('replaceProject resets history and dirty flag', () => {
    const store = new ProjectStore(createDefaultProjectData());
    store.updateWithHistory((p) => (p.body.totalHeight = 60));
    store.replaceProject(createDefaultProjectData());
    expect(store.dirty).toBe(false);
    expect(store.undo()).toBe(false);
  });
});
