/**
 * CLI stats 聚合（Agent 粗账）
 * P0: usage_by_day 窗口裁剪 · root/sub 拆分 · quality 角标  (#2)
 * P1: by_model · optional cost · costByDay · tool-fail top   (#3)
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
  usd: number;
  cny: number;
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

/** 分模型行（tokens desc） */
export interface ModelStatRow {
  modelKey: string;
  tokens: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  sessions: number;
  usd: number;
  cny: number;
}

export interface ToolFailTopSession {
  id: string;
  source: string;
  title: string | null;
  parent_id: string | null;
  tool_calls: number;
  tool_calls_failed: number;
  fail_rate: number | null;
}

export interface ToolFailSnapshot {
  tool_calls: number;
  tool_calls_failed: number;
  fail_rate: number | null;
  sessions_with_fails: number;
  top_sessions: ToolFailTopSession[];
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
  totals: Omit<StatsTokenBucket, 'sessions'> & {
    sessions: number;
    /** 是否从 payload 日表/pricing 扫到 >0 成本 */
    cost_available: boolean;
    cost_note: string | null;
  };
  bySource: Record<string, number>;
  bySourceDetail: Record<
    string,
    {
      sessions: number;
      tokens: number;
      user_messages: number;
      root_sessions: number;
      subagent_sessions: number;
      usd: number;
      cny: number;
    }
  >;
  /** P1: 按 modelKey 聚合（原始 key，不做 host 级归一化） */
  by_model: ModelStatRow[];
  tokensByDay: Record<string, number>;
  /** P1: 有日成本时填充；全 0 时仍给与 tokensByDay 对齐的 key（值为 0） */
  costByDay: Record<string, { usd: number; cny: number }>;
  /** P1: 跨 session tool fail 快照（cache 字段，非 live tool-errors） */
  tool_fail: ToolFailSnapshot;
}

export interface ComputeCliStatsOptions {
  startDate?: string;
  endDate?: string;
  /** tool_fail.top_sessions 条数，默认 10；0 = 不列 top */
  topFail?: number;
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
    usd: 0,
    cny: 0,
  };
}

/** session 成本：优先 usage_by_day 日合计，否则 pricing */
export function sessionCost(s: UnifiedSessionInfo): { usd: number; cny: number; from: 'day' | 'pricing' | 'none' } {
  const days = s.usage_by_day;
  if (days && days.length > 0) {
    let usd = 0;
    let cny = 0;
    let any = false;
    for (const d of days) {
      if ((d.usd || 0) > 0 || (d.cny || 0) > 0) any = true;
      usd += d.usd || 0;
      cny += d.cny || 0;
    }
    if (any || usd > 0 || cny > 0) return { usd, cny, from: 'day' };
  }
  const p = s.pricing;
  if (p && ((p.usd || 0) > 0 || (p.cny || 0) > 0)) {
    return { usd: p.usd || 0, cny: p.cny || 0, from: 'pricing' };
  }
  return { usd: 0, cny: 0, from: 'none' };
}

function addSessionToBucket(b: StatsTokenBucket, s: UnifiedSessionInfo, cost: { usd: number; cny: number }): void {
  b.sessions += 1;
  b.tokens += s.total_tokens || 0;
  b.input += s.total_input || 0;
  b.output += s.total_output || 0;
  b.cache_read += s.total_cache_read || 0;
  b.cache_write += s.total_cache_write || 0;
  b.user_messages += s.total_user_messages || 0;
  b.tool_calls += s.total_tool_calls || 0;
  b.tool_calls_failed += s.total_tool_calls_failed || 0;
  b.usd += cost.usd;
  b.cny += cost.cny;
}

function failRate(failed: number, total: number): number | null {
  if (!total || total <= 0) return null;
  return Number((failed / total).toFixed(4));
}

type ModelAcc = {
  modelKey: string;
  tokens: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  usd: number;
  cny: number;
  sessionIds: Set<string>;
};

function ensureModel(map: Map<string, ModelAcc>, modelKey: string): ModelAcc {
  let m = map.get(modelKey);
  if (!m) {
    m = {
      modelKey,
      tokens: 0,
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      usd: 0,
      cny: 0,
      sessionIds: new Set(),
    };
    map.set(modelKey, m);
  }
  return m;
}

function modelKeyOf(m: { modelKey?: string; provider?: string; model?: string }): string {
  if (m.modelKey) return m.modelKey;
  if (m.provider && m.model) return `${m.provider}/${m.model}`;
  if (m.model) return m.model;
  return 'unknown';
}

