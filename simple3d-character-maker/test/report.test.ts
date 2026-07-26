import { describe, expect, it } from 'vitest';
import { formatCheckReport, hasBlockingIssues } from '../src/inspect/report';
import type { CheckItem } from '../src/inspect/checks';

describe('formatCheckReport / hasBlockingIssues', () => {
  const results: CheckItem[] = [
    { id: 'a', label: 'A', severity: 'green', message: 'OK' },
    { id: 'b', label: 'B', severity: 'yellow', message: 'まあまあ' },
    { id: 'c', label: 'C', severity: 'red', message: 'だめ' },
  ];

  it('formats a readable report including severity counts', () => {
    const text = formatCheckReport(results);
    expect(text).toContain('[緑] A: OK');
    expect(text).toContain('[黄] B: まあまあ');
    expect(text).toContain('[赤] C: だめ');
    expect(text).toContain('赤: 1 件 / 黄: 1 件');
  });

  it('detects blocking (red) issues', () => {
    expect(hasBlockingIssues(results)).toBe(true);
    expect(hasBlockingIssues(results.filter((r) => r.severity !== 'red'))).toBe(false);
  });
});
