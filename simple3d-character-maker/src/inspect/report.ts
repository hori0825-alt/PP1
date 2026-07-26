import type { CheckItem, Severity } from './checks';

const SEVERITY_LABEL: Record<Severity, string> = {
  red: '[赤]',
  yellow: '[黄]',
  green: '[緑]',
};

/** print_check.txt 用に検査結果を整形する（6.7節）。 */
export function formatCheckReport(results: CheckItem[]): string {
  const lines = ['Simple3D Character Maker - 印刷前チェック結果', ''];
  for (const r of results) {
    lines.push(`${SEVERITY_LABEL[r.severity]} ${r.label}: ${r.message}`);
  }
  const redCount = results.filter((r) => r.severity === 'red').length;
  const yellowCount = results.filter((r) => r.severity === 'yellow').length;
  lines.push('');
  lines.push(`赤: ${redCount} 件 / 黄: ${yellowCount} 件`);
  return lines.join('\n');
}

export function hasBlockingIssues(results: CheckItem[]): boolean {
  return results.some((r) => r.severity === 'red');
}
