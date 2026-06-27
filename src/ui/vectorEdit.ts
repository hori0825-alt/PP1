// ベクター/ノード編集 UI。
// キャンバスに編集形状とノードハンドルを重ね描きし、ポインタでノードを
// 移動/追加/削除する。Snap to Artwork は元画像/SVG 由来の領域輪郭を参照する。

import { mm } from "../core/constants";
import { BROTHER_PALETTE, nearestBrotherThread } from "../export/brotherPalette";
import { addNode, deleteNode, moveNode, pathToPolyline, setAllNodeTypes } from "../vector/path";
import type { EditPath } from "../vector/path";
import { snapToArtwork } from "../vector/snap";
import { designToScreen, screenToDesign } from "./canvas";
import type { Viewport } from "./canvas";
import { liveApplyVectorEdit } from "./state";
import type { AppState, VectorEditState } from "./state";

function activePath(ve: VectorEditState): EditPath {
  const shape = ve.shapes[ve.activeShape];
  return ve.activePath === "outer" ? shape.outer : shape.holes[ve.activePath];
}

function setActivePath(ve: VectorEditState, path: EditPath): void {
  const shape = ve.shapes[ve.activeShape];
  if (ve.activePath === "outer") shape.outer = path;
  else shape.holes[ve.activePath] = path;
}

/** Snap 参照に使う輪郭 (編集中以外の領域 + 現在の全形状) */
function snapRefs(state: AppState): { x: number; y: number }[][] {
  return state.regions.map((r) => r.outer);
}

