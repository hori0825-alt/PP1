import type { CharacterType } from '../../core/params';
import type { PanelContext, MountedPanel } from './context';
import { sectionHeading } from '../widgets';
import { downloadProjectJson, readProjectFile } from '../../state/persistence';
import { createDefaultProjectData } from '../../presets/eggplant';

const CHARACTER_TYPE_LABELS: Record<CharacterType, string> = {
  eggplant: 'ナス',
  cow: '牛',
};

export function mountProjectPanel(container: HTMLElement, ctx: PanelContext): MountedPanel {
  container.innerHTML = '';
  container.appendChild(sectionHeading('プロジェクト'));

  const characterTypeRow = document.createElement('div');
  characterTypeRow.className = 'field-row';
  const characterTypeLabel = document.createElement('label');
  characterTypeLabel.textContent = 'キャラクター';
  const characterTypeSelect = document.createElement('select');
  (Object.keys(CHARACTER_TYPE_LABELS) as CharacterType[]).forEach((key) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = CHARACTER_TYPE_LABELS[key];
    characterTypeSelect.appendChild(option);
  });
  characterTypeSelect.value = ctx.store.getProject().characterType;
  characterTypeSelect.addEventListener('change', () => {
    ctx.store.updateWithHistory(
      (p) => (p.characterType = characterTypeSelect.value as CharacterType),
    );
  });
  characterTypeRow.appendChild(characterTypeLabel);
  characterTypeRow.appendChild(characterTypeSelect);
  container.appendChild(characterTypeRow);

  const undoBtn = document.createElement('button');
  undoBtn.textContent = '元に戻す (Undo)';
  undoBtn.addEventListener('click', () => ctx.store.undo());
  container.appendChild(undoBtn);

  const redoBtn = document.createElement('button');
  redoBtn.textContent = 'やり直す (Redo)';
  redoBtn.addEventListener('click', () => ctx.store.redo());
  container.appendChild(redoBtn);

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'プロジェクトを保存 (JSON)';
  saveBtn.style.display = 'block';
  saveBtn.addEventListener('click', () => {
    downloadProjectJson(ctx.store.getProject());
    ctx.store.markSaved();
    refresh();
  });
  container.appendChild(saveBtn);

  const loadInput = document.createElement('input');
  loadInput.type = 'file';
  loadInput.accept = 'application/json';
  loadInput.addEventListener('change', () => {
    const file = loadInput.files?.[0];
    if (!file) return;
    readProjectFile(file)
      .then((data) => {
        ctx.store.replaceProject(data);
      })
      .catch((err) => {
        window.alert(`読み込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      });
  });
  container.appendChild(loadInput);

  const resetBtn = document.createElement('button');
  resetBtn.textContent = '初期化';
  resetBtn.style.display = 'block';
  resetBtn.addEventListener('click', () => {
    if (window.confirm('プロジェクトを初期状態に戻します。よろしいですか？')) {
      ctx.store.replaceProject(createDefaultProjectData());
    }
  });
  container.appendChild(resetBtn);

  const statusEl = document.createElement('div');
  statusEl.style.fontSize = '11px';
  container.appendChild(statusEl);

  function refresh(): void {
    characterTypeSelect.value = ctx.store.getProject().characterType;
    undoBtn.disabled = !ctx.store.history.canUndo;
    redoBtn.disabled = !ctx.store.history.canRedo;
    statusEl.textContent = ctx.store.dirty ? '未保存の変更があります' : '保存済み';
  }
  refresh();

  return { refresh };
}
