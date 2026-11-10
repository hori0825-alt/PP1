// 下敷き画像のストア。
//
// 画像データ (dataURL) は大きいので、作品データ (doc) には imageId だけを持たせ、
// 本体はここで管理する。ブラウザ内では IndexedDB に保存し (localStorage より容量が大きい)、
// 取り消し履歴や自動保存のたびに画像をコピーしないで済むようにする。
// 作品ファイル (.json) に書き出すときだけ、使っている画像を埋め込む。

import { uid } from "./model";

const DB_NAME = "pp1-sketch";
const STORE = "images";

const data = new Map<string, string>();
const bitmaps = new Map<string, HTMLImageElement>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** 保存されている画像をすべて読み込む (起動時に1回) */
export async function loadStoredImages(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const st = tx.objectStore(STORE);
      const req = st.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        if (typeof cur.value === "string" && !data.has(String(cur.key))) data.set(String(cur.key), cur.value);
        cur.continue();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function persist(id: string, url: string): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(url, id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** 画像を登録して id を返す。保存の成否は onSaved で知らせる */
export function putImage(url: string, id: string = uid("img"), onSaved?: (ok: boolean) => void): string {
  data.set(id, url);
  void persist(id, url).then((ok) => onSaved?.(ok));
  return id;
}

export function getImageData(id: string): string | undefined {
  return data.get(id);
}

/** 描画用の画像。まだ読み込み中なら null (読み込めたら onload を呼ぶ) */
export function getBitmap(id: string, onload: () => void): HTMLImageElement | null {
  let img = bitmaps.get(id);
  if (!img) {
    const url = data.get(id);
    if (!url) return null;
    img = new Image();
    img.onload = onload;
    img.src = url;
    bitmaps.set(id, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** 使っていない画像を消す (起動時、取り消し履歴が空のときだけ呼ぶ) */
export async function removeUnusedImages(keep: Set<string>): Promise<void> {
  const unused = [...data.keys()].filter((id) => !keep.has(id));
  if (unused.length === 0) return;
  for (const id of unused) {
    data.delete(id);
    bitmaps.delete(id);
  }
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    for (const id of unused) tx.objectStore(STORE).delete(id);
  } catch {
    /* noop */
  }
}

/**
 * 画像ファイルを読み込み、長辺 maxPx 以下に縮小した dataURL と縦横のピクセル数を返す。
 * 透明部分のある PNG は PNG のまま、それ以外は JPEG にして容量を抑える。
 */
export function readImageFile(file: File, maxPx = 2000): Promise<{ url: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(src);
      const k = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k));
      const h = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d")!;
      const png = /png|gif|webp/i.test(file.type);
      if (!png) {
        g.fillStyle = "#fff";
        g.fillRect(0, 0, w, h);
      }
      g.drawImage(img, 0, 0, w, h);
      resolve({ url: png ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.88), w, h });
    };
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error("この画像は読み込めませんでした"));
    };
    img.src = src;
  });
}