/** キャンバスに編集形状とノードを重ね描き */
export function drawVectorEdit(canvas: HTMLCanvasElement, v: Viewport, state: AppState): void {
  const ve = state.vectorEdit;
  if (!ve) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ve.shapes.forEach((shape, si) => {
    const active = si === ve.activeShape;
    const drawPath = (path: EditPath, isActivePath: boolean): void => {
      const poly = pathToPolyline(path);
      if (poly.length === 0) return;
      ctx.beginPath();
      poly.forEach((p, i) => {
        const [x, y] = designToScreen(v, canvas, p.x, p.y);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      if (path.closed) ctx.closePath();
      ctx.strokeStyle = active ? `rgb(${shape.color.r},${shape.color.g},${shape.color.b})` : "#c4ccd4";
      ctx.lineWidth = active ? 1.4 : 0.8;
      ctx.stroke();

      // ノードハンドル (アクティブパスのみ)
      if (active && isActivePath) {
        path.nodes.forEach((node, ni) => {
          const [x, y] = designToScreen(v, canvas, node.x, node.y);
          const sel = ni === ve.selectedNode;
          ctx.beginPath();
          if (node.type === "corner") {
            ctx.rect(x - 4, y - 4, 8, 8);
          } else {
            ctx.arc(x, y, 4.5, 0, Math.PI * 2);
          }
          ctx.fillStyle = sel ? "#2f6fed" : "#ffffff";
          ctx.fill();
          ctx.strokeStyle = "#2f6fed";
          ctx.lineWidth = 1.4;
          ctx.stroke();
        });
      }
    };
    drawPath(shape.outer, ve.activePath === "outer");
    shape.holes.forEach((h, hi) => drawPath(h, ve.activePath === hi));
  });
}

/** ノードのヒットテスト (画面距離 8px 以内) */
function hitNode(ve: VectorEditState, v: Viewport, canvas: HTMLCanvasElement, sx: number, sy: number): number | null {
  const path = activePath(ve);
  for (let i = 0; i < path.nodes.length; i++) {
    const [x, y] = designToScreen(v, canvas, path.nodes[i].x, path.nodes[i].y);
    if (Math.hypot(x - sx, y - sy) <= 8) return i;
  }
  return null;
}

/** 折れ線上で最も近いセグメントの後ろのノード index を返す (追加位置決め用) */
function nearestSegmentIndex(path: EditPath, p: { x: number; y: number }): number {
  let best = 0;
  let bestD = Infinity;
  const n = path.nodes.length;
  const count = path.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = path.nodes[i];
    const b = path.nodes[(i + 1) % n];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const d = Math.hypot(mx - p.x, my - p.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** キャンバスにポインタハンドラを取り付ける。戻り値は解除関数 */
export function attachVectorPointer(canvas: HTMLCanvasElement, v: Viewport, state: AppState, redraw: () => void): () => void {
  let dragging: number | null = null;

  const bufferXY = (ev: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    const fx = rect.width > 0 ? canvas.width / rect.width : 1;
    const fy = rect.height > 0 ? canvas.height / rect.height : 1;
    return [(ev.clientX - rect.left) * fx, (ev.clientY - rect.top) * fy];
  };
  const toDesign = (ev: PointerEvent): { x: number; y: number } => {
    const [sx, sy] = bufferXY(ev);
    return screenToDesign(v, canvas, sx, sy);
  };

  const onDown = (ev: PointerEvent): void => {
    const ve = state.vectorEdit;
    if (!ve) return;
    const [sx, sy] = bufferXY(ev);
    const hit = hitNode(ve, v, canvas, sx, sy);

    if (ve.tool === "delete") {
      if (hit !== null) {
        setActivePath(ve, deleteNode(activePath(ve), hit));
        ve.selectedNode = null;
        liveApplyVectorEdit(state); // 形状変更を即反映 (このパーツのみ縫い直す)
        state.onChange?.();
      }
      return;
    }
    if (ve.tool === "add") {
      const p = toDesign(ev);
      const path = activePath(ve);
      const segIdx = nearestSegmentIndex(path, p);
      setActivePath(ve, addNode(path, segIdx, p));
      ve.selectedNode = segIdx + 1;
      liveApplyVectorEdit(state);
      state.onChange?.();
      return;
    }
    // select: ノードをつかんでドラッグ
    if (hit !== null) {
      dragging = hit;
      ve.selectedNode = hit;
      canvas.setPointerCapture(ev.pointerId);
      redraw();
    } else {
      ve.selectedNode = null;
      redraw();
    }
  };

  const onMove = (ev: PointerEvent): void => {
    const ve = state.vectorEdit;
    if (!ve || dragging === null) return;
    let p = toDesign(ev);
    if (ve.snapEnabled) p = snapToArtwork(p, snapRefs(state), mm(1.5));
    setActivePath(ve, moveNode(activePath(ve), dragging, p));
    // ドラッグ中もライブ再生成 (このパーツのみ・診断は省いて軽量に)
    liveApplyVectorEdit(state, { skipDerived: true });
    redraw();
  };

  const onUp = (ev: PointerEvent): void => {
    if (dragging !== null) {
      dragging = null;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {
        // capture 未設定なら無視
      }
      liveApplyVectorEdit(state); // 最終確定 (診断・縫い順も更新)
      state.onChange?.();
    }
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  return () => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
  };
}

/** ベクタータブの HTML */
export function vectorTabContent(state: AppState): string {
  const ve = state.vectorEdit;
  const pd = state.penDraw;

  if (pd) {
    const need = pd.kind === "fill" ? 3 : 2;
    const ready = pd.points.length >= need;
    return `
      <h2>手動デジタイズ (作図中)</h2>
      <p class="note">${pd.kind === "fill" ? "面" : "線"}を作図中 — キャンバスをクリックで点を追加。${pd.points.length} 点。</p>
      <div class="ve-tools">
        <button id="pen-finish" ${ready ? "" : "disabled"}>確定 (ダブルクリックでも可)</button>
        <button id="pen-cancel" class="secondary">取消</button>
      </div>
      <p class="note">${pd.kind === "fill" ? "3点以上で面になります。始点へ自動で閉じます。" : "2点以上で走り縫いになります。"}</p>`;
  }

  if (!ve) {
    return `<p class="note">ベクター編集を開始すると、輪郭をノードとして編集できます。</p>
      <button id="ve-enter">ベクター編集を開始</button>
      <h2>パーツの追加</h2>
      <div class="ve-tools">
        <button id="pen-fill">面を描く (フィル)</button>
        <button id="pen-line">線を描く (走り縫い)</button>
      </div>
      <p class="note">キャンバスをクリックして点を置き、ダブルクリックで確定。</p>`;
  }
  const shape = ve.shapes[ve.activeShape];
  const pathCount = 1 + shape.holes.length;
  const node = ve.selectedNode !== null ? activePath(ve).nodes[ve.selectedNode] : null;
  const colorThread = nearestBrotherThread(shape.color);
  const threadGrid = BROTHER_PALETTE.map(
    (th) =>
      `<button class="thread-sw ${th.pecIndex === colorThread.pecIndex ? "active" : ""}" data-pec="${th.pecIndex}" title="${th.name}" style="background:rgb(${th.r},${th.g},${th.b})"></button>`,
  ).join("");
  return `
    <h2>編集対象</h2>
    <label>形状
      <select id="ve-shape">${ve.shapes.map((s, i) => `<option value="${i}" ${i === ve.activeShape ? "selected" : ""}>形状 ${i + 1} (rgb ${s.color.r},${s.color.g},${s.color.b})</option>`).join("")}</select>
    </label>
    ${pathCount > 1 ? `<label>パス
      <select id="ve-path">
        <option value="outer" ${ve.activePath === "outer" ? "selected" : ""}>外周</option>
        ${shape.holes.map((_, i) => `<option value="${i}" ${ve.activePath === i ? "selected" : ""}>穴 ${i + 1}</option>`).join("")}
      </select></label>` : ""}
    <h2>糸色</h2>
    <div class="region-color">
      <div class="note">糸色: ${colorThread.name}（縫うとこの色になります）</div>
      <div class="thread-grid">${threadGrid}</div>
    </div>
    <h2>ノード編集ツール</h2>
    <div class="ve-tools">
      ${(["select", "add", "delete"] as const).map((t) => `<button class="ve-tool ${ve.tool === t ? "active" : ""}" data-tool="${t}">${{ select: "選択/移動", add: "ノード追加", delete: "ノード削除" }[t]}</button>`).join("")}
    </div>
    <p class="note">${ve.tool === "select" ? "キャンバスのノードをドラッグして形を変えます。" : ve.tool === "add" ? "キャンバスの輪郭線をクリックするとノードを追加します。" : "キャンバスのノードをクリックすると削除します。"}</p>
    <label><input type="checkbox" id="ve-snap" ${ve.snapEnabled ? "checked" : ""}> Snap to Artwork (下絵に吸着)</label>
    <h2>ノード</h2>
    ${node ? `<div class="ve-node-edit">
      <span>選択中: ノード ${(ve.selectedNode ?? 0) + 1} (${node.type === "corner" ? "コーナー" : "スムーズ"})</span>
      <button id="ve-toggle-type" class="secondary">${node.type === "corner" ? "スムーズにする" : "コーナーにする"}</button>
    </div>` : `<p class="note">ノードを選択すると種別を変更できます。</p>`}
    <button id="ve-all-smooth" class="secondary">全ノードをスムーズに (角丸化)</button>
    <button id="ve-all-corner" class="secondary">全ノードをコーナーに</button>
    <h2>パーツ操作</h2>
    <button id="ve-delete-shape" class="secondary danger">この形状を削除</button>
    <h2>パーツの追加</h2>
    <div class="ve-tools">
      <button id="pen-fill">面を描く (フィル)</button>
      <button id="pen-line">線を描く (走り縫い)</button>
    </div>
    <p class="note">ベクター編集を一度適用してから描画できます。</p>
    <h2>確定</h2>
    <button id="ve-apply">編集を適用 (ステッチ再生成)</button>
    <button id="ve-cancel" class="secondary">破棄</button>
  `;
}

/** 全ノードを smooth/corner に (角丸化) */
export function vectorSetAllType(state: AppState, type: "corner" | "smooth"): void {
  const ve = state.vectorEdit;
  if (!ve) return;
  setActivePath(ve, setAllNodeTypes(activePath(ve), type));
}
