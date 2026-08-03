import { describe, expect, test } from 'bun:test';
import type { UnifiedSessionInfo } from '../sources/types';
import {
  clipSessionToDateRange,
  computeCliStats,
  isRootSession,
  toDayKey,
} from './session-stats';

function base(partial: Partial<UnifiedSessionInfo> & { id: string }): UnifiedSessionInfo {
  return {
    id: partial.id,
    project_id: 'p',
    slug: partial.id,
    directory: '/t',
    title: partial.title || partial.id,
    version: '1',
    time_created: 1,
    time_updated: 2,
    source: partial.source || 'kimi',
    total_tokens: partial.total_tokens ?? 0,
    total_input: partial.total_input ?? 0,
    total_output: partial.total_output ?? 0,
    total_cache_read: partial.total_cache_read ?? 0,
    total_cache_write: partial.total_cache_write ?? 0,
    total_messages: partial.total_messages ?? 0,
    total_user_messages: partial.total_user_messages ?? 0,
    total_tool_calls: partial.total_tool_calls ?? 0,
    total_tool_calls_failed: partial.total_tool_calls_failed ?? 0,
    models_used: '',
    last_active_at_iso: '2026-08-03T00:00:00.000Z',
    first_active_at_iso: '2026-08-01T00:00:00.000Z',
    parent_id: partial.parent_id,
    usage_by_day: partial.usage_by_day,
    usage_is_incomplete: partial.usage_is_incomplete,
    cost_is_partial: partial.cost_is_partial,
    usage_source: partial.usage_source,
    cost_missing_calls: partial.cost_missing_calls,
  } as UnifiedSessionInfo;
}

describe('toDayKey / isRootSession', () => {
  test('toDayKey date and ms', () => {
    expect(toDayKey('2026-08-01')).toBe('2026-08-01');
    expect(toDayKey('1785750000000')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(toDayKey(undefined)).toBeUndefined();
  });

  test('isRootSession', () => {
    expect(isRootSession({ parent_id: null })).toBe(true);
    expect(isRootSession({ parent_id: undefined })).toBe(true);
    expect(isRootSession({ parent_id: '' })).toBe(true);
    expect(isRootSession({ parent_id: 'p1' })).toBe(false);
  });
});

describe('clipSessionToDateRange', () => {
  const multi = base({
    id: 'm1',
    total_tokens: 300,
    total_input: 150,
    total_output: 150,
    usage_by_day: [
      { date: '2026-08-01', tokens: 100, input: 50, output: 50, cacheRead: 0, cacheWrite: 0, usd: 0, cny: 0 },
      { date: '2026-08-02', tokens: 100, input: 50, output: 50, cacheRead: 0, cacheWrite: 0, usd: 0, cny: 0 },
      { date: '2026-08-03', tokens: 100, input: 50, output: 50, cacheRead: 0, cacheWrite: 0, usd: 0, cny: 0 },
    ],
  });

  test('窗口内只计部分日', () => {
    const { session, clipped } = clipSessionToDateRange(multi, '2026-08-02', '2026-08-02');
    expect(clipped).toBe(true);
    expect(session.total_tokens).toBe(100);
    expect(session.total_input).toBe(50);
    expect(session.usage_by_day).toHaveLength(1);
    expect(session.usage_by_day![0].date).toBe('2026-08-02');
  });

  test('窗口覆盖全部 → 不裁剪', () => {
    const { session, clipped } = clipSessionToDateRange(multi, '2026-08-01', '2026-08-03');
    expect(clipped).toBe(false);
    expect(session.total_tokens).toBe(300);
  });

  test('窗口无交集 → tokens 清零', () => {
    const { session, clipped } = clipSessionToDateRange(multi, '2026-07-01', '2026-07-31');
    expect(clipped).toBe(true);
    expect(session.total_tokens).toBe(0);
    expect(session.usage_by_day).toEqual([]);
  });

  test('无 usage_by_day → 保留 total_*', () => {
    const s = base({ id: 'n', total_tokens: 999, usage_by_day: undefined });
    const { session, unclipped } = clipSessionToDateRange(s, '2026-08-01', '2026-08-03');
    expect(unclipped).toBe(true);
    expect(session.total_tokens).toBe(999);
  });
});

describe('computeCliStats P0', () => {
  const root = base({
    id: 'r1',
    source: 'kimi',
    parent_id: null,
    total_tokens: 300,
    total_input: 150,
    total_output: 150,
    total_user_messages: 2,
    total_tool_calls: 10,
    total_tool_calls_failed: 1,
    usage_is_incomplete: true,
    usage_by_day: [
      { date: '2026-08-01', tokens: 100, input: 50, output: 50, cacheRead: 0, cacheWrite: 0, usd: 0, cny: 0 },
      { date: '2026-08-03', tokens: 200, input: 100, output: 100, cacheRead: 0, cacheWrite: 0, usd: 0, cny: 0 },
    ],
  });
  const sub = base({
    id: 'c1',
    source: 'kimi',
    parent_id: 'r1',
    total_tokens: 50,
    total_input: 30,
    total_output: 20,
    total_user_messages: 1,
    total_tool_calls: 5,
    cost_is_partial: true,
    usage_source: 'estimate',
    cost_missing_calls: 2,
    usage_by_day: [
      { date: '2026-08-03', tokens: 50, input: 30, output: 20, cacheRead: 0, cacheWrite: 0, usd: 0, cny: 0 },
    ],
  });
  const grok = base({
    id: 'g1',
    source: 'grok',
    total_tokens: 1000,
    total_input: 500,
    total_output: 500,
    // 无 usage_by_day → unclipped
  });

  test('clip + root/sub + quality', () => {
    const stats = computeCliStats([root, sub, grok], {
      startDate: '2026-08-03',
      endDate: '2026-08-03',
    });

    expect(stats.sessions).toBe(3);
    expect(stats.clipped).toBe(true);
    expect(stats.window).toEqual({ start: '2026-08-03', end: '2026-08-03' });

    // root: only day 08-03 = 200; sub: 50; grok unclipped 1000
    expect(stats.split.root.sessions).toBe(2); // root + grok
    expect(stats.split.subagent.sessions).toBe(1);
    expect(stats.split.root.tokens).toBe(200 + 1000);
    expect(stats.split.subagent.tokens).toBe(50);
    expect(stats.totals.tokens).toBe(1250);

    expect(stats.quality.incomplete).toBe(1);
    expect(stats.quality.partial).toBe(1);
    expect(stats.quality.estimated).toBe(1);
    expect(stats.quality.cost_missing_calls_total).toBe(2);
    expect(stats.quality.sessions_clipped).toBe(1); // only root multi-day clipped
    expect(stats.quality.sessions_unclipped).toBe(1); // grok

    expect(stats.tokensByDay['2026-08-03']).toBe(200 + 50);
    expect(stats.tokensByDay['2026-08-01']).toBeUndefined();

    expect(stats.bySourceDetail.kimi.root_sessions).toBe(1);
    expect(stats.bySourceDetail.kimi.subagent_sessions).toBe(1);
    expect(stats.bySourceDetail.kimi.tokens).toBe(250);
  });

  test('无窗口不裁剪', () => {
    const stats = computeCliStats([root, sub]);
    expect(stats.clipped).toBe(false);
    expect(stats.totals.tokens).toBe(350);
    expect(stats.tokensByDay['2026-08-01']).toBe(100);
  });
});
