#!/usr/bin/env bun
/**
 * AI Coding Sessions CLI（Agent 友好：默认 JSON stdout）
 *
 *   bun src/store/cli.ts list --source=all --days=3
 *   bun src/store/cli.ts list --source=kimi --parent=<sessionId>
 *   bun src/store/cli.ts children --source=kimi --id=<parentId>
 *   bun src/store/cli.ts detail --source=kimi --id=<sessionId>
 *   bun src/store/cli.ts detail --source=kimi --id=<id> --tools-only --max-output-chars=500
 *   bun src/store/cli.ts trace --source=kimi --id=<sessionId>
 *   bun src/store/cli.ts trace --source=kimi --id=<id> --io --tool=Bash
 *   bun src/store/cli.ts prompts --source=kimi --id=<sessionId>
 *   bun src/store/cli.ts stats --source=all --days=7
 *   bun src/store/cli.ts sync --days=7 --source=all --reconcile
 *
 * 兼容旧 flag-only 调用（无子命令 = sync）
 *
 * env: AI_CODING_SESSIONS_DB / AI_CODING_SESSIONS_META
 *
 * Trajectory / Agent trace: https://github.com/watert/ai-coding-sessions/issues/1
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
import {
  buildTraceSteps,
  shapeDetailMessages,
  summarizeTraceTools,
  summarizeTraceTurns,
} from './session-trace';
import { countStats } from './upsert';
import { loadMeta } from './meta';
import { resolveStorePaths } from './paths';
import type { UnifiedSessionInfo } from '../sources/types';

const COMMANDS = [
  'list',
  'detail',
  'trace',
  'timeline', // alias → trace
  'children',
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
  promptsSpec?: string;
  id?: string;
  parentId?: string;
  rootsOnly: boolean;
  limit?: number;
  offset?: number;
  live: boolean;
  compact: boolean;
  messages: boolean;
  dbPath?: string;
  metaPath?: string;
  help: boolean;
  pretty: boolean;
  /** detail/trace */
  toolsOnly: boolean;
  noReasoning: boolean;
  maxOutputChars?: number;
  from?: number;
  to?: number;
  textPreview?: number;
  maxSteps?: number;
  /** trace depth */
  includeIo: boolean;
  includeReasoning: boolean;
  tool?: string;
  status?: string;
  jsonl: boolean;
  /** detail: attach children from cache */
  withChildren: boolean;
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
    rootsOnly: false,
    live: false,
    compact: true,
    messages: true,
    help: false,
    pretty: true,
    toolsOnly: false,
    noReasoning: false,
    includeIo: false,
    includeReasoning: false,
    jsonl: false,
    withChildren: false,
  };

  let i = 0;
  if (argv[0] && !argv[0].startsWith('-') && isCommand(argv[0])) {
    out.cmd = argv[0] === 'timeline' ? 'trace' : argv[0];
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
    else if (a === '--tools-only') out.toolsOnly = true;
    else if (a === '--no-reasoning') out.noReasoning = true;
    else if (a === '--io' || a === '--include-io') out.includeIo = true;
    else if (a === '--reasoning' || a === '--include-reasoning') out.includeReasoning = true;
    else if (a === '--jsonl') out.jsonl = true;
    else if (a === '--with-children' || a === '--children') out.withChildren = true;
    else if (a === '--roots' || a === '--roots-only') out.rootsOnly = true;
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
    } else if (a.startsWith('--parent=')) out.parentId = a.slice('--parent='.length);
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
    else if (a.startsWith('--offset=')) out.offset = Number(a.slice('--offset='.length));
    else if (a.startsWith('--max-output-chars=')) {
      out.maxOutputChars = Number(a.slice('--max-output-chars='.length));
    } else if (a.startsWith('--from=')) out.from = Number(a.slice('--from='.length));
    else if (a.startsWith('--to=')) out.to = Number(a.slice('--to='.length));
    else if (a.startsWith('--text-preview=')) {
      out.textPreview = Number(a.slice('--text-preview='.length));
    } else if (a.startsWith('--max-steps=')) out.maxSteps = Number(a.slice('--max-steps='.length));
    else if (a.startsWith('--tool=')) out.tool = a.slice('--tool='.length);
    else if (a.startsWith('--status=')) out.status = a.slice('--status='.length);
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
  list       List sessions (cache default; --live; --parent=; --roots)
  children   List child sessions of --id (cache; alias of list --parent=)
  detail     Session detail live (size flags for Agent context)
  trace      Trajectory skeleton (default no tool I/O)  [alias: timeline]
  prompts    Cached user prompts
  stats      Aggregate counts / tokens (cache)
  sync       Incremental sync → SQLite
  refs       listRefs only
  help

