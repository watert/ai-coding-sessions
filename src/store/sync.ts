/**
 * 同步引擎（M3）
 *
 * 策略：
 * 1. listRefs 便宜脏标记（mtime:size / SQL time_updated）
 * 2. 默认只 convert dirty session；full 或脏比例高时回退全量 listSessions
 * 3. content_fingerprint 比对后 upsert（prompts + usage_by_day）
 * 4. full 时 mark orphan；meta JSON 写 last_sync_at
 */

import dayjs from 'dayjs';
import {
  initAiCodingStats,
  listSessions,
  closeAiCodingStats,
  getSessionDetail,
  convertSessionsByIds,
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
  getCachedDirtyMark,
} from './upsert';
import { queryCached, getCachedSession } from './query';
import { extractSkillReads, replaceSkillReads, getSkillReadsBuiltAt } from './session-skill-reads';

/**
 * 脏 session 超过此数量（或 refs 的 50%）时回退全量 convert。
 * 增量按条 convert 每源都有一次 catalog 扫描的固定开销，量大了不如全量批处理。
 */
const INCREMENTAL_DIRTY_MAX = 120;

export interface SyncOptions {
  /** 回溯天数，默认 7；与 startDate 二选一，startDate 优先 */
  days?: number;
  startDate?: string;
  endDate?: string;
  source?: SourceId | 'all';
  /** 全量：不按 dirty 跳过写库提示 + 扫描 orphan */
  full?: boolean;
  /** 忽略 dirty，对窗口内 session 强制 convert+upsert（宿主 ?fresh=1） */
  reconvert?: boolean;
  dbPath?: string;
  metaPath?: string;
  /** 同步后关闭源 DB（CLI 用） */
  closeAfter?: boolean;
  /** upsert 后顺带物化 skill-reads (增量 query 顺手补; 默认 true) */
  skillReads?: boolean;
}

export interface SyncSourceResult {
  source: SourceId;
  refs: number;
  live: number;
  inserted: number;
  updated: number;
  skipped: number;
  orphaned: number;
  /** 本次顺手物化 skill-reads 的 session 数 */
  skill_reads_built?: number;
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
      const r = await syncOneSource(source, {
        startDate,
        endDate,
        full,
        reconvert: !!options.reconvert,
        skillReads: options.skillReads,
      });
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

    const s = meta.stats ?? {};

