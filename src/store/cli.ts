#!/usr/bin/env bun
/**
 * AI Coding Sessions CLI（Agent 友好：默认 JSON stdout）
 *
 *   bun src/store/cli.ts list --source=all --days=3
 *   bun src/store/cli.ts detail --source=kimi --id=<sessionId>
 *   bun src/store/cli.ts prompts --source=kimi --id=<sessionId>
 *   bun src/store/cli.ts stats --source=all --days=7
 *   bun src/store/cli.ts sync --days=7 --source=all --reconcile
 *   bun src/store/cli.ts refs --source=claude --days=7
 *
 * 兼容旧 flag-only 调用（无子命令 = sync）：
 *   bun src/store/cli.ts --days=7 --source=all --reconcile
 *   bun src/store/cli.ts --prompts=kimi:<id>
 *   bun src/store/cli.ts --refs-only
 *
 * env: AI_CODING_SESSIONS_DB / AI_CODING_SESSIONS_META
 */

import { ALL_SOURCES, isSourceId, type SourceId } from './schema';
import { syncSessions, reconcileSessions } from './sync';
import { listRefs } from './list-refs';
import { initStoreDb, closeStoreDb } from './db';
import {
  initAiCodingStats,
  closeAiCodingStats,
  listSessions,
  getSessionDetail,
} from '../sources/index';
import {
  queryCached,
  getCachedSession,
  getSessionPrompts,
  queryUsageByDay,
} from './query';
import { countStats } from './upsert';
import { loadMeta } from './meta';
import { resolveStorePaths } from './paths';
import type { UnifiedSessionInfo } from '../sources/types';

const COMMANDS = [
  'list',
  'detail',
  'prompts',
  'stats',
  'sync',
  'refs',
  'help',
] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(s: string): s is Command {
  return (COMMANDS as readonly string[]).includes(s);
}

interface CliArgs {
  cmd: Command;
  days?: number;
  startDate?: string;
  endDate?: string;
  source: SourceId | 'all';
  full: boolean;
  reconcile: boolean;
  refsOnly: boolean;
  /** legacy --prompts=src:id */
  promptsSpec?: string;
  id?: string;
  limit?: number;
  offset?: number;
  live: boolean;
  /** compact list fields (default true for list) */
  compact: boolean;
  /** include messages in detail (default true) */
  messages: boolean;
  dbPath?: string;
  metaPath?: string;
  help: boolean;
  /** pretty JSON (default true); --raw for single-line */
  pretty: boolean;
}

function parseSource(s: string): SourceId | 'all' {
  if (s === 'all' || isSourceId(s)) return s;
  throw new Error(`invalid --source=${s}; use all|${ALL_SOURCES.join('|')}`);
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    cmd: 'sync',
    source: 'all',
    full: false,
    reconcile: false,
    refsOnly: false,
    live: false,
    compact: true,
    messages: true,
    help: false,
    pretty: true,
  };

  let i = 0;
  if (argv[0] && !argv[0].startsWith('-') && isCommand(argv[0])) {
    out.cmd = argv[0];
    i = 1;
  }

  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--full') out.full = true;
    else if (a === '--reconcile') out.reconcile = true;
    else if (a === '--refs-only') {
      out.refsOnly = true;
      if (out.cmd === 'sync') out.cmd = 'refs';
    } else if (a === '--live') out.live = true;
    else if (a === '--full-fields' || a === '--no-compact') out.compact = false;
    else if (a === '--no-messages') out.messages = false;
    else if (a === '--raw' || a === '--compact-json') out.pretty = false;
    else if (a.startsWith('--days=')) out.days = Number(a.slice('--days='.length));
    else if (a.startsWith('--start=')) out.startDate = a.slice('--start='.length);
    else if (a.startsWith('--end=')) out.endDate = a.slice('--end='.length);
    else if (a.startsWith('--source=')) out.source = parseSource(a.slice('--source='.length));
    else if (a.startsWith('--db=')) out.dbPath = a.slice('--db='.length);
    else if (a.startsWith('--meta=')) out.metaPath = a.slice('--meta='.length);
    else if (a.startsWith('--prompts=')) {
      out.promptsSpec = a.slice('--prompts='.length);
      if (out.cmd === 'sync') out.cmd = 'prompts';
    } else if (a.startsWith('--id=')) out.id = a.slice('--id='.length);
    else if (a.startsWith('--session=') || a.startsWith('--session_id=')) {
      out.id = a.includes('session_id=')
        ? a.slice('--session_id='.length)
        : a.slice('--session='.length);
    } else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
    else if (a.startsWith('--offset=')) out.offset = Number(a.slice('--offset='.length));
    else if (a === '--json') {
      /* default already JSON */
    } else if (a.startsWith('-')) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      throw new Error(`unexpected arg: ${a}`);
    }
  }

  return out;
}