Agent trajectory (issue #1):
  list --source=kimi --days=3 --limit=20
  children --source=kimi --id=<parent>
  trace --source=kimi --id=<id>                 # skeleton
  trace --source=kimi --id=<id> --io --tool=Bash
  detail --source=kimi --id=<id> --tools-only --max-output-chars=500
  detail --source=kimi --id=<id> --from=0 --to=5 --no-reasoning

Options:
  --source=NAME       all|${ALL_SOURCES.join('|')}
  --days=N --start= --end=
  --id=SESSION        detail/trace/prompts/children
  --parent=SESSION    list children of parent
  --roots             list top-level only (no parent_id)
  --limit=N --offset=N
  --live              list: live convert
  --full-fields       list/detail info: full objects
  --no-messages       detail: skip messages
  --with-children     detail/trace: attach children from cache
  --tools-only        detail: tool(+step) parts only
  --no-reasoning      detail: drop reasoning/thinking parts
  --max-output-chars=N  truncate tool I/O & long text
  --from=N --to=N     message index range
  --io                trace: include tool input/output previews
  --reasoning         trace: include reasoning_preview
  --tool=NAME --status=STATUS  filter tools (trace/detail; status: error|soft|hard|completed)
  --text-preview=N --max-steps=N
  --jsonl             trace: one JSON object per line
  --full --reconcile  sync
  --db=PATH --meta=PATH
  --raw               single-line JSON
  -h, --help

Env: AI_CODING_SESSIONS_DB / AI_CODING_SESSIONS_META
`);
}

function printJson(data: unknown, pretty: boolean) {
  console.log(pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
}

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

function requireOneSource(args: CliArgs, cmd: string): SourceId {
  if (args.source === 'all') {
    throw new Error(`${cmd} requires --source=<one source>, not all`);
  }
  return args.source;
}

function requireId(args: CliArgs, cmd: string): string {
  if (!args.id) throw new Error(`${cmd} requires --id=<sessionId>`);
  return args.id;
}

function loadChildrenFromCache(
  source: SourceId | 'all',
  parentId: string,
  compact: boolean,
): ReturnType<typeof compactSession>[] | UnifiedSessionInfo[] {
  const result = queryCached({ source, parentId });
  return compact ? result.sessions.map(compactSession) : result.sessions;
}

async function cmdList(args: CliArgs) {
  const { startDate, endDate } = resolveWindow(args);
  const limit = args.limit;
  const offset = args.offset;
  const parentId = args.parentId;

  if (args.live) {
    await initAiCodingStats();
    try {
      const result = await listSessions({
        source: args.source,
        startDate,
        endDate,
      });
      let sessions = result.sessions;
      if (parentId) {
        sessions = sessions.filter((s) => (s.parent_id ?? null) === parentId);
      } else if (args.rootsOnly) {
        sessions = sessions.filter((s) => s.parent_id == null || s.parent_id === '');
      }
      const total = sessions.length;
      if (offset) sessions = sessions.slice(offset);
      if (limit != null) sessions = sessions.slice(0, limit);
      printJson(
        {
          mode: 'live',
          total,
          returned: sessions.length,
          parent_id: parentId ?? null,
          roots_only: args.rootsOnly || null,
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
      parentId,
      rootsOnly: args.rootsOnly,
      limit,
      offset,
    });
    printJson(
      {
        mode: 'cache',
        total: result.total,
        returned: result.sessions.length,
        parent_id: parentId ?? null,
        roots_only: args.rootsOnly || null,
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

async function cmdChildren(args: CliArgs) {
  const id = requireId(args, 'children');
  // children = list --parent=id
  args.parentId = id;
  args.id = undefined;
  await cmdList(args);
}

async function cmdDetail(args: CliArgs) {
  const id = requireId(args, 'detail');
  const source = requireOneSource(args, 'detail');

  await initAiCodingStats();
  try {
    const detail = await getSessionDetail({ sessionId: id, source });
    if (!detail) {
      printJson({ ok: false, error: 'not_found', source, id }, args.pretty);
      process.exitCode = 1;
      return;
    }

    let messages = detail.messages || [];
    if (args.messages) {
      messages = shapeDetailMessages(messages, {
        toolsOnly: args.toolsOnly,
        noReasoning: args.noReasoning,
        maxOutputChars: args.maxOutputChars,
        from: args.from,
        to: args.to,
        tool: args.tool,
        status: args.status,
      });
    }

    const payload: Record<string, unknown> = {
      ok: true,
      source,
      id,
      info: args.compact ? compactSession(detail.info) : detail.info,
      editDiffs: detail.editDiffs,
      pricing: detail.pricing ?? null,
      message_count: detail.messages?.length ?? 0,
      messages_returned: args.messages ? messages.length : 0,
      shape: {
        tools_only: args.toolsOnly || null,
        no_reasoning: args.noReasoning || null,
        max_output_chars: args.maxOutputChars ?? null,
        from: args.from ?? null,
        to: args.to ?? null,
        tool: args.tool ?? null,
        status: args.status ?? null,
      },
    };

    if (args.messages) {
      payload.messages = messages;
      if (!args.toolsOnly) payload.trends = detail.trends ?? null;
    }

    if (args.withChildren) {
      await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
      try {
        payload.children = loadChildrenFromCache(source, id, args.compact);
      } finally {
        closeStoreDb();
      }
    }

    printJson(payload, args.pretty);
  } finally {
    closeAiCodingStats();
  }
}

async function cmdTrace(args: CliArgs) {
  const id = requireId(args, 'trace');
  const source = requireOneSource(args, 'trace');

  await initAiCodingStats();
  try {
    const detail = await getSessionDetail({ sessionId: id, source });
    if (!detail) {
      printJson({ ok: false, error: 'not_found', source, id }, args.pretty);
      process.exitCode = 1;
      return;
    }

    const steps = buildTraceSteps(detail.messages, {
      includeTools: true,
      includeIo: args.includeIo,
      includeReasoning: args.includeReasoning,
      textPreview: args.textPreview,
      maxOutputChars: args.maxOutputChars ?? 400,
      tool: args.tool,
      status: args.status,
      from: args.from,
      to: args.to,
      maxSteps: args.maxSteps ?? args.limit,
    });

    if (args.jsonl) {
      for (const step of steps) {
        console.log(JSON.stringify(step));
      }
      return;
    }

    const payload: Record<string, unknown> = {
      ok: true,
      mode: 'trace',
      source,
      id,
      title: detail.info?.title ?? null,
      parent_id: detail.info?.parent_id ?? null,
      spawn_group_id: detail.info?.spawn_group_id ?? null,
      session_status: detail.info?.session_status ?? null,
      message_count: detail.messages?.length ?? 0,
      step_count: steps.length,
      tool_summary: summarizeTraceTools(steps),
      turns: summarizeTraceTurns(steps),
      editDiffs: detail.editDiffs,
      options: {
        io: args.includeIo,
        reasoning: args.includeReasoning,
        tool: args.tool ?? null,
        status: args.status ?? null,
        max_output_chars: args.maxOutputChars ?? 400,
        text_preview: args.textPreview ?? 120,
      },
      steps,
    };

    if (args.withChildren) {
      await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
      try {
        payload.children = loadChildrenFromCache(source, id, true);
      } finally {
        closeStoreDb();
      }
    }

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
    sessionId = requireId(args, 'prompts');
    source = requireOneSource(args, 'prompts');
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
        parent_id: cached?.parent_id ?? null,
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
      parentId: args.parentId,
      rootsOnly: args.rootsOnly,
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
    case 'children':
      await cmdChildren(args);
      break;
    case 'detail':
      await cmdDetail(args);
      break;
    case 'trace':
    case 'timeline':
      await cmdTrace(args);
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