    return {
      ok: bySource.every((src) => !src.error),
      paths,
      bySource,
      totals,
      stats: {
        session_count: s.session_count ?? 0,
        prompt_count: s.prompt_count ?? 0,
        token_total: s.token_total ?? 0,
        orphan_count: s.orphan_count ?? 0,
      },
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
  opts: { startDate?: string; endDate?: string; full: boolean; reconvert?: boolean; skillReads?: boolean },
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

    const dirtyIds: string[] = [];
    const upsertedIds: string[] = [];
    for (const r of refs) {
      const cached = getCachedDirtyMark(source, r.session_id);
      if (opts.full || cached == null || cached !== r.dirty_mark) {
        dirtyIds.push(r.session_id);
      }
    }

    // 无脏且非 full/reconvert：只刷新 meta 时间，跳过 convert
    if (!opts.full && !opts.reconvert && dirtyIds.length === 0) {
      result.live = 0;
      result.duration_ms = Date.now() - t0;
      return result;
    }

    const useFull = shouldUseFullConvert({
      full: opts.full,
      reconvert: !!opts.reconvert,
      dirtyCount: dirtyIds.length,
      refsCount: refs.length,
    });

    let sessions: UnifiedSessionInfo[];
    if (useFull) {
      const live = await listSessions({
        source,
        startDate: opts.full ? undefined : opts.startDate,
        endDate: opts.endDate,
      });
      sessions = live.sessions;
    } else {
      // 增量：只 convert 脏 id（各源复用全量路径的 convert，字段与指纹一致）
      sessions = await convertSessionsByIds(source, dirtyIds);
    }

    result.live = sessions.length;
    const liveIds = new Set<string>();
    for (const s of sessions) {
      liveIds.add(s.id);
      // dirty_mark：优先 listRefs；虚拟 subagent 用 parent 或 time_updated
      const dirty =
        dirtyById.get(s.id) ??
        (s.parent_id ? dirtyById.get(s.parent_id) : undefined) ??
        String(s.time_updated || 0);

      // 增量 convert 可能缺 parent_id（关系在 parent updates）；保留缓存
      const merged = mergeParentFromCache(s);

      const ur = upsertSession(merged, {
        dirty_mark: dirty,
        force: opts.full || opts.reconvert,
      });
      if (ur.action === 'insert') result.inserted++;
      else if (ur.action === 'update') result.updated++;
      else result.skipped++;
      if (ur.action !== 'skip' && opts.skillReads !== false) upsertedIds.push(s.id);
    }

    // 顺手补 skill-reads（仅本次有内容变化的 session; live detail 读取, list 已走 TTL 缓存）
    if (upsertedIds.length) {
      result.skill_reads_built = await backfillSkillReads(source, upsertedIds);
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

function mergeParentFromCache(s: UnifiedSessionInfo): UnifiedSessionInfo {
  if (s.parent_id) return s;
  const prev = getCachedSession(s.source as SourceId, s.id);
  if (prev?.parent_id) {
    return { ...s, parent_id: prev.parent_id };
  }
  return s;
}

/** 顺手补: 对本次 upsert 的 session 增量物化 skill-reads (last_active 晚于 built_at 才重提, 失败不阻塞 sync)
 *  边界语义 — `detail === null` (transient 失败) → **skip 本次 replace** 让下次增量重试; 空 extract → **仍走 replace** (issue #14 ①) */
async function backfillSkillReads(source: SourceId, ids: string[]): Promise<number> {
  let built = 0;
  for (const id of ids) {
    try {
      const s = getCachedSession(source, id);
      const lastActiveMs = s?.last_active_at_iso ? Date.parse(s.last_active_at_iso) : 0;
      const builtAt = getSkillReadsBuiltAt(source, id);
      if (builtAt != null && lastActiveMs <= builtAt) continue;
      const detail = await getSessionDetail({ sessionId: id, source });
      if (detail == null) continue;
      replaceSkillReads(source, id, extractSkillReads(detail.messages));
      built++;
    } catch (e) {
      console.warn(`[sync] skill-reads ${source}/${id} failed:`, e);
    }
  }
  return built;
}

/**
 * 全量 vs 增量 convert 判定（纯函数，便于单测）。
 * - full / reconvert：强制全量
 * - 脏数量超阈值或占 refs 过半：全量批处理更划算
 * - 其余：按 id 增量（各源都支持，见 convertSessionsByIds）
 */
export function shouldUseFullConvert(opts: {
  full?: boolean;
  reconvert?: boolean;
  dirtyCount: number;
  refsCount: number;
}): boolean {
  if (opts.full || opts.reconvert) return true;
  if (opts.dirtyCount > INCREMENTAL_DIRTY_MAX) return true;
  if (opts.refsCount > 0 && opts.dirtyCount > opts.refsCount * 0.5) return true;
  return false;
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

/** 请求涉及 source 中最旧的 last_sync_at；任一缺失视为从未 sync */
function oldestSourceSyncAt(meta: StoreMeta, sources: SourceId[]): number | null {
  let oldest: number | null = null;
  for (const s of sources) {
    const t = meta.sources[s]?.last_sync_at;
    if (t == null) return null;
    if (oldest == null || t < oldest) oldest = t;
  }
  return oldest;
}

export type EnsureFreshPlanReason = 'never' | 'min_interval' | 'ttl_all' | 'check';

export interface EnsureFreshPlan {
  reason: EnsureFreshPlanReason;
  staleSources: SourceId[];
  checkSources: SourceId[];
  ageMs: number | null;
}

/**
 * per-source 闸：刚 sync 的源跳过 listRefs，热源不得挡其它源。
 * 旧 newest 早退会让热 grok/kimi 把 opencode 脏检饿死。
 */
export function planEnsureFresh(opts: {
  sources: SourceId[];
  meta: StoreMeta;
  now: number;
  maxAgeMs: number;
  minIntervalMs: number;
}): EnsureFreshPlan {
  const { sources, meta, now, maxAgeMs, minIntervalMs } = opts;
  const oldest = oldestSourceSyncAt(meta, sources);
  const ageMs = oldest != null ? now - oldest : null;
  if (oldest == null) {
    return { reason: 'never', staleSources: [...sources], checkSources: [], ageMs: null };
  }

  const staleSources = sources.filter((s) => {
    const t = meta.sources[s]?.last_sync_at;
    return t == null || now - t >= maxAgeMs;
  });
  if (staleSources.length === sources.length) {
    return { reason: 'ttl_all', staleSources, checkSources: [], ageMs };
  }

  const staleSet = new Set(staleSources);
  const checkSources = sources.filter((s) => {
    if (staleSet.has(s)) return false;
    const t = meta.sources[s]?.last_sync_at;
    return t == null || now - t >= minIntervalMs;
  });
  if (!staleSources.length && !checkSources.length) {
    return { reason: 'min_interval', staleSources: [], checkSources: [], ageMs };
  }
  return { reason: 'check', staleSources, checkSources, ageMs };
}

/**
 * ensureFresh：
 * 1. minInterval：per-source。刚 sync 过的源跳过 listRefs（防 5s 轮询 thrash）
 * 2. TTL：per-source 过期的强制 sync（避免只刷 grok 导致 claude 永远不扫）
 * 3. 其余 source 用 listRefs 脏检测；只 sync 脏/过期源
 */
export async function ensureFresh(opts?: {
  /** 默认 6h：绝对过期强制 sync */
  maxAgeMs?: number;
  /** 默认 30s：最短间隔，不检测也不 sync */
  minIntervalMs?: number;
  /** 默认 true：TTL 内做 listRefs 脏检测 */
  checkDirty?: boolean;
  sync?: SyncOptions;
}): Promise<{
  synced: boolean;
  ageMs: number | null;
  reason?: 'min_interval' | 'clean' | 'dirty' | 'ttl' | 'never';
  result?: SyncResult;
}> {
  const maxAgeMs = opts?.maxAgeMs ?? 6 * 60 * 60 * 1000;
  const minIntervalMs = opts?.minIntervalMs ?? 30_000;
  const checkDirty = opts?.checkDirty !== false;
  const paths = await initStoreDb(opts?.sync);
  const meta = loadMeta(paths.metaPath);
  const sources = normalizeSources(opts?.sync?.source);
  const plan = planEnsureFresh({ sources, meta, now: Date.now(), maxAgeMs, minIntervalMs });

  if (plan.reason === 'never' || plan.reason === 'ttl_all') {
    const result = await syncSessions({ days: 7, ...(opts?.sync || {}) });
    return { synced: true, ageMs: plan.ageMs, reason: plan.reason === 'never' ? 'never' : 'ttl', result };
  }
  if (plan.reason === 'min_interval') {
    return { synced: false, ageMs: plan.ageMs, reason: 'min_interval' };
  }

  let dirtySources: SourceId[] = [];
  if (checkDirty && plan.checkSources.length) {
    dirtySources = await findDirtySources(opts?.sync, plan.checkSources);
  }

  const toSync = [...new Set([...plan.staleSources, ...dirtySources])];
  if (!toSync.length) {
    return { synced: false, ageMs: plan.ageMs, reason: 'clean' };
  }

  const result = await syncDirtySources(toSync, opts?.sync);
  const reason = plan.staleSources.length ? 'ttl' : 'dirty';
  return { synced: true, ageMs: plan.ageMs, reason, result };
}

/**
 * 便宜脏检测：listRefs dirty_mark vs 缓存。
 * - 缓存无此 id → 新 session
 * - dirty_mark 不一致 → 源侧内容文件有更新
 * @returns 需要 sync 的 source 列表
 */
async function findDirtySources(
  sync?: SyncOptions,
  onlySources?: SourceId[],
): Promise<SourceId[]> {
  const sources = onlySources ?? normalizeSources(sync?.source);
  const startDate = sync?.full ? undefined : resolveStartDate(sync || {});
  const since = startDate ? dayjs(startDate).startOf('day').valueOf() : undefined;
  const dirty = new Set<SourceId>();

  // 并行 listRefs（listRefs 单源已轻量）
  await Promise.all(
    sources.map(async (source) => {
      try {
        const refs = await listRefs({ source, since });
        for (const r of refs) {
          const cached = getCachedDirtyMark(r.source, r.session_id);
          if (cached == null || cached !== r.dirty_mark) {
            dirty.add(source);
            return;
          }
        }
      } catch (e) {
        console.warn(`[ensureFresh] listRefs ${source} failed, mark dirty:`, e);
        dirty.add(source);
      }
    }),
  );
  return [...dirty];
}

/** 逐个 source 跑 syncSessions（合并 totals） */
async function syncDirtySources(
  dirtySources: SourceId[],
  sync?: SyncOptions,
): Promise<SyncResult> {
  if (dirtySources.length === 1) {
    return syncSessions({ days: 7, ...(sync || {}), source: dirtySources[0] });
  }
  // 多 source：一次 all 会重扫干净源；逐源更准
  const t0 = Date.now();
  const bySource: SyncSourceResult[] = [];
  let last: SyncResult | null = null;
  for (const source of dirtySources) {
    last = await syncSessions({ days: 7, ...(sync || {}), source });
    bySource.push(...last.bySource);
  }
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
    paths: last!.paths,
    bySource,
    totals,
    stats: last!.stats,
    meta: last!.meta,
    duration_ms: Date.now() - t0,
  };
}