/** 从已裁剪 session 累加 by_model（日 byModel 优先，否则 usage_by_model） */
function accumulateModels(map: Map<string, ModelAcc>, s: UnifiedSessionInfo): void {
  const sid = s.id;
  let usedDayModels = false;
  for (const day of s.usage_by_day || []) {
    const models = day.byModel;
    if (!models || models.length === 0) continue;
    usedDayModels = true;
    for (const m of models) {
      const key = modelKeyOf(m);
      const acc = ensureModel(map, key);
      const input = m.input || 0;
      const output = m.output || 0;
      const cache_read = m.cacheRead || 0;
      const cache_write = m.cacheWrite || 0;
      const tokens = m.tokens || input + output + cache_read + cache_write;
      acc.tokens += tokens;
      acc.input += input;
      acc.output += output;
      acc.cache_read += cache_read;
      acc.cache_write += cache_write;
      acc.usd += m.usd || 0;
      acc.cny += m.cny || 0;
      acc.sessionIds.add(sid);
    }
  }
  if (usedDayModels) return;

  const um = s.usage_by_model;
  if (!um || um.length === 0) return;

  // 本 session 各 model 本轮新增 token（用于分摊 pricing）
  const contrib: Array<{ key: string; tokens: number }> = [];
  for (const m of um) {
    const key = modelKeyOf(m);
    const acc = ensureModel(map, key);
    const input = m.input || 0;
    const output = m.output || 0;
    const cache_read = m.cache_read ?? m.cacheRead ?? 0;
    const cache_write = m.cache_write ?? m.cacheWrite ?? 0;
    const tokens = m.tokens ?? input + output + cache_read + cache_write;
    acc.tokens += tokens;
    acc.input += input;
    acc.output += output;
    acc.cache_read += cache_read;
    acc.cache_write += cache_write;
    acc.sessionIds.add(sid);
    contrib.push({ key, tokens });
  }

  // 无日 byModel 成本时，按 token 占比分摊 session pricing
  const cost = sessionCost(s);
  const sumTok = contrib.reduce((a, c) => a + c.tokens, 0);
  if (sumTok > 0 && (cost.usd > 0 || cost.cny > 0)) {
    for (const c of contrib) {
      const share = c.tokens / sumTok;
      const acc = map.get(c.key)!;
      acc.usd += cost.usd * share;
      acc.cny += cost.cny * share;
    }
  }
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
  const { startDate, endDate, topFail = 10 } = options;
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
  const costByDay: Record<string, { usd: number; cny: number }> = {};
  const modelMap = new Map<string, ModelAcc>();
  const failCandidates: ToolFailTopSession[] = [];
  let sessions_with_fails = 0;
  let anyCost = false;

  for (const s of scoped) {
    const cost = sessionCost(s);
    if (cost.usd > 0 || cost.cny > 0) anyCost = true;

    const bucket = isRootSession(s) ? root : subagent;
    addSessionToBucket(bucket, s, cost);

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
        usd: 0,
        cny: 0,
      };
    }
    const d = bySourceDetail[src];
    d.sessions += 1;
    d.tokens += s.total_tokens || 0;
    d.user_messages += s.total_user_messages || 0;
    d.usd += cost.usd;
    d.cny += cost.cny;
    if (isRootSession(s)) d.root_sessions += 1;
    else d.subagent_sessions += 1;

    for (const day of s.usage_by_day || []) {
      if (!day?.date) continue;
      tokensByDay[day.date] = (tokensByDay[day.date] || 0) + (day.tokens || 0);
      if (!costByDay[day.date]) costByDay[day.date] = { usd: 0, cny: 0 };
      costByDay[day.date].usd += day.usd || 0;
      costByDay[day.date].cny += day.cny || 0;
    }

    accumulateModels(modelMap, s);

    const failed = s.total_tool_calls_failed || 0;
    const calls = s.total_tool_calls || 0;
    if (failed > 0) {
      sessions_with_fails += 1;
      failCandidates.push({
        id: s.id,
        source: src,
        title: s.title ?? null,
        parent_id: s.parent_id ?? null,
        tool_calls: calls,
        tool_calls_failed: failed,
        fail_rate: failRate(failed, calls),
      });
    }
  }

  const by_model: ModelStatRow[] = Array.from(modelMap.values())
    .map((m) => ({
      modelKey: m.modelKey,
      tokens: m.tokens,
      input: m.input,
      output: m.output,
      cache_read: m.cache_read,
      cache_write: m.cache_write,
      sessions: m.sessionIds.size,
      usd: Number(m.usd.toFixed(6)),
      cny: Number(m.cny.toFixed(6)),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const tool_calls = root.tool_calls + subagent.tool_calls;
  const tool_calls_failed = root.tool_calls_failed + subagent.tool_calls_failed;
  failCandidates.sort((a, b) => b.tool_calls_failed - a.tool_calls_failed);
  const tool_fail: ToolFailSnapshot = {
    tool_calls,
    tool_calls_failed,
    fail_rate: failRate(tool_calls_failed, tool_calls),
    sessions_with_fails,
    top_sessions: topFail > 0 ? failCandidates.slice(0, topFail) : [],
  };

  // 对齐 costByDay keys 与 tokensByDay（无成本日补 0）
  for (const day of Object.keys(tokensByDay)) {
    if (!costByDay[day]) costByDay[day] = { usd: 0, cny: 0 };
    else {
      costByDay[day] = {
        usd: Number(costByDay[day].usd.toFixed(6)),
        cny: Number(costByDay[day].cny.toFixed(6)),
      };
    }
  }

  const totalsUsd = root.usd + subagent.usd;
  const totalsCny = root.cny + subagent.cny;

  const totals: CliStatsResult['totals'] = {
    sessions: scoped.length,
    tokens: root.tokens + subagent.tokens,
    input: root.input + subagent.input,
    output: root.output + subagent.output,
    cache_read: root.cache_read + subagent.cache_read,
    cache_write: root.cache_write + subagent.cache_write,
    user_messages: root.user_messages + subagent.user_messages,
    tool_calls,
    tool_calls_failed,
    usd: Number(totalsUsd.toFixed(6)),
    cny: Number(totalsCny.toFixed(6)),
    cost_available: anyCost,
    cost_note: anyCost
      ? null
      : 'no day/pricing cost in payload (host fillSessionPricing / models.dev not in package)',
  };

  // round split costs
  root.usd = Number(root.usd.toFixed(6));
  root.cny = Number(root.cny.toFixed(6));
  subagent.usd = Number(subagent.usd.toFixed(6));
  subagent.cny = Number(subagent.cny.toFixed(6));

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
    by_model,
    tokensByDay,
    costByDay,
    tool_fail,
  };
}

export type { SourceId };
