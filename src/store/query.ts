/**
 * 缓存查询（M3）；API 接缓存在 M4
 */

import type { UnifiedSessionInfo, ListSessionsResult } from '../sources/types';
import type { SourceId, SessionPromptRow, UsageByModelEntry } from './schema';
import { ALL_SOURCES } from './schema';
import { getStoreDb } from './db';
import { loadMeta } from './meta';

export interface QueryCachedOptions {
  source?: SourceId | 'all';
  startDate?: string;
  endDate?: string;
  /** 默认排除 orphan */
  includeOrphan?: boolean;
  projectId?: string;
  models?: string[];
  limit?: number;
  offset?: number;
}

function dayStartMs(day: string): number {
  return new Date(`${day}T00:00:00`).getTime();
}

function dayEndMs(day: string): number {
  return new Date(`${day}T23:59:59.999`).getTime();
}

export function queryCached(options?: QueryCachedOptions): ListSessionsResult {
  const db = getStoreDb();
  const {
    source = 'all',
    startDate,
    endDate,
    includeOrphan = false,
    projectId,
    models,
    limit,
    offset,
  } = options || {};

  const where: string[] = [];
  const params: any[] = [];

  if (source !== 'all') {
    where.push('source = ?');
    params.push(source);
  }
  if (!includeOrphan) {
    where.push('orphaned_at IS NULL');
  }
  if (startDate) {
    where.push('(last_active_at IS NULL OR last_active_at >= ?)');
    params.push(dayStartMs(startDate));
  }
  if (endDate) {
    where.push('(time_created IS NULL OR time_created <= ?)');
    params.push(dayEndMs(endDate));
  }
  if (projectId) {
    where.push('project = ?');
    params.push(projectId);
  }

  let sql = `SELECT payload, source, session_id, orphaned_at FROM sessions`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` ORDER BY COALESCE(last_active_at, time_updated, 0) DESC`;
  if (limit != null) {
    sql += ` LIMIT ?`;
    params.push(limit);
    if (offset != null) {
      sql += ` OFFSET ?`;
      params.push(offset);
    }
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    payload: string;
    source: string;
    session_id: string;
    orphaned_at: number | null;
  }>;

  const targetModels = models && models.length ? new Set(models) : null;
  const sessions: UnifiedSessionInfo[] = [];
  const bySource: ListSessionsResult['bySource'] = {
    claude: 0,
    opencode: 0,
    kimi: 0,
    grok: 0,
    codex: 0,
    zcode: 0,
    workbuddy: 0,
  };

  for (const row of rows) {
    let s: UnifiedSessionInfo;
    try {
      s = JSON.parse(row.payload) as UnifiedSessionInfo;
    } catch {
      continue;
    }
    if (!s.source) s.source = row.source as any;
    if (!s.id) s.id = row.session_id;

    if (targetModels) {
      const used = (s.models_used || '').split(',').map((m) => m.trim()).filter(Boolean);
      if (!used.some((id) => targetModels.has(id))) continue;
    }

    // 精确活动重叠过滤（payload 内 first/last）
    if (startDate || endDate) {
      const first = s.first_active_at_iso
        ? Date.parse(s.first_active_at_iso)
        : s.time_created || 0;
      const last = s.last_active_at_iso
        ? Date.parse(s.last_active_at_iso)
        : s.time_updated || 0;
      if (startDate && last < dayStartMs(startDate)) continue;
      if (endDate && first > dayEndMs(endDate)) continue;
    }

    sessions.push(s);
    const src = s.source as keyof typeof bySource;
    if (src in bySource) bySource[src]++;
  }

  const meta = loadMeta();
  return {
    sessions,
    total: sessions.length,
    bySource,
    lastUpdatedAt: meta.last_sync_at ? new Date(meta.last_sync_at) : undefined,
  };
}

export function getCachedSession(
  source: SourceId,
  sessionId: string,
): UnifiedSessionInfo | null {
  const db = getStoreDb();
  const row = db
    .prepare(`SELECT payload FROM sessions WHERE source = ? AND session_id = ?`)
    .get(source, sessionId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as UnifiedSessionInfo;
  } catch {
    return null;
  }
}

export function getSessionPrompts(
  source: SourceId,
  sessionId: string,
): SessionPromptRow[] {
  const db = getStoreDb();
  return db
    .prepare(
      `SELECT idx, created_at, text FROM prompts
       WHERE source = ? AND session_id = ?
       ORDER BY idx ASC`,
    )
    .all(source, sessionId) as SessionPromptRow[];
}

export function queryUsageByDay(opts?: {
  source?: SourceId | 'all';
  startDay?: string;
  endDay?: string;
}): Array<{
  source: SourceId;
  session_id: string;
  day: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  tokens: number;
  usage_by_model: UsageByModelEntry[];
}> {
  const db = getStoreDb();
  const where: string[] = [];
  const params: any[] = [];
  if (opts?.source && opts.source !== 'all') {
    where.push('source = ?');
    params.push(opts.source);
  }
  if (opts?.startDay) {
    where.push('day >= ?');
    params.push(opts.startDay);
  }
  if (opts?.endDay) {
    where.push('day <= ?');
    params.push(opts.endDay);
  }
  let sql = `SELECT source, session_id, day, input_tokens, output_tokens,
    cache_read, cache_write, tokens, usage_by_model FROM usage_by_day`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` ORDER BY day ASC`;

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r) => ({
    source: r.source,
    session_id: r.session_id,
    day: r.day,
    input_tokens: r.input_tokens || 0,
    output_tokens: r.output_tokens || 0,
    cache_read: r.cache_read || 0,
    cache_write: r.cache_write || 0,
    tokens: r.tokens || 0,
    usage_by_model: safeJsonArray(r.usage_by_model),
  }));
}

function safeJsonArray(s: string | null): UsageByModelEntry[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function emptyBySource(): ListSessionsResult['bySource'] {
  const o = {} as ListSessionsResult['bySource'];
  for (const s of ALL_SOURCES) o[s] = 0;
  return o;
}
