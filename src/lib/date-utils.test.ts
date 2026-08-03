import { describe, expect, it } from 'bun:test';
import {
  filterActivityOverlap,
  getSessionActivityBounds,
} from './date-utils';

describe('getSessionActivityBounds', () => {
  it('优先 last_active_at_iso，避免 time_updated 虚高', () => {
    const { firstMs, lastMs } = getSessionActivityBounds({
      first_active_at_iso: '2026-07-18T08:03:37.285Z',
      last_active_at_iso: '2026-07-18T08:05:30.198Z',
      time_created: Date.parse('2026-07-18T08:03:37.285Z'),
      // session 行被 title 等刷新到 07-26
      time_updated: Date.parse('2026-07-26T03:02:35.681Z'),
    });
    expect(new Date(firstMs).toISOString()).toBe('2026-07-18T08:03:37.285Z');
    expect(new Date(lastMs).toISOString()).toBe('2026-07-18T08:05:30.198Z');
  });

  it('无 active iso 时回落 time_*', () => {
    const { firstMs, lastMs } = getSessionActivityBounds({
      time_created: 1000,
      time_updated: 2000,
    });
    expect(firstMs).toBe(1000);
    expect(lastMs).toBe(2000);
  });
});

describe('filterActivityOverlap + bounds', () => {
  const range7d = { startDate: '2026-07-21', endDate: '2026-07-27' };

  it('仅 07-18 消息活动的 session 不落入 7d 窗口', () => {
    const bounds = getSessionActivityBounds({
      first_active_at_iso: '2026-07-18T08:03:37.285Z',
      last_active_at_iso: '2026-07-18T08:05:30.198Z',
      time_updated: Date.parse('2026-07-26T03:02:35.681Z'),
    });
    // 旧逻辑用 time_updated 会误判为 true
    expect(filterActivityOverlap(
      bounds.firstMs,
      Date.parse('2026-07-26T03:02:35.681Z'),
      range7d,
    )).toBe(true);
    // 新逻辑用 last_active
    expect(filterActivityOverlap(bounds.firstMs, bounds.lastMs, range7d)).toBe(false);
  });

  it('跨天真实活动仍可 overlap 入选', () => {
    const bounds = getSessionActivityBounds({
      first_active_at_iso: '2026-07-18T08:00:00.000Z',
      last_active_at_iso: '2026-07-26T12:00:00.000Z',
    });
    expect(filterActivityOverlap(bounds.firstMs, bounds.lastMs, range7d)).toBe(true);
  });
});