function usage() {
  console.log(`ai-coding-sessions CLI

Usage:
  bun src/store/cli.ts <command> [options]
  bun src/store/cli.ts [sync options]     # bare flags = sync (legacy)

Commands:
  list      List sessions (cache by default; --live for live convert)
  detail    Session detail live (messages + info)
  prompts   Cached user prompts for one session
  stats     Aggregate counts / tokens (cache)
  sync      Incremental sync → SQLite cache
  refs      listRefs only (no convert/write)
  help      This help

Options:
  --source=NAME       all|${ALL_SOURCES.join('|')}  (default all)
  --days=N            window (default 7 for sync/refs; list/stats omit = all cache)
  --start=YYYY-MM-DD  window start (overrides --days start)
  --end=YYYY-MM-DD    window end
  --id=SESSION        session id (detail/prompts)
  --limit=N --offset=N
  --live              list: use live listSessions instead of cache
  --full-fields       list: full UnifiedSessionInfo (default compact)
  --no-messages       detail: info + editDiffs only
  --full              sync: full rebuild window + orphan mark
  --reconcile         sync: reconcile after sync
  --db=PATH --meta=PATH
  --raw               single-line JSON
  -h, --help

Legacy:
  --prompts=src:id    same as: prompts --source=src --id=id
  --refs-only         same as: refs

Env:
  AI_CODING_SESSIONS_DB
  AI_CODING_SESSIONS_META

Examples:
  bun src/store/cli.ts list --source=kimi --days=3 --limit=20
  bun src/store/cli.ts detail --source=opencode --id=ses_xxx
  bun src/store/cli.ts prompts --source=grok --id=<uuid>
  bun src/store/cli.ts stats --source=all --days=7
  bun src/store/cli.ts sync --days=7 --source=all --reconcile
`);
}

function printJson(data: unknown, pretty: boolean) {
  console.log(pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
}

/** list/stats: resolve date window; bare --days=N → start = today-(N-1) */
function resolveWindow(args: CliArgs): { startDate?: string; endDate?: string } {
  if (args.startDate || args.endDate) {
    return { startDate: args.startDate, endDate: args.endDate };
  }
  if (args.days != null && args.days > 0) {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - (args.days - 1));
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    return { startDate: fmt(start), endDate: fmt(end) };
  }
  return {};
}

function compactSession(s: UnifiedSessionInfo) {
  return {
    id: s.id,
    source: s.source,
    title: s.title,
    project_name: s.project_name ?? s.project_id ?? null,
    directory: s.directory || null,
    parent_id: s.parent_id ?? null,
    spawn_group_id: s.spawn_group_id ?? null,
    session_status: s.session_status ?? null,
    models_used: s.models_used ?? null,
    total_tokens: s.total_tokens ?? 0,
    total_input: s.total_input ?? 0,
    total_output: s.total_output ?? 0,
    total_cache_read: s.total_cache_read ?? 0,
    total_messages: s.total_messages ?? 0,
    total_user_messages: s.total_user_messages ?? 0,
    total_tool_calls: s.total_tool_calls ?? 0,
    total_tool_calls_failed: s.total_tool_calls_failed ?? 0,
    avg_tps: s.avg_tps ?? null,
    avg_latency_ms: s.avg_latency_ms ?? null,
    last_active_at_iso: s.last_active_at_iso ?? null,
    first_active_at_iso: s.first_active_at_iso ?? null,
    usage_source: s.usage_source ?? null,
    usage_is_incomplete: s.usage_is_incomplete ?? null,
    cost_is_partial: s.cost_is_partial ?? null,
    pricing_usd: s.pricing?.usd ?? null,
    pricing_cny: s.pricing?.cny ?? null,
  };
}

