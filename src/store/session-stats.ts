/**
 * CLI stats 聚合（Agent 粗账）
 * P0: usage_by_day 窗口裁剪 · root/sub 拆分 · quality 角标
 * @see https://github.com/watert/ai-coding-sessions/issues/2
 */

import dayjs from 'dayjs';
import type { UnifiedSessionInfo } from '../sources/types';
import type { SourceId } from './schema';
import { ALL_SOURCES } from './schema';

export interface StatsTokenBucket {
  sessions: number;
  tokens: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  user_messages: number;
  tool_calls: number;
  tool_calls_failed: number;
}

export interface StatsQuality {
  /** usage_is_incomplete */
  incomplete: number;
  /** cost_is_partial */
  partial: number;
  /** usage_source === 'estimate' */
  estimated: number;
  /** Σ cost_missing_calls */
  cost_missing_calls_total: number;
  /** 窗口内被裁剪 token 的 session 数（有 usage_by_day 且日集合 ≠ 全量） */
  sessions_clipped: number;
  /** 无 usage_by_day、只能用 total_* 的 session 数 */
  sessions_unclipped: number;
}

export interface CliStatsResult {
  sessions: number;
  clipped: boolean;
  window: { start: string | null; end: string | null };
  split: {
    root: StatsTokenBucket;
    subagent: StatsTokenBucket;
  };
  quality: StatsQuality;
  totals: Omit<StatsTokenBucket, 'sessions'> & { sessions: number };
  bySource: Record<string, number>;
  bySourceDetail: Record<
    string,
    {
      sessions: number;
      tokens: number;
      user_messages: number;
      root_sessions: number;
      subagent_sessions: number;
    }
  >;
  tokensByDay: Record<string, number>;
}

export interface ComputeCliStatsOptions {
  startDate?: string;
  endDate?: string;
}

function emptyBucket(): StatsTokenBucket {
  return {
    sessions: 0,
    tokens: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    user_messages: 0,
    tool_calls: 0,
    tool_calls_failed: 0,
  };
}

function addSessionToBucket(b: StatsTokenBucket, s: UnifiedSessionInfo): void {
  b.sessions += 1;
  b.tokens += s.total_tokens || 0;
  b.input += s.total_input || 0;
  b.output += s.total_output || 0;
  b.cache_read += s.total_cache_read || 0;
  b.cache_write += s.total_cache_write || 0;
  b.user_messages += s.total_user_messages || 0;
  b.tool_calls += s.total_tool_calls || 0;
  b.tool_calls_failed += s.total_tool_calls_failed || 0;
}

/** 查询边界 → YYYY-MM-DD */
export function toDayKey(v?: string | null): string | undefined {
  if (v == null || v === '') return undefined;
  if (/^\d+$/.test(v)) return dayjs(Number(v)).format('YYYY-MM-DD');
  return dayjs(v).format('YYYY-MM-DD');
}

