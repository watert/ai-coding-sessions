/**
 * 同步引擎（M3）
 *
 * 策略：
 * 1. listRefs 便宜脏标记（记录 + 可选跳过提示）
 * 2. listSessions 全量 convert（含 subagent 展开；保证与现网对账）
 * 3. content_fingerprint 比对后 upsert（prompts + usage_by_day）
 * 4. full 时 mark orphan；meta JSON 写 last_sync_at
 *
 * 说明：真正「仅 convert 脏 session」依赖各源单条 convert API 完备；
 * M3 以对账正确优先，脏标记用于 skip 写库与 meta 统计。
 */

import dayjs from 'dayjs';
import {
  initAiCodingStats,
  listSessions,
  closeAiCodingStats,
} from '../sources/index';
import type { UnifiedSessionInfo } from '../sources/types';
import type { SourceId } from './schema';
import { ALL_SOURCES, isSourceId } from './schema';
import { initStoreDb, closeStoreDb } from './db';
import { loadMeta, saveMeta, type StoreMeta, type SourceSyncMeta } from './meta';
import { listRefs } from './list-refs';
import {
  upsertSession,
  markOrphans,
  countStats,
} from './upsert';
import { queryCached } from './query';

export interface SyncOptions {
  /** 回溯天数，默认 7；与 startDate 二选一，startDate 优先 */
  days?: number;
  startDate?: string;
  endDate?: string;
  source?: SourceId | 'all';
  /** 全量：不按 dirty 跳过写库提示 + 扫描 orphan */
  full?: boolean;
  dbPath?: string;
  metaPath?: string;
  /** 同步后关闭源 DB（CLI 用） */
  closeAfter?: boolean;
}

export interface SyncSourceResult {
  source: SourceId;
  refs: number;
  live: number;
  inserted: number;
  updated: number;
  skipped: number;
  orphaned: number;
  duration_ms: number;
  error?: string;
}

export interface SyncResult {
  ok: boolean;
  paths: { dbPath: string; metaPath: string };
  bySource: SyncSourceResult[];
  totals: {
    live: number;
    inserted: number;
    updated: number;
    skipped: number;
    orphaned: number;
  };
  stats: ReturnType<typeof countStats>;
  meta: StoreMeta;
  duration_ms: number;
}

function resolveStartDate(opts: SyncOptions): string | undefined {
  if (opts.startDate) return opts.startDate;
  const days = opts.days ?? 7;
  return dayjs().subtract(days, 'day').format('YYYY-MM-DD');
}

function normalizeSources(source?: SourceId | 'all'): SourceId[] {
  if (!source || source === 'all') return [...ALL_SOURCES];
  if (!isSourceId(source)) throw new Error(`unknown source: ${source}`);
  return [source];
}

export async function syncSessions(options: SyncOptions = {}): Promise<SyncResult> {
  const t0 = Date.now();
  const paths = await initStoreDb({
    dbPath: options.dbPath,
    metaPath: options.metaPath,
  });
  await initAiCodingStats();

  const sources = normalizeSources(options.source);
  const startDate = options.full ? undefined : resolveStartDate(options);
  const endDate = options.endDate;
  const full = !!options.full;
  const meta = loadMeta(paths.metaPath);
  const bySource: SyncSourceResult[] = [];

  try {
    for (const source of sources) {
      const r = await syncOneSource(source, { startDate, endDate, full });
      bySource.push(r);
      const sm: SourceSyncMeta = {
        last_sync_at: Date.now(),
        last_full_sync_at: full ? Date.now() : meta.sources[source]?.last_full_sync_at ?? null,
        session_count: r.live,
        upserted: r.inserted + r.updated,
        skipped: r.skipped,
        orphaned: r.orphaned,
        error: r.error || null,
        duration_ms: r.duration_ms,
      };
      meta.sources[source] = sm;
    }

    const now = Date.now();
    meta.last_sync_at = now;
    if (full) meta.last_full_sync_at = now;
    meta.stats = countStats();
    meta.schema_version = 1;
    saveMeta(meta, paths.metaPath);

    const totals = bySource.reduce(
      (a, s) => ({
        live: a.live + s.live,
        inserted: a.inserted + s.inserted,
        updated: a.updated + s.updated,
        skipped: a.skipped + s.skipped,
        orphaned: a.orphaned + s.orphaned,
      }),
      { live: 0, inserted: 0, updated: 0, skipped: 0, orphaned: 0 },
    );

    return {
      ok: bySource.every((s) => !s.error),
      paths,
      bySource,
      totals,
      stats: meta.stats!,
      meta,
      duration_ms: Date.now() - t0,
    };
  } finally {
    if (options.closeAfter) {
      closeAiCodingStats();
      closeStoreDb();
    }
  }
}