function parsePromptsSpec(spec: string): { source: SourceId; sessionId: string } {
  const [source, ...rest] = spec.split(':');
  const sessionId = rest.join(':');
  if (!isSourceId(source) || !sessionId) {
    throw new Error('--prompts expects source:sessionId');
  }
  return { source, sessionId };
}

async function cmdList(args: CliArgs) {
  const { startDate, endDate } = resolveWindow(args);
  const limit = args.limit;
  const offset = args.offset;

  if (args.live) {
    await initAiCodingStats();
    try {
      const result = await listSessions({
        source: args.source,
        startDate,
        endDate,
      });
      let sessions = result.sessions;
      if (offset) sessions = sessions.slice(offset);
      if (limit != null) sessions = sessions.slice(0, limit);
      printJson(
        {
          mode: 'live',
          total: result.total,
          returned: sessions.length,
          bySource: result.bySource,
          startDate: startDate ?? null,
          endDate: endDate ?? null,
          sessions: args.compact ? sessions.map(compactSession) : sessions,
        },
        args.pretty,
      );
    } finally {
      closeAiCodingStats();
    }
    return;
  }

  await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
  try {
    const result = queryCached({
      source: args.source,
      startDate,
      endDate,
      limit,
      offset,
    });
    printJson(
      {
        mode: 'cache',
        total: result.total,
        returned: result.sessions.length,
        bySource: result.bySource,
        lastUpdatedAt: result.lastUpdatedAt ?? null,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        sessions: args.compact
          ? result.sessions.map(compactSession)
          : result.sessions,
      },
      args.pretty,
    );
  } finally {
    closeStoreDb();
  }
}

async function cmdDetail(args: CliArgs) {
  if (!args.id) throw new Error('detail requires --id=<sessionId>');
  if (args.source === 'all') {
    throw new Error('detail requires --source=<one source>, not all');
  }

  await initAiCodingStats();
  try {
    const detail = await getSessionDetail({
      sessionId: args.id,
      source: args.source,
    });
    if (!detail) {
      printJson(
        { ok: false, error: 'not_found', source: args.source, id: args.id },
        args.pretty,
      );
      process.exitCode = 1;
      return;
    }

    const payload = args.messages
      ? {
          ok: true,
          source: args.source,
          id: args.id,
          info: args.compact ? compactSession(detail.info) : detail.info,
          messages: detail.messages,
          editDiffs: detail.editDiffs,
          pricing: detail.pricing ?? null,
          trends: detail.trends ?? null,
          message_count: detail.messages?.length ?? 0,
        }
      : {
          ok: true,
          source: args.source,
          id: args.id,
          info: args.compact ? compactSession(detail.info) : detail.info,
          editDiffs: detail.editDiffs,
          pricing: detail.pricing ?? null,
          message_count: detail.messages?.length ?? 0,
        };

    printJson(payload, args.pretty);
  } finally {
    closeAiCodingStats();
  }
}

async function cmdPrompts(args: CliArgs) {
  let source: SourceId;
  let sessionId: string;

  if (args.promptsSpec) {
    ({ source, sessionId } = parsePromptsSpec(args.promptsSpec));
  } else {
    if (!args.id) throw new Error('prompts requires --id=<sessionId> (or --prompts=src:id)');
    if (args.source === 'all') {
      throw new Error('prompts requires --source=<one source>, not all');
    }
    source = args.source;
    sessionId = args.id;
  }

  await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
  try {
    const rows = getSessionPrompts(source, sessionId);
    const cached = getCachedSession(source, sessionId);
    printJson(
      {
        source,
        sessionId,
        count: rows.length,
        title: cached?.title ?? null,
        prompts: rows,
      },
      args.pretty,
    );
  } finally {
    closeStoreDb();
  }
}

