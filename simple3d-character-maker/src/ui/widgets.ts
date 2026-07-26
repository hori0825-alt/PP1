/**
 * 数値入力・スライダーなど、パネルで共通に使う小さな DOM ウィジェット。
 * フレームワークを使わないため、要素は一度だけ生成し、以後は `refresh()` で
 * 値だけを書き換える（ドラッグ中に DOM を作り直してフォーカスが失われるのを防ぐ）。
 */

export interface Field<T> {
  el: HTMLElement;
  refresh(value: T): void;
}

function row(labelText: string, input: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field-row';
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(input);
  return wrap;
}

export function numberField(
  label: string,
  value: number,
  onCommit: (v: number) => void,
  opts: { step?: number; min?: number; max?: number } = {},
): Field<number> {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(opts.step ?? 0.1);
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  input.value = String(value);
  input.addEventListener('change', () => {
    const v = Number.parseFloat(input.value);
    if (Number.isFinite(v)) onCommit(v);
  });
  return { el: row(label, input), refresh: (v) => (input.value = String(v)) };
}

/**
 * ドラッグ中は1操作に畳む（6.10節）。pointerdown で onDragStart（履歴記録）を1回呼び、
 * input のたびに onLiveInput（3Dへの反映のみ、履歴は積まない）を呼ぶ。
 */
export function sliderField(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onDragStart: () => void,
  onLiveInput: (v: number) => void,
): Field<number> {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  let started = false;
  input.addEventListener('pointerdown', () => {
    started = true;
    onDragStart();
  });
  input.addEventListener('input', () => {
    if (!started) {
      // キーボード操作など pointerdown を経由しない変更にも対応する
      onDragStart();
      started = true;
    }
    onLiveInput(Number.parseFloat(input.value));
  });
  input.addEventListener('pointerup', () => {
    started = false;
  });
  return { el: row(label, input), refresh: (v) => (input.value = String(v)) };
}

export function checkboxField(
  label: string,
  value: boolean,
  onCommit: (v: boolean) => void,
): Field<boolean> {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onCommit(input.checked));
  return { el: row(label, input), refresh: (v) => (input.checked = v) };
}

export function colorField(
  label: string,
  value: string,
  onCommit: (v: string) => void,
): Field<string> {
  const input = document.createElement('input');
  input.type = 'color';
  input.value = value;
  input.addEventListener('change', () => onCommit(input.value));
  return { el: row(label, input), refresh: (v) => (input.value = v) };
}

export function selectField<T extends string>(
  label: string,
  value: T,
  options: readonly T[],
  onCommit: (v: T) => void,
): Field<T> {
  const input = document.createElement('select');
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    input.appendChild(o);
  }
  input.value = value;
  input.addEventListener('change', () => onCommit(input.value as T));
  return { el: row(label, input), refresh: (v) => (input.value = v) };
}

export function sectionHeading(text: string): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = text;
  h.style.margin = '8px 0 2px';
  h.style.fontSize = '12px';
  h.style.color = '#555';
  return h;
}