async function syncOneSource(
  source: SourceId,
  opts: { startDate?: string; endDate?: string; full: boolean },
): Promise<SyncSourceResult> {
  const t0 = Date.now();
  const result: SyncSourceResult = {
    source,
    refs: 0,
    live: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    orphaned: 0,
    duration_ms: 0,
  };

  try {
    const since = opts.startDate ? dayjs(opts.startDate).startOf('day').valueOf() : undefined;
    const refs = await listRefs({ source, since: opts.full ? undefined : since });
    result.refs = refs.length;
    const dirtyById = new Map(refs.map((r) => [r.session_id, r.dirty_mark]));

    const live = await listSessions({
      source,
      startDate: opts.full ? undefined : opts.startDate,
      endDate: opts.endDate,
    });
    result.live = live.sessions.length;

    const liveIds = new Set<string>();
    for (const s of live.sessions) {
      liveIds.add(s.id);
      // dirty_mark：优先 listRefs；虚拟 subagent 用 parent 或 time_updated
      const dirty =
        dirtyById.get(s.id) ??
        (s.parent_id ? dirtyById.get(s.parent_id) : undefined) ??
        String(s.time_updated || 0);

      // convert 已完成；写库由 content_fingerprint 决定 skip/update
      const ur = upsertSession(s, {
        dirty_mark: dirty,
        force: opts.full,
      });
      if (ur.action === 'insert') result.inserted++;
      else if (ur.action === 'update') result.updated++;
      else result.skipped++;
    }

    // full：对整源扫 orphan；增量：仅 un-orphan 已见（upsert 已清），不新增 orphan
    if (opts.full) {
      result.orphaned = markOrphans(source, liveIds);
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.warn(`[sync] ${source} failed:`, e);
  }

  result.duration_ms = Date.now() - t0;
  return result;
}

/**
 * 对账：缓存 vs live listSessions（同窗口）
 */
export async function reconcileSessions(options: SyncOptions = {}): Promise<{
  ok: boolean;
  summary: string;
  live: { total: number; bySource: Record<string, number>; tokens: number };
  cached: { total: number; bySource: Record<string, number>; tokens: number };
  diffs: string[];
}> {
  const paths = await initStoreDb({
    dbPath: options.dbPath,
    metaPath: options.metaPath,
  });
  await initAiCodingStats();

  const startDate = options.full ? undefined : resolveStartDate(options);
  const source = options.source || 'all';

  try {
    const live = await listSessions({
      source: source as any,
      startDate,
      endDate: options.endDate,
    });
    const cached = queryCached({
      source: source as any,
      startDate,
      endDate: options.endDate,
      includeOrphan: false,
    });

    const liveTokens = sumTokens(live.sessions);
    const cachedTokens = sumTokens(cached.sessions);
    const diffs: string[] = [];

    if (live.total !== cached.total) {
      diffs.push(`session count: live=${live.total} cached=${cached.total}`);
    }
    for (const s of ALL_SOURCES) {
      if (source !== 'all' && source !== s) continue;
      const lv = live.bySource[s] || 0;
      const cv = cached.bySource[s] || 0;
      if (lv !== cv) diffs.push(`${s}: live=${lv} cached=${cv}`);
    }
    // token 允许小幅差（orphan / 窗口边界）
    if (Math.abs(liveTokens - cachedTokens) > 1) {
      diffs.push(`tokens: live=${liveTokens} cached=${cachedTokens}`);
    }

    // id 差集（最多报 10）
    const liveIds = new Set(live.sessions.map((x) => `${x.source}:${x.id}`));
    const cachedIds = new Set(cached.sessions.map((x) => `${x.source}:${x.id}`));
    const onlyLive = [...liveIds].filter((id) => !cachedIds.has(id)).slice(0, 10);
    const onlyCached = [...cachedIds].filter((id) => !liveIds.has(id)).slice(0, 10);
    if (onlyLive.length) diffs.push(`only live (≤10): ${onlyLive.join(', ')}`);
    if (onlyCached.length) diffs.push(`only cached (≤10): ${onlyCached.join(', ')}`);

    const ok = diffs.length === 0;
    const summary = ok
      ? `OK sessions=${live.total} tokens=${liveTokens}`
      : `DIFF ${diffs.length}: ${diffs.join(' | ')}`;

    const meta = loadMeta(paths.metaPath);
    meta.last_reconcile = { at: Date.now(), ok, summary };
    saveMeta(meta, paths.metaPath);

    return {
      ok,
      summary,
      live: { total: live.total, bySource: live.bySource, tokens: liveTokens },
      cached: { total: cached.total, bySource: cached.bySource, tokens: cachedTokens },
      diffs,
    };
  } finally {
    if (options.closeAfter) {
      closeAiCodingStats();
      closeStoreDb();
    }
  }
}

function sumTokens(sessions: UnifiedSessionInfo[]): number {
  return sessions.reduce((a, s) => a + (s.total_tokens || 0), 0);
}

/** ensureFresh：meta.last_sync_at 门槛（长 TTL） */
export async function ensureFresh(opts?: {
  /** 默认 6h */
  maxAgeMs?: number;
  sync?: SyncOptions;
}): Promise<{ synced: boolean; ageMs: number | null; result?: SyncResult }> {
  const maxAgeMs = opts?.maxAgeMs ?? 6 * 60 * 60 * 1000;
  const paths = await initStoreDb(opts?.sync);
  const meta = loadMeta(paths.metaPath);
  const last = meta.last_sync_at;
  const ageMs = last != null ? Date.now() - last : null;
  if (ageMs != null && ageMs < maxAgeMs) {
    return { synced: false, ageMs };
  }
  const result = await syncSessions({ days: 7, ...(opts?.sync || {}) });
  return { synced: true, ageMs, result };
}
