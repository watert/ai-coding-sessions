import { describe, expect, it } from 'vitest';
import { buildScanMatcher, scanPreview, scanPromptRows, scanSessions } from './session-scan';
import type { UnifiedSessionInfo } from '../sources/types';

function mkSession(overrides: Partial<UnifiedSessionInfo> = {}): UnifiedSessionInfo {
  return {
    source: 'grok',
    id: 's-1',
    title: 'ROI 盘点',
    directory: '/tmp/proj',
    project_name: '/tmp/proj',
    models_used: 'grok-4.6',
    last_active_at_iso: '2026-08-29T13:46:25.000Z',
    ...overrides,
  } as UnifiedSessionInfo;
}

describe('session-scan (prompt-only)', () => {
  it('buildScanMatcher: substring 大小写不敏感 + regex', () => {
    const sub = buildScanMatcher('Kimi -P');
    expect(sub.test("run: kimi -p 'hi'")).toBe(true);
    expect(sub.index("run: kimi -p 'hi'")).toBe(5);
    expect(sub.test('nothing')).toBe(false);

    const re = buildScanMatcher('grok -m \\S+', true);
    expect(re.test('use grok -m grok-4.6 now')).toBe(true);
    expect(re.index('use grok -m grok-4.6 now')).toBe(4);
    expect(re.test('no match')).toBe(false);
  });

  it('scanPreview: 以命中为中心截断并带省略号', () => {
    const m = buildScanMatcher('needle');
    const long = `${'x'.repeat(300)} needle ${'y'.repeat(300)}`;
    const p = scanPreview(long, m, 50)!;
    expect(p.startsWith('…')).toBe(true);
    expect(p.endsWith('…')).toBe(true);
    expect(p).toContain('needle');

    // 命中在开头时不带前导省略号
    expect(scanPreview('needle at head', m, 50)).toBe('needle at head');
    expect(scanPreview('no hit here', m, 50)).toBeNull();
  });

  it('scanPromptRows: 逐行命中 + maxMatches 截断', () => {
    const m = buildScanMatcher('opencode run');
    const rows = [
      { idx: 0, text: '先 opencode run --model x 看看' },
      { idx: 1, text: '今天天气不错' },
      { idx: 2, text: '再 opencode run 一次' },
      { idx: 3, text: '第三次 opencode run' },
    ];
    const hits = scanPromptRows(rows, m, 200, 2);
    expect(hits.map((h) => h.idx)).toEqual([0, 2]);
  });

  it('scanSessions: 汇总命中 session, 未命中的不出现', () => {
    const s1 = mkSession({ id: 's-1' });
    const s2 = mkSession({ id: 's-2', title: '无关 session' });

    const result = scanSessions(
      [s1, s2],
      { pattern: 'opencode run', maxChars: 200, maxMatches: 20 },
      {
        getPrompts: (s) =>
          s.id === 's-1'
            ? [{ idx: 0, text: '先 opencode run --model x 看看' }]
            : [{ idx: 0, text: '今天天气不错' }],
      },
    );

    expect(result.scanned).toBe(2);
    expect(result.matched).toBe(1);
    expect(result.matches[0]).toMatchObject({ id: 's-1', match_count: 1 });
    expect(result.notes.join('\n')).toContain('tool-calls');
  });
});
