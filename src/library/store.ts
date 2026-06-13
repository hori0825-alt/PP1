// デザインライブラリのストア (DOM 非依存)。
// 永続化は KeyValueStore 抽象に委ね、ブラウザでは localStorage を注入する。
// 検索・フィルター・お気に入り・最近使った・タグ管理を提供する。

export interface LibraryEntry {
  id: string;
  name: string;
  /** プレビュー画像 (dataURL or SVG 文字列)。省略可 */
  thumbnail?: string;
  sizeMm: { w: number; h: number };
  colorCount: number;
  stitchCount: number;
  createdAt: string;
  updatedAt: string;
  /** 使用糸の表示名 */
  threads: string[];
  tags: string[];
  favorite: boolean;
  note: string;
  /** 紐づくプロジェクト JSON (再編集用) */
  projectJson: string;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** テスト用のインメモリストア */
export class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const STORAGE_KEY = "pp1.library.v1";
const RECENT_KEY = "pp1.library.recent.v1";
const RECENT_LIMIT = 12;

export interface LibraryFilter {
  /** 名前・タグ・メモの部分一致 */
  query?: string;
  /** タグ完全一致 (複数指定で AND) */
  tags?: string[];
  favoriteOnly?: boolean;
}

export class DesignLibrary {
  constructor(private store: KeyValueStore) {}

  private readAll(): LibraryEntry[] {
    const raw = this.store.get(STORAGE_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as LibraryEntry[];
    } catch {
      return [];
    }
  }

  private writeAll(entries: LibraryEntry[]): void {
    this.store.set(STORAGE_KEY, JSON.stringify(entries));
  }

  /** 追加または更新 (id 一致で置換) */
  save(entry: LibraryEntry): void {
    const all = this.readAll();
    const idx = all.findIndex((e) => e.id === entry.id);
    const next = { ...entry, updatedAt: new Date().toISOString() };
    if (idx >= 0) all[idx] = next;
    else all.push(next);
    this.writeAll(all);
  }

  get(id: string): LibraryEntry | null {
    return this.readAll().find((e) => e.id === id) ?? null;
  }

  remove(id: string): void {
    this.writeAll(this.readAll().filter((e) => e.id !== id));
  }

  toggleFavorite(id: string): void {
    const all = this.readAll();
    const e = all.find((x) => x.id === id);
    if (e) {
      e.favorite = !e.favorite;
      this.writeAll(all);
    }
  }

  /** 検索・フィルター (更新日の新しい順) */
  list(filter: LibraryFilter = {}): LibraryEntry[] {
    let entries = this.readAll();
    if (filter.favoriteOnly) entries = entries.filter((e) => e.favorite);
    if (filter.tags && filter.tags.length > 0) {
      entries = entries.filter((e) => (filter.tags as string[]).every((t) => e.tags.includes(t)));
    }
    if (filter.query) {
      const q = filter.query.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.note.toLowerCase().includes(q) ||
          e.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 全タグの一覧 (重複なし) */
  allTags(): string[] {
    const set = new Set<string>();
    for (const e of this.readAll()) for (const t of e.tags) set.add(t);
    return [...set].sort();
  }

  /** 最近使った id を記録 */
  markRecent(id: string): void {
    const raw = this.store.get(RECENT_KEY);
    let ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    ids = [id, ...ids.filter((x) => x !== id)].slice(0, RECENT_LIMIT);
    this.store.set(RECENT_KEY, JSON.stringify(ids));
  }

  recent(): LibraryEntry[] {
    const raw = this.store.get(RECENT_KEY);
    if (!raw) return [];
    const ids = JSON.parse(raw) as string[];
    const all = this.readAll();
    return ids.map((id) => all.find((e) => e.id === id)).filter((e): e is LibraryEntry => !!e);
  }
}
