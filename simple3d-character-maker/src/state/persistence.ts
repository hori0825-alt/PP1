import { migrateProjectData } from '../core/migrate';
import type { ProjectData } from '../core/params';

export function serializeProject(project: ProjectData): string {
  return JSON.stringify(project, null, 2);
}

/** JSON文字列から ProjectData を復元する。version が新しすぎる場合は例外を投げる（5.1節）。 */
export function deserializeProject(json: string): ProjectData {
  const raw = JSON.parse(json);
  return migrateProjectData(raw);
}

export function downloadProjectJson(project: ProjectData, fileName = 'project.json'): void {
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function readProjectFile(file: File): Promise<ProjectData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(deserializeProject(reader.result as string));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('ファイルの読み込みに失敗しました'));
    reader.readAsText(file);
  });
}