function isDayInRange(date: string, start?: string, end?: string): boolean {
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

export function isRootSession(s: Pick<UnifiedSessionInfo, 'parent_id'>): boolean {
  const p = s.parent_id;
  return p == null || p === '';
}

/**
 * 按窗口裁剪单 session 的 token 字段（messages/tool 计数不变）。
 * - 有 usage_by_day：只计窗口内日
 * - 无 usage_by_day：原样返回
 */
export function clipSessionToDateRange(
  session: UnifiedSessionInfo,
  startDate?: string,
  endDate?: string,
): { session: UnifiedSessionInfo; clipped: boolean; unclipped: boolean } {
  const start = toDayKey(startDate);
  const end = toDayKey(endDate);
  const rows = session.usage_by_day;

  if ((!start && !end) || !rows || rows.length === 0) {
    return {
      session,
      clipped: false,
      unclipped: !rows || rows.length === 0,
    };
  }

  const inRange = rows.filter((d) => isDayInRange(d.date, start, end));
  if (inRange.length === rows.length) {
    return { session, clipped: false, unclipped: false };
  }

  if (inRange.length === 0) {
    return {
      session: {
        ...session,
        total_tokens: 0,
        total_input: 0,
        total_output: 0,
        total_cache_read: 0,
        total_cache_write: 0,
        usage_by_day: [],
      },
      clipped: true,
      unclipped: false,
    };
  }

  const total_input = inRange.reduce((a, d) => a + (d.input || 0), 0);
  const total_output = inRange.reduce((a, d) => a + (d.output || 0), 0);
  const total_cache_read = inRange.reduce((a, d) => a + (d.cacheRead || 0), 0);
  const total_cache_write = inRange.reduce((a, d) => a + (d.cacheWrite || 0), 0);
  const dayTok = inRange.reduce((a, d) => a + (d.tokens || 0), 0);
  const total_tokens =
    dayTok > 0
      ? dayTok
      : total_input + total_output + total_cache_read + total_cache_write;

  return {
    session: {
      ...session,
      total_tokens,
      total_input,
      total_output,
      total_cache_read,
      total_cache_write,
      usage_by_day: inRange,
    },
    clipped: true,
    unclipped: false,
  };
}

export function clipSessionsToDateRange(
  sessions: UnifiedSessionInfo[],
  startDate?: string,
  endDate?: string,
): {
  sessions: UnifiedSessionInfo[];
  sessions_clipped: number;
  sessions_unclipped: number;
  anyClip: boolean;
} {
  let sessions_clipped = 0;
  let sessions_unclipped = 0;
  let anyClip = false;
  const out = sessions.map((s) => {
    const r = clipSessionToDateRange(s, startDate, endDate);
    if (r.clipped) {
      sessions_clipped += 1;
      anyClip = true;
    }
    if (r.unclipped && (startDate || endDate)) sessions_unclipped += 1;
    return r.session;
  });
  return { sessions: out, sessions_clipped, sessions_unclipped, anyClip };
}

/** 从（已裁剪）sessions 聚合成 CLI stats */
export function computeCliStats(
  sessions: UnifiedSessionInfo[],
  options: ComputeCliStatsOptions = {},
): CliStatsResult {
  const { startDate, endDate } = options;
  const {
    sessions: scoped,
    sessions_clipped,
    sessions_unclipped,
    anyClip,
  } = clipSessionsToDateRange(sessions, startDate, endDate);

  const root = emptyBucket();
  const subagent = emptyBucket();
  const quality: StatsQuality = {
    incomplete: 0,
    partial: 0,
    estimated: 0,
    cost_missing_calls_total: 0,
    sessions_clipped,
    sessions_unclipped,
  };

  const bySource: Record<string, number> = {};
  for (const id of ALL_SOURCES) bySource[id] = 0;

  const bySourceDetail: CliStatsResult['bySourceDetail'] = {};
  const tokensByDay: Record<string, number> = {};

  for (const s of scoped) {
    const bucket = isRootSession(s) ? root : subagent;
    addSessionToBucket(bucket, s);

    if (s.usage_is_incomplete) quality.incomplete += 1;
    if (s.cost_is_partial) quality.partial += 1;
    if (s.usage_source === 'estimate') quality.estimated += 1;
    if (s.cost_missing_calls) quality.cost_missing_calls_total += s.cost_missing_calls;

    const src = (s.source || 'unknown') as string;
    bySource[src] = (bySource[src] || 0) + 1;
    if (!bySourceDetail[src]) {
      bySourceDetail[src] = {
        sessions: 0,
        tokens: 0,
        user_messages: 0,
        root_sessions: 0,
        subagent_sessions: 0,
      };
    }
    const d = bySourceDetail[src];
    d.sessions += 1;
    d.tokens += s.total_tokens || 0;
    d.user_messages += s.total_user_messages || 0;
    if (isRootSession(s)) d.root_sessions += 1;
    else d.subagent_sessions += 1;

    for (const day of s.usage_by_day || []) {
      if (!day?.date) continue;
      tokensByDay[day.date] = (tokensByDay[day.date] || 0) + (day.tokens || 0);
    }
  }

  const totals: CliStatsResult['totals'] = {
    sessions: scoped.length,
    tokens: root.tokens + subagent.tokens,
    input: root.input + subagent.input,
    output: root.output + subagent.output,
    cache_read: root.cache_read + subagent.cache_read,
    cache_write: root.cache_write + subagent.cache_write,
    user_messages: root.user_messages + subagent.user_messages,
    tool_calls: root.tool_calls + subagent.tool_calls,
    tool_calls_failed: root.tool_calls_failed + subagent.tool_calls_failed,
  };

  return {
    sessions: scoped.length,
    clipped: anyClip,
    window: {
      start: toDayKey(startDate) ?? null,
      end: toDayKey(endDate) ?? null,
    },
    split: { root, subagent },
    quality,
    totals,
    bySource,
    bySourceDetail,
    tokensByDay,
  };
}

export type { SourceId };