async function cmdStats(args: CliArgs) {
  const { startDate, endDate } = resolveWindow(args);
  const paths = resolveStorePaths({ dbPath: args.dbPath, metaPath: args.metaPath });

  await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
  try {
    const result = queryCached({
      source: args.source,
      startDate,
      endDate,
    });

    let tokens = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let userMessages = 0;
    let toolCalls = 0;
    let toolFailed = 0;
    const bySourceDetail: Record<
      string,
      { sessions: number; tokens: number; user_messages: number }
    > = {};

    for (const s of result.sessions) {
      const t = s.total_tokens || 0;
      tokens += t;
      input += s.total_input || 0;
      output += s.total_output || 0;
      cacheRead += s.total_cache_read || 0;
      userMessages += s.total_user_messages || 0;
      toolCalls += s.total_tool_calls || 0;
      toolFailed += s.total_tool_calls_failed || 0;
      const src = s.source || 'unknown';
      if (!bySourceDetail[src]) {
        bySourceDetail[src] = { sessions: 0, tokens: 0, user_messages: 0 };
      }
      bySourceDetail[src].sessions += 1;
      bySourceDetail[src].tokens += t;
      bySourceDetail[src].user_messages += s.total_user_messages || 0;
    }

    const usageDays = queryUsageByDay({
      source: args.source === 'all' ? 'all' : args.source,
      startDay: startDate,
      endDay: endDate,
    });
    const tokensByDay: Record<string, number> = {};
    for (const row of usageDays) {
      tokensByDay[row.day] = (tokensByDay[row.day] || 0) + (row.tokens || 0);
    }

    const meta = loadMeta(paths.metaPath);
    const dbStats = countStats();

    printJson(
      {
        mode: 'cache',
        source: args.source,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        sessions: result.total,
        bySource: result.bySource,
        bySourceDetail,
        totals: {
          tokens,
          input,
          output,
          cache_read: cacheRead,
          user_messages: userMessages,
          tool_calls: toolCalls,
          tool_calls_failed: toolFailed,
        },
        tokensByDay,
        store: {
          paths,
          meta_last_sync_at: meta.last_sync_at ?? null,
          db_stats: dbStats,
        },
      },
      args.pretty,
    );
  } finally {
    closeStoreDb();
  }
}

async function cmdRefs(args: CliArgs) {
  await initAiCodingStats();
  try {
    const since = args.full
      ? undefined
      : args.startDate
        ? Date.parse(args.startDate)
        : Date.now() - (args.days ?? 7) * 86400000;
    const refs = await listRefs({
      source: args.source,
      since: Number.isFinite(since) ? since : undefined,
    });
    const limit = args.limit ?? 50;
    printJson(
      {
        count: refs.length,
        returned: Math.min(limit, refs.length),
        truncated: refs.length > limit,
        refs: refs.slice(0, limit),
      },
      args.pretty,
    );
  } finally {
    closeAiCodingStats();
  }
}

async function cmdSync(args: CliArgs) {
  console.error(
    `[cli] sync source=${args.source} start=${args.startDate || '-'} end=${args.endDate || '-'} days=${args.days ?? 7} full=${args.full}`,
  );
  const result = await syncSessions({
    days: args.days,
    startDate: args.startDate,
    endDate: args.endDate,
    source: args.source,
    full: args.full,
    dbPath: args.dbPath,
    metaPath: args.metaPath,
    closeAfter: false,
  });

  const body: Record<string, unknown> = {
    ok: result.ok,
    paths: result.paths,
    duration_ms: result.duration_ms,
    totals: result.totals,
    stats: result.stats,
    bySource: result.bySource,
  };

  if (args.reconcile) {
    console.error('[cli] reconcile…');
    const rec = await reconcileSessions({
      days: args.days,
      startDate: args.startDate,
      endDate: args.endDate,
      source: args.source,
      full: args.full,
      dbPath: args.dbPath,
      metaPath: args.metaPath,
      closeAfter: false,
    });
    body.reconcile = rec;
    if (!rec.ok) process.exitCode = 2;
  }

  printJson(body, args.pretty);

  const cached = queryCached({ source: args.source, limit: 3 });
  console.error(
    `[cli] cache sample total_query=${cached.total} first_titles=${cached.sessions
      .slice(0, 3)
      .map((s) => `${s.source}:${(s.title || '').slice(0, 24)}`)
      .join(' | ')}`,
  );
  console.error(`[cli] meta last_sync_at=${loadMeta(result.paths.metaPath).last_sync_at}`);
  console.error(`[cli] stats`, countStats());

  closeAiCodingStats();
  closeStoreDb();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.cmd === 'help') {
    usage();
    return;
  }

  switch (args.cmd) {
    case 'list':
      await cmdList(args);
      break;
    case 'detail':
      await cmdDetail(args);
      break;
    case 'prompts':
      await cmdPrompts(args);
      break;
    case 'stats':
      await cmdStats(args);
      break;
    case 'refs':
      await cmdRefs(args);
      break;
    case 'sync':
      await cmdSync(args);
      break;
    default:
      usage();
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
