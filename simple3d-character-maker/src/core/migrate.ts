import { CURRENT_PROJECT_VERSION, type ProjectData } from './params';
import { createDefaultCowParams } from '../presets/cow';

export class ProjectVersionError extends Error {}

type MigrationStep = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * version をキーに、「そのバージョン→次のバージョン」への変換関数を登録するチェーン。
 */
const migrations: Record<number, MigrationStep> = {
  // v1 (ナス専用 Phase 1 MVP) -> v2 (牛 Phase 2 追加): characterType と cow を追加する。
  1: (data) => ({
    ...data,
    version: 2,
    characterType: 'eggplant',
    cow: createDefaultCowParams(),
  }),
};

/**
 * 読み込んだ JSON を最新の ProjectData 形式へ引き上げる。
 * version が現在値より大きい場合は読み込みを拒否する。
 */
export function migrateProjectData(raw: unknown): ProjectData {
  if (typeof raw !== 'object' || raw === null) {
    throw new ProjectVersionError('プロジェクトファイルの形式が不正です。');
  }
  let data = raw as Record<string, unknown>;
  const version = typeof data.version === 'number' ? data.version : 0;

  if (version > CURRENT_PROJECT_VERSION) {
    throw new ProjectVersionError(
      `このプロジェクトファイルは新しいバージョン（v${version}）で保存されています。` +
        `お使いのアプリ（v${CURRENT_PROJECT_VERSION}）では読み込めません。アプリを更新してください。`,
    );
  }

  let current = version;
  while (current < CURRENT_PROJECT_VERSION) {
    const step = migrations[current];
    if (!step) {
      throw new ProjectVersionError(
        `バージョン v${current} から v${CURRENT_PROJECT_VERSION} への変換手順が見つかりません。`,
      );
    }
    data = step(data);
    current = typeof data.version === 'number' ? data.version : current + 1;
  }

  return data as unknown as ProjectData;
}
