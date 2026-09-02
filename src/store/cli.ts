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
 *   bun src/store/cli.ts trace --source=kimi --id=<id> --format=md --out=trace.md
 *   bun src/store/cli.ts tool-errors --source=kimi --id=<id> --status=hard
 *   bun src/store/cli.ts handoff --source=kimi --id=<id>
 *   bun src/store/cli.ts handoff --source=grok --cwd=. --ref=latest
 *   bun src/store/cli.ts resolve --source=all --cwd=. --ref="partial title"
 *   bun src/store/cli.ts list --cwd=. --days=7 --limit=20
 *   bun src/store/cli.ts prompts --source=kimi --id=<sessionId>
 *   bun src/store/cli.ts prompts --id=a,b,c --source=kimi       # 同 source 批量
 *   bun src/store/cli.ts prompts --source=kimi --days=7 --roots # 窗口批量 (默认 7 天)
 *   bun src/store/cli.ts prompts --source=kimi --days=7 --jsonl # 每行一个 session
 *   bun src/store/cli.ts list --untitled --days=7
 *   bun src/store/cli.ts set-title --source=kimi --id=<id> --title="知乎爬虫评审"
 *   bun src/store/cli.ts stats --source=all --days=7
 *   bun src/store/cli.ts digest --days=1 --roots --format=md --out=digest.md
 *   bun src/store/cli.ts sync --days=7 --source=all --reconcile
 *   bun src/store/cli.ts scan --grep='kimi -p' --days=90 --limit=20
 *   bun src/store/cli.ts tool-calls --build --days=90
 *   bun src/store/cli.ts tool-calls --days=90 --out=tc.jsonl
 *
 * 兼容旧 flag-only 调用（无子命令 = sync）
 *
 * env: AI_CODING_SESSIONS_DB / AI_CODING_SESSIONS_META
 *
 * Trajectory / Agent trace: https://github.com/watert/ai-coding-sessions/issues/1
 * Handoff / cwd / resolve: https://github.com/watert/ai-coding-sessions/issues/4
 */

import { writeFileSync } from 'node:fs';
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
  listSessionPrompts,
  listTitleReview,
  type ListSessionPromptsOptions,
} from './query';
import {
  buildTraceSteps,
  shapeDetailMessages,
  summarizeTraceTools,
  summarizeTraceTurns,
  collectToolErrors,
  formatTraceMarkdown,
  formatTraceJsonl,
  inferTraceFormat,
  summarizeSessionTimingFromMessages,
  type TraceExportFormat,
} from './session-trace';
import { buildHandoff, formatHandoffMarkdown } from './session-handoff';
import { buildDigest, formatDigestMarkdown } from './session-digest';
import {
  filterSessionsByCwd,
  resolveSessionRef,
  type ResolveResult,
} from './session-resolve';
import { computeCliStats } from './session-stats';
import { collectSessionFailures } from './failure-stats';
import { scanSessions } from './session-scan';
import {
  extractToolCalls,
  getToolCallsBuiltAt,
  queryToolCallsBySession,
  replaceToolCalls,
  toolCallHeader,
} from './session-tool-calls';
import { countStats } from './upsert';
import { loadMeta } from './meta';
import { resolveStorePaths } from './paths';
import {
  applyCustomTitles,
  isWeakTitle,
  overlaySessionDetail,
  setSessionTitle,
} from './session-title';
import { initOpencodeDb, updateSessionTitle } from '../sources/opencode';
import type { UnifiedSessionInfo, UnifiedSessionDetail } from '../sources/types';

const COMMANDS = [
  'list',
  'detail',
  'trace',
  'timeline', // alias → trace
  'tool-errors',
  'failures',
  'handoff',
  'resume-summary', // alias → handoff
  'digest',
  'resolve',
  'children',
  'prompts',
  'set-title',
  'title-review',
  'stats',
  'scan',
  'tool-calls',
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
  /** export path (trace/tool-errors); format inferred from ext or --format */
  out?: string;
  format?: TraceExportFormat;
  /** list/handoff/resolve: project cwd filter */
  cwd?: string;
  /**
   * handoff/resolve: latest | id | path | title substring
   * (--id= still wins when set)
   */
  ref?: string;
  /** list: 仅弱标题且无 custom_title */
  untitledOnly: boolean;
  /** set-title */
  title?: string;
  clearTitle: boolean;
  writeSource: boolean;
  /** title-review: 每条 session 预览 prompt 条数 */
  promptPreviewCount: number;
  /** title-review: 每条 prompt 预览字符上限 */
  promptPreviewChars: number;
  /** title-review: 无 prompt 的 session 也列出 */
  includeEmptyReview: boolean;
  /** scan: 匹配 pattern */
  grep?: string;
  /** scan: pattern 按 RegExp 匹配 */
  regex: boolean;
  /** tool-calls: live 提取并物化到缓存表 (增量) */
  build: boolean;
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
    untitledOnly: false,
    clearTitle: false,
    writeSource: false,
    promptPreviewCount: 3,
    promptPreviewChars: 300,
    includeEmptyReview: false,
    regex: false,
    build: false,
  };

  let i = 0;
  if (argv[0] && !argv[0].startsWith('-') && isCommand(argv[0])) {
    if (argv[0] === 'timeline') out.cmd = 'trace';
    else if (argv[0] === 'resume-summary') out.cmd = 'handoff';
    else out.cmd = argv[0];
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
    else if (a === '--jsonl') {
      out.jsonl = true;
      out.format = out.format || 'jsonl';
    } else if (a === '--with-children' || a === '--children') out.withChildren = true;
    else if (a === '--roots' || a === '--roots-only') out.rootsOnly = true;
    else if (a === '--untitled' || a === '--untitled-only') out.untitledOnly = true;
    else if (a === '--clear') out.clearTitle = true;
    else if (a === '--write-source') out.writeSource = true;
    else if (a === '--include-empty') out.includeEmptyReview = true;
    else if (a === '--regex') out.regex = true;
    else if (a === '--build') out.build = true;
    else if (a.startsWith('--grep=')) out.grep = a.slice('--grep='.length);
    else if (a.startsWith('--prompt-count=')) {
      out.promptPreviewCount = Number(a.slice('--prompt-count='.length));
    } else if (a.startsWith('--prompt-chars=')) {
      out.promptPreviewChars = Number(a.slice('--prompt-chars='.length));
    }
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
    } else if (a.startsWith('--ref=')) out.ref = a.slice('--ref='.length);
    else if (a.startsWith('--title=')) out.title = a.slice('--title='.length);
    else if (a.startsWith('--cwd=')) out.cwd = a.slice('--cwd='.length);
    else if (a.startsWith('--parent=')) out.parentId = a.slice('--parent='.length);
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
    else if (a.startsWith('--out=') || a.startsWith('--output=')) {
      out.out = a.includes('--output=')
        ? a.slice('--output='.length)
        : a.slice('--out='.length);
    } else if (a.startsWith('--format=')) {
      const f = a.slice('--format='.length).toLowerCase();
      if (f === 'json' || f === 'jsonl' || f === 'md' || f === 'markdown') {
        out.format = f === 'markdown' ? 'md' : f;
      } else {
        throw new Error(`--format expects json|jsonl|md, got ${f}`);
      }
    } else if (a === '--json') {
      out.format = 'json';
    } else if (a === '--md' || a === '--markdown') {
      out.format = 'md';
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
  list         List sessions (cache default; --live; --parent=; --roots; --cwd=)
  children     List child sessions of --id (cache; alias of list --parent=)
  detail       Session detail live (size flags for Agent context)
  trace        Trajectory skeleton (default no tool I/O)  [alias: timeline]
  tool-errors  Tool error/soft rows for one session
  failures     跨 source 失败汇总 (API 异常 + Tool fail; --days/--start/--end/--source)
  handoff      Cross-agent resume summary (inert)  [alias: resume-summary]
  digest       Multi-session daily digest (roots → handoff 聚合; 默认 --days=1; --format=md)
  resolve      Resolve --ref= / --id= under filters (cwd/source/window)
  prompts      Cached user prompts (单条 --id / 批量 --id=a,b / 窗口批量 + --jsonl)
  set-title    Cache overlay title (Agent/user; sync-safe)
  title-review Review title candidates: title + prompt count + truncated prompts
  stats        Aggregate counts / tokens (cache; P0 window clip + quality)
  scan         跨 session prompt 检索 (缓存 prompts 表, cache-first)
  tool-calls   跨 session tool call 导出 jsonl (--build 物化 / --live 直读)
  sync         Incremental sync → SQLite
  refs         listRefs only
  help

Agent trajectory (issue #1):
  list --source=kimi --days=3 --limit=20
  children --source=kimi --id=<parent>
  trace --source=kimi --id=<id>                 # skeleton
  trace --source=kimi --id=<id> --io --tool=Bash
  trace --source=kimi --id=<id> --format=md --out=trace.md
  tool-errors --source=kimi --id=<id> --status=hard
  detail --source=kimi --id=<id> --tools-only --max-output-chars=500
  detail --source=kimi --id=<id> --from=0 --to=5 --no-reasoning
  stats --source=all --days=7                   # clipped totals + quality

Cross-agent handoff (issue #4):
  # resume brief (not full transcript) — defaults: user/goal 500, last_assistant 3000
  list --cwd=. --days=7 --roots --limit=20
  resolve --source=grok --cwd=. --ref=latest
  resolve --source=all --ref="partial title"
  handoff --source=kimi --id=<id>
  handoff --source=grok --cwd=. --ref=latest
  handoff --source=claude --ref="fix auth" --format=md --out=handoff.md
  handoff --source=kimi --id=<id> --text-preview=8000   # override both caps
  # need tool I/O / full messages → detail (not handoff)

Multi-session digest (自动化 memory 聚合; 默认 roots-only + 当天):
  digest                                  # 今日 roots digest (JSON)
  digest --days=7 --source=all --limit=30
  digest --cwd=. --format=md --out=digest.md   # 按 project 分组, 可 append 到 memory
  digest --text-preview=800               # 覆盖 goal/stop/next 截断 cap

Content scan (issue #7 方向 H; prompt 走缓存需先 sync):
  scan --grep='kimi -p' --days=90                      # 7 CLI 入口归因 (prompt 侧)
  scan --grep='parent_id' --regex --limit=10
  # --limit=N 命中 session 数上限 (默认 20); --max-output-chars=N preview 长度 (默认 200)

Tool calls export (数据出口与检索解耦; jsonl 每行自含 session 归因, 落盘后 grep/jq/python 接管):
  tool-calls --build --days=90                         # live 提取物化 (增量, 已 built 且未过期的 session 跳过)
  tool-calls --days=90 --out=tc.jsonl                  # cache-first 导出 jsonl
  tool-calls --days=14 --tool=Bash | grep 'grok -m'    # 管道直查
  tool-calls --days=7 --live --io --max-output-chars=500   # 跳过物化表 live 直读 + 附 output preview
  # 默认 cache-first (先 --build); --limit=N 行上限 (默认 5000); --format=json 包装数组

Custom title (cache overlay; sync-safe):
  list --untitled --days=7 --roots
  title-review --days=7 --roots            # Agent 判断依据: title + prompts
  prompts --source=kimi --id=<id>
  prompts --source=kimi --id=a,b,c         # 同 source 批量 (逗号分隔 id)
  prompts --source=kimi --days=7 --roots --limit=20   # 窗口批量 (默认 7 天; --jsonl 每行一条)
  set-title --source=kimi --id=<id> --title="知乎爬虫评审"
  set-title --source=opencode --id=ses_xxx --title="..." --write-source
  set-title --source=kimi --id=<id> --clear

Options:
  --source=NAME       all|${ALL_SOURCES.join('|')}
  --days=N --start= --end=
  --id=SESSION        detail/trace/tool-errors/prompts/children/handoff (prompts 支持逗号批量)
  --prompts=SRC:ID    prompts legacy: source:sessionId (逗号分隔多 spec)
  --ref=REF           handoff/resolve: latest|id|path|title substring
  --cwd=PATH          list/handoff/resolve: filter by project path
  --parent=SESSION    list children of parent
  --roots             list top-level only (no parent_id)
  --untitled          list: weak source title and no custom_title
  --title=TEXT        set-title
  --clear             set-title: remove custom_title
  --write-source      set-title: also write OpenCode source DB
  --prompt-count=N    title-review: preview prompt count per session (default 3)
  --prompt-chars=N    title-review: preview chars per prompt (default 300)
  --include-empty     title-review: also list sessions with no prompts
  --limit=N --offset=N
  --live              list: live convert
  --full-fields       list/detail info: full objects
  --no-messages       detail: skip messages
  --with-children     detail/trace/handoff: attach children from cache
  --tools-only        detail: tool(+step) parts only
  --no-reasoning      detail: drop reasoning/thinking parts
  --max-output-chars=N  truncate tool I/O & long text
  --from=N --to=N     message index range
  --io                trace/tool-errors: include tool I/O previews
  --grep=PATTERN      scan: 匹配 pattern (默认大小写不敏感 substring)
  --regex             scan: pattern 按 RegExp (忽略大小写)
  --build             tool-calls: live 提取并物化 (增量)
  --tool=NAME --status=STATUS  tool-calls/filter tools (error|soft|hard|completed)
  --reasoning         trace: include reasoning_preview
  --tool=NAME --status=STATUS  filter tools (error|soft|hard|completed)
  --text-preview=N    handoff: override user+assistant caps (default 500/3000);
                      trace: text_preview length
  --max-steps=N
  --jsonl             trace: one JSON object per line; prompts 批量: 每行一个 session
  --format=json|jsonl|md   export format (trace/handoff; default json)
  --out=PATH          write export to file (format from ext if unset)
  --full --reconcile  sync
  --db=PATH --meta=PATH
  --raw               single-line JSON
  -h, --help

Env: AI_CODING_SESSIONS_DB / AI_CODING_SESSIONS_META
`);
}

function resolveExportFormat(args: CliArgs, fallback: TraceExportFormat = 'json'): TraceExportFormat {
  if (args.format) return args.format;
  if (args.jsonl) return 'jsonl';
  if (args.out) return inferTraceFormat(args.out, fallback);
  return fallback;
}

/** 写 --out 或 stdout；有 out 时 stdout 回执 {ok,out,bytes,format} */
function emitExport(
  body: string,
  args: CliArgs,
  format: TraceExportFormat,
  meta?: Record<string, unknown>,
) {
  if (args.out) {
    writeFileSync(args.out, body, 'utf8');
    printJson(
      {
        ok: true,
        out: args.out,
        bytes: Buffer.byteLength(body, 'utf8'),
        format,
        ...(meta || {}),
      },
      args.pretty,
    );
    return;
  }
  process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
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
    source_title: s.source_title ?? null,
    title_is_custom: s.title_is_custom ?? null,
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

// 约束与 overlaySessionDetail / getSessionDetail 对齐，避免泛型 T 与返回类型不兼容
async function overlayLiveDetail<T extends UnifiedSessionDetail | null>(
  args: CliArgs,
  detail: T,
): Promise<T> {
  if (!detail) return detail;
  await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
  try {
    return await overlaySessionDetail(detail);
  } finally {
    closeStoreDb();
  }
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
  const cwd = args.cwd;

  if (args.live) {
    await initAiCodingStats();
    try {
      const result = await listSessions({
        source: args.source,
        startDate,
        endDate,
      });
      let sessions = result.sessions;
      await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
      try {
        sessions = applyCustomTitles(sessions);
      } finally {
        closeStoreDb();
      }
      if (parentId) {
        sessions = sessions.filter((s) => (s.parent_id ?? null) === parentId);
      } else if (args.rootsOnly) {
        sessions = sessions.filter((s) => s.parent_id == null || s.parent_id === '');
      }
      if (cwd) sessions = filterSessionsByCwd(sessions, cwd);
      if (args.untitledOnly) {
        sessions = sessions.filter((s) => !s.title_is_custom && isWeakTitle(s.source_title ?? s.title));
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
          cwd: cwd ?? null,
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
      cwd,
      untitledOnly: args.untitledOnly,
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
        cwd: cwd ?? null,
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

/** 加载候选 sessions（cache；供 resolve/handoff） */
async function loadCandidateSessions(args: CliArgs): Promise<{
  sessions: UnifiedSessionInfo[];
  startDate?: string;
  endDate?: string;
  mode: 'cache';
}> {
  const { startDate, endDate } = resolveWindow(args);
  await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
  try {
    const result = queryCached({
      source: args.source,
      startDate,
      endDate,
      parentId: args.parentId,
      rootsOnly: args.rootsOnly,
      cwd: args.cwd,
      // resolve 需要全量候选后再 limit；handoff 同理
    });
    return { sessions: result.sessions, startDate, endDate, mode: 'cache' };
  } finally {
    closeStoreDb();
  }
}

function printResolveFailure(result: Extract<ResolveResult, { ok: false }>, pretty: boolean) {
  printJson(
    {
      ok: false,
      error: result.error,
      reference: result.reference,
      message: result.message,
      matches: result.error === 'ambiguous' ? result.matches : undefined,
    },
    pretty,
  );
  process.exitCode = result.error === 'ambiguous' ? 2 : 1;
}

async function cmdResolve(args: CliArgs) {
  const { sessions, startDate, endDate } = await loadCandidateSessions(args);
  const ref = args.id || args.ref || 'latest';
  const result = resolveSessionRef(sessions, ref, { preferRoots: !args.id && !args.parentId });

  if (!result.ok) {
    printResolveFailure(result, args.pretty);
    return;
  }

  printJson(
    {
      ok: true,
      match: result.match,
      reference: ref,
      cwd: args.cwd ?? null,
      source_filter: args.source,
      startDate: startDate ?? null,
      endDate: endDate ?? null,
      candidates: sessions.length,
      session: args.compact ? compactSession(result.session) : result.session,
    },
    args.pretty,
  );
}

async function cmdHandoff(args: CliArgs) {
  // 1) resolve id+source
  let source: SourceId;
  let id: string;
  let matchKind: string | null = null;

  if (args.id && args.source !== 'all') {
    source = args.source;
    id = args.id;
    matchKind = 'id';
  } else {
    const { sessions } = await loadCandidateSessions(args);
    const ref = args.id || args.ref || 'latest';
    const resolved = resolveSessionRef(sessions, ref, {
      preferRoots: !args.id && !args.parentId,
    });
    if (!resolved.ok) {
      printResolveFailure(resolved, args.pretty);
      return;
    }
    if (!isSourceId(String(resolved.session.source))) {
      printJson(
        {
          ok: false,
          error: 'invalid_source',
          message: `resolved session has invalid source: ${resolved.session.source}`,
        },
        args.pretty,
      );
      process.exitCode = 1;
      return;
    }
    source = resolved.session.source as SourceId;
    id = resolved.session.id;
    matchKind = resolved.match;
  }

  await initAiCodingStats();
  try {
    const detail = await overlayLiveDetail(
      args,
      await getSessionDetail({ sessionId: id, source }),
    );
    if (!detail) {
      printJson({ ok: false, error: 'not_found', source, id }, args.pretty);
      process.exitCode = 1;
      return;
    }

    const handoff = buildHandoff(detail, {
      // 未传 --text-preview 时：user/goal 500、assistant 3000（见 buildHandoff）
      ...(args.textPreview != null ? { textPreview: args.textPreview } : {}),
    });
    if (!handoff) {
      printJson({ ok: false, error: 'handoff_failed', source, id }, args.pretty);
      process.exitCode = 1;
      return;
    }

    if (args.withChildren) {
      await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
      try {
        (handoff as any).children = loadChildrenFromCache(source, id, true);
      } finally {
        closeStoreDb();
      }
    }

    const format = resolveExportFormat(args, 'json');
    const payload = {
      ok: true,
      match: matchKind,
      ...handoff,
    };

    if (format === 'md') {
      const md = formatHandoffMarkdown(handoff);
      emitExport(md, args, 'md', { source, id });
      return;
    }

    if (args.out) {
      const body = args.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
      emitExport(body.endsWith('\n') ? body : `${body}\n`, args, 'json', { source, id });
      return;
    }
    printJson(payload, args.pretty);
  } finally {
    closeAiCodingStats();
  }
}

async function cmdChildren(args: CliArgs) {
  const id = requireId(args, 'children');
  // children = list --parent=id
  args.parentId = id;
  args.id = undefined;
  await cmdList(args);
}

/**
 * 多 session digest：cache roots → 逐个 live detail + buildHandoff → 按 project 分组。
 * 机械聚合、零 LLM；--format=md 可直接 append 到日度 memory 文件。
 */
async function cmdDigest(args: CliArgs) {
  // digest 默认窗口 = 当天（list 默认全量，对 digest 无意义）
  if (!args.startDate && !args.endDate && args.days == null) args.days = 1;
  const { startDate, endDate } = resolveWindow(args);

  let sessions: UnifiedSessionInfo[];
  await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
  try {
    const result = queryCached({
      source: args.source,
      startDate,
      endDate,
      parentId: args.parentId,
      // digest 默认只 roots（subagent 会刷屏）；--parent= 时取其 children
      rootsOnly: args.parentId ? undefined : true,
      cwd: args.cwd,
      limit: args.limit ?? 20,
    });
    sessions = result.sessions;
  } finally {
    closeStoreDb();
  }

  await initAiCodingStats();
  try {
    const result = await buildDigest(
      sessions,
      async (s) => {
        if (!isSourceId(String(s.source))) return null;
        return getSessionDetail({ sessionId: s.id, source: s.source as SourceId });
      },
      {
        startDate,
        endDate,
        ...(args.textPreview != null ? { textPreview: args.textPreview } : {}),
      },
    );

    const format = resolveExportFormat(args, 'json');
    if (format === 'md') {
      emitExport(formatDigestMarkdown(result), args, 'md', { digested: result.digested });
      return;
    }
    if (args.out) {
      const body = args.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result);
      emitExport(body.endsWith('\n') ? body : `${body}\n`, args, 'json', {
        digested: result.digested,
      });
      return;
    }
    printJson(result, args.pretty);
  } finally {
    closeAiCodingStats();
  }
}

/** 跨 session prompt 检索 (缓存 prompts 表; tool input 用 tool-calls 导出后自行 grep) */
async function cmdScan(args: CliArgs) {
  if (!args.grep) throw new Error('scan requires --grep=<pattern>');
  // 默认窗口 7 天 (90d 归因需显式 --days=90)
  if (!args.startDate && !args.endDate && args.days == null) args.days = 7;
  const { startDate, endDate } = resolveWindow(args);

  await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
  try {
    const { sessions } = queryCached({
      source: args.source,
      startDate,
      endDate,
      rootsOnly: args.rootsOnly || undefined,
      cwd: args.cwd,
    });

    const result = scanSessions(
      sessions,
      { pattern: args.grep, regex: args.regex, maxChars: args.maxOutputChars },
      {
        getPrompts: (s) => {
          if (!isSourceId(String(s.source))) return [];
          return getSessionPrompts(s.source as SourceId, s.id);
        },
      },
    );

    // --limit 截命中 session 数 (默认 20)
    const limit = args.limit ?? 20;
    const output = { ...result, matches: result.matches.slice(0, limit), truncated: result.matched > limit };
    printJson(output, args.pretty);
  } finally {
    closeStoreDb();
  }
}

/**
 * 跨 session tool call 导出 (jsonl 流, 数据出口与检索解耦):
 * 默认 cache-first 读物化表; --build live 提取物化 (增量); --live 仅本次 live 直读。
 * 导出行自含 session 归因字段, 落盘后 grep/jq/python 随意。
 */
async function cmdToolCalls(args: CliArgs) {
  if (!args.startDate && !args.endDate && args.days == null) args.days = 7;
  const { startDate, endDate } = resolveWindow(args);

  await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
  const { sessions } = queryCached({
    source: args.source,
    startDate,
    endDate,
    rootsOnly: args.rootsOnly || undefined,
    cwd: args.cwd,
  });

  // ---- build: live 提取 → 物化表 (session 级增量, last_active 晚于 built_at 才重提) ----
  if (args.build) {
    await initAiCodingStats();
    try {
      let built = 0;
      let skipped = 0;
      let totalRows = 0;
      for (const s of sessions) {
        if (!isSourceId(String(s.source))) continue;
        const source = s.source as SourceId;
        const lastActiveMs = s.last_active_at_iso ? Date.parse(s.last_active_at_iso) : 0;
        const builtAt = getToolCallsBuiltAt(source, s.id);
        if (builtAt != null && lastActiveMs <= builtAt) {
          skipped += 1;
          continue;
        }
        const detail = await getSessionDetail({ sessionId: s.id, source });
        const rows = extractToolCalls(detail?.messages);
        totalRows += replaceToolCalls(source, s.id, rows);
        built += 1;
      }
      printJson({ ok: true, build: { sessions: sessions.length, built, skipped, total_rows: totalRows } }, args.pretty);
    } finally {
      closeAiCodingStats();
      closeStoreDb();
    }
    return;
  }

  // ---- 导出 ----
  const maxOutputChars = args.includeIo ? (args.maxOutputChars ?? 300) : undefined;
  const filters = { tool: args.tool, status: args.status };
  const emitRow = (s: UnifiedSessionInfo, row: Record<string, unknown>) =>
    JSON.stringify({ ...toolCallHeader(s), ...row });

  const collect = async (): Promise<string> => {
    const lines: string[] = [];
    let count = 0;
    const limit = args.limit ?? 5000;
    if (args.live) await initAiCodingStats();
    for (const s of sessions) {
      if (!isSourceId(String(s.source))) continue;
      const source = s.source as SourceId;
      let rows: Record<string, unknown>[];
      if (args.live) {
        const detail = await getSessionDetail({ sessionId: s.id, source });
        rows = extractToolCalls(detail?.messages, { tool: args.tool, maxOutputChars }) as any;
        if (args.status) rows = rows.filter((r) => String(r.status) === args.status) as any;
      } else {
        rows = queryToolCallsBySession(source, s.id, filters) as any;
      }
      for (const r of rows) {
        lines.push(emitRow(s, r));
        count += 1;
        if (count >= limit) return lines.join('\n');
      }
    }
    return lines.join('\n');
  };

  try {
    if (args.format === 'json') {
      const all = (await collect()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      printJson({ ok: true, count: all.length, truncated: all.length >= (args.limit ?? 5000), records: all }, args.pretty);
      return;
    }
    const body = await collect();
    if (args.out) {
      writeFileSync(args.out, body ? `${body}\n` : '', 'utf8');
      printJson({ ok: true, out: args.out, bytes: Buffer.byteLength(body, 'utf8'), lines: body ? body.split('\n').length : 0 }, args.pretty);
      return;
    }
    if (body) process.stdout.write(`${body}\n`);
    else console.error('[cli] tool_calls 表为空或窗口无 session; 先 tool-calls --build 物化, 或 --live 直读');
  } finally {
    if (args.live) closeAiCodingStats();
    closeStoreDb();
  }
}

async function cmdDetail(args: CliArgs) {
  const id = requireId(args, 'detail');
  const source = requireOneSource(args, 'detail');

  await initAiCodingStats();
  try {
    const detail = await overlayLiveDetail(
      args,
      await getSessionDetail({ sessionId: id, source }),
    );
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

    // 稳定 prefill/lag：优先 info 上已有聚合，否则从 messages 重算
    const timingFromMsgs = summarizeSessionTimingFromMessages(detail.messages);
    const info = detail.info as UnifiedSessionInfo;
    const timing = {
      avg_latency_ms: info.avg_latency_ms ?? timingFromMsgs.avg_latency_ms ?? null,
      avg_prefill_tps: info.avg_prefill_tps ?? timingFromMsgs.avg_prefill_tps ?? null,
      avg_tps: info.avg_tps ?? timingFromMsgs.avg_tps ?? null,
      source: info.avg_latency_ms != null || info.avg_tps != null || info.avg_prefill_tps != null
        ? 'info'
        : timingFromMsgs.avg_latency_ms != null || timingFromMsgs.avg_tps != null
          ? 'messages'
          : null,
    };

    const payload: Record<string, unknown> = {
      ok: true,
      source,
      id,
      info: args.compact ? compactSession(detail.info) : detail.info,
      editDiffs: detail.editDiffs,
      pricing: detail.pricing ?? null,
      timing,
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
    const detail = await overlayLiveDetail(
      args,
      await getSessionDetail({ sessionId: id, source }),
    );
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

    const turns = summarizeTraceTurns(steps);
    const tool_summary = summarizeTraceTools(steps);
    const timing = summarizeSessionTimingFromMessages(detail.messages);
    const format = resolveExportFormat(args, 'json');

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
      tool_summary,
      turns,
      timing,
      editDiffs: detail.editDiffs,
      options: {
        io: args.includeIo,
        reasoning: args.includeReasoning,
        tool: args.tool ?? null,
        status: args.status ?? null,
        max_output_chars: args.maxOutputChars ?? 400,
        text_preview: args.textPreview ?? 120,
        format,
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

    if (format === 'jsonl') {
      emitExport(formatTraceJsonl(steps), args, 'jsonl', {
        step_count: steps.length,
        source,
        id,
      });
      return;
    }

    if (format === 'md') {
      const md = formatTraceMarkdown(steps, {
        source,
        id,
        title: detail.info?.title ?? null,
        parent_id: detail.info?.parent_id ?? null,
        step_count: steps.length,
        message_count: detail.messages?.length ?? 0,
        tool_summary,
        turns,
        timing,
        options: payload.options as Record<string, unknown>,
      });
      emitExport(md, args, 'md', { step_count: steps.length, source, id });
      return;
    }

    // json
    if (args.out) {
      const body = args.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
      emitExport(body.endsWith('\n') ? body : `${body}\n`, args, 'json', {
        step_count: steps.length,
        source,
        id,
      });
      return;
    }
    printJson(payload, args.pretty);
  } finally {
    closeAiCodingStats();
  }
}

async function cmdToolErrors(args: CliArgs) {
  const id = requireId(args, 'tool-errors');
  const source = requireOneSource(args, 'tool-errors');

  await initAiCodingStats();
  try {
    const detail = await overlayLiveDetail(
      args,
      await getSessionDetail({ sessionId: id, source }),
    );
    if (!detail) {
      printJson({ ok: false, error: 'not_found', source, id }, args.pretty);
      process.exitCode = 1;
      return;
    }

    const errors = collectToolErrors(detail.messages, {
      tool: args.tool,
      status: args.status,
      includeIo: args.includeIo,
      maxOutputChars: args.maxOutputChars ?? 400,
      from: args.from,
      to: args.to,
    });

    const hard = errors.filter((e) => !e.soft).length;
    const soft = errors.filter((e) => e.soft).length;
    const by_tool: Record<string, number> = {};
    for (const e of errors) by_tool[e.name] = (by_tool[e.name] || 0) + 1;

    const payload = {
      ok: true,
      mode: 'tool-errors',
      source,
      id,
      title: detail.info?.title ?? null,
      count: errors.length,
      hard,
      soft,
      by_tool,
      options: {
        tool: args.tool ?? null,
        status: args.status ?? null,
        io: args.includeIo,
      },
      errors,
    };

    const format = resolveExportFormat(args, 'json');
    if (format === 'jsonl') {
      const body = errors.map((e) => JSON.stringify(e)).join('\n') + (errors.length ? '\n' : '');
      emitExport(body, args, 'jsonl', { count: errors.length, source, id });
      return;
    }
    if (format === 'md') {
      const lines = [
        `# Tool errors: ${detail.info?.title || id}`,
        '',
        `- source: \`${source}\` · id: \`${id}\``,
        `- count: ${errors.length} (hard=${hard} soft=${soft})`,
        '',
        '| i | turn | tool | status | soft | preview |',
        '|---|------|------|--------|------|---------|',
        ...errors.map((e) => {
          const prev = (e.error_preview || e.output_preview || '—').replace(/\|/g, '\\|').slice(0, 80);
          return `| ${e.i} | ${e.turn} | ${e.name} | ${e.status} | ${e.soft ? e.soft_kind || 'soft' : '—'} | ${prev} |`;
        }),
        '',
      ];
      emitExport(lines.join('\n'), args, 'md', { count: errors.length, source, id });
      return;
    }

    if (args.out) {
      const body = args.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
      emitExport(body.endsWith('\n') ? body : `${body}\n`, args, 'json', {
        count: errors.length,
        source,
        id,
      });
      return;
    }
    printJson(payload, args.pretty);
  } finally {
    closeAiCodingStats();
  }
}

/** failures: 跨 source 失败事件汇总（API 异常 + Tool Call Fail） */
async function cmdFailures(args: CliArgs) {
  const source = (args.source ?? 'all') as 'all' | 'grok' | 'opencode' | 'kimi';
  const result = await collectSessionFailures({
    days: args.days ?? 14,
    source,
    startDate: args.startDate,
    endDate: args.endDate,
    top: 20,
  });

  const fmtTs = (ts: number) => {
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const format = resolveExportFormat(args, 'json');
  if (format === 'md') {
    const lines = [
      `# Session Failures (${result.range.start} ~ ${result.range.end}, ${result.range.days}d)`,
      '',
      `- total: ${result.total} (api=${result.apiCount} tool=${result.toolCount} soft=${result.softCount}) · sessions: ${result.sessions}`,
      '',
      '## By Source',
      ...(result.bySource.length ? result.bySource.map((r) => `- ${r.key}: ${r.count} (${r.pct.toFixed(1)}%)`) : ['- (empty)']),
      '',
      '## By Tool',
      ...(result.byTool.length ? result.byTool.map((r) => `- ${r.key}: ${r.count} (${r.pct.toFixed(1)}%)`) : ['- (empty)']),
      '',
      '## By Source × Model × Tool',
      ...(result.bySourceModelTool.length
        ? [
            '| source | model | tool | count | % | top error |',
            '|---|---|---|---:|---:|---|',
            ...result.bySourceModelTool.map((r) => {
              const err = (r.topError || '').replace(/\|/g, '\\|').slice(0, 72);
              return `| ${r.source} | ${r.model.replace(/\|/g, '\\|')} | ${r.tool} | ${r.count} | ${r.pct.toFixed(1)}% | ${err} (${r.topErrorCount}) |`;
            }),
          ]
        : ['- (empty)']),
      '',
      ...(result.bash && result.bash.total > 0
        ? [
            '## Bash Failures',
            ...(result.bash.byExitCode.length
              ? ['### Bash · Exit Code', ...result.bash.byExitCode.map((r) => `- ${r.key}: ${r.count} (${r.pct.toFixed(1)}%)`), '']
              : []),
            ...(result.bash.byCmdFamily.length
              ? ['### Bash · Cmd Family', ...result.bash.byCmdFamily.map((r) => `- ${r.key}: ${r.count} (${r.pct.toFixed(1)}%)`), '']
              : []),
            ...(result.bash.byCategory.length
              ? ['### Bash · Category', ...result.bash.byCategory.map((r) => `- ${r.key}: ${r.count} (${r.pct.toFixed(1)}%)`), '']
              : []),
            ...(result.bash.byModel.length
              ? ['### Bash · Model', ...result.bash.byModel.map((r) => `- ${r.key}: ${r.count} (${r.pct.toFixed(1)}%)`), '']
              : []),
            ...(result.bash.byCommand.length
              ? ['### Bash · Command', ...result.bash.byCommand.map((r) => `- ${r.key.replace(/\|/g, '\\|')}: ${r.count} (${r.pct.toFixed(1)}%)`), '']
              : []),
            ...(result.bash.samples.length
              ? [
                  '### Bash Samples',
                  ...result.bash.samples.map((s) => {
                    // cmdFamily/command 为 null 时（无 raw command）不展示占位
                    const cat = s.category ?? '?';
                    const fam = s.cmdFamily ?? '(no-cmd)';
                    const cmd = s.command ?? '(no-cmd)';
                    return `- [${s.time}] ${s.source} | ${s.model} | exit=${s.exitCode} | ${cat} | \`${fam}\`\n  $ ${cmd}\n  > ${s.error}`;
                  }),
                ]
              : []),
            '',
          ]
        : []),
      '## API Failures',
      ...(result.apiFailures.length
        ? result.apiFailures.slice(0, 15).map((e) =>
          `- [${fmtTs(e.ts)}] ${e.source} ${e.model ?? '?'} stop=${e.stopReason ?? '?'}${e.statusCode ? ` http=${e.statusCode}` : ''} \`${e.error}\``)
        : ['- (none)']),
      '',
      '## Samples',
      ...(result.samples.length
        ? result.samples.slice(0, 10).map((e) =>
          `- [${fmtTs(e.ts)}] ${e.source} ${e.kind === 'tool' ? `tool \`${e.toolName}\`` : 'API'} ${e.sessionId.slice(0, 8)} \`${e.error}\``)
        : ['- (none)']),
      '',
    ];
    emitExport(lines.join('\n'), args, 'md', { total: result.total, source });
    return;
  }
  printJson(result, args.pretty);
}

async function cmdSetTitle(args: CliArgs) {
  const source = requireOneSource(args, 'set-title');
  const id = requireId(args, 'set-title');
  if (args.clearTitle && args.title) {
    throw new Error('set-title: use either --title= or --clear, not both');
  }
  if (!args.clearTitle && args.title == null) {
    throw new Error('set-title requires --title=... or --clear');
  }

  await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
  try {
    const result = setSessionTitle(source, id, args.clearTitle ? null : args.title ?? null);
    const body: Record<string, unknown> = { ...result };

    if (args.writeSource) {
      if (args.clearTitle) {
        body.write_source = { ok: false, skipped: true, reason: 'clear does not write source' };
      } else if (source !== 'opencode') {
        body.write_source = {
          ok: false,
          skipped: true,
          reason: `write-source only supports opencode (got ${source})`,
        };
      } else if (!result.ok || !result.custom_title) {
        body.write_source = { ok: false, skipped: true, reason: 'cache write failed' };
      } else {
        await initOpencodeDb();
        const ok = updateSessionTitle(id, result.custom_title);
        body.write_source = { ok, source: 'opencode', id };
        if (!ok) process.exitCode = 1;
      }
    }

    if (!result.ok) process.exitCode = 1;
    printJson(body, args.pretty);
  } finally {
    closeStoreDb();
  }
}

/**
 * prompts 批量判定：
 *  - --prompts=src:id1,src:id2       多 spec（逗号分隔）
 *  - --id=a,b(同 source)             多 id
 *  - 以上均未给                  → 窗口批量（--days/--roots/--limit, 默认 7 天）
 *  单条（无逗号）返回 null，走原 cmdPrompts 单条逻辑
 */
function buildPromptsBatch(args: CliArgs): ListSessionPromptsOptions | null {
  if (args.promptsSpec) {
    if (!args.promptsSpec.includes(',')) return null;
    return {
      ids: args.promptsSpec.split(',').map((spec) => {
        const { source, sessionId } = parsePromptsSpec(spec.trim());
        return { source, id: sessionId };
      }),
    };
  }
  if (args.id) {
    if (!args.id.includes(',')) return null;
    const source = requireOneSource(args, 'prompts');
    return {
      ids: args.id.split(',').map((id) => ({ source, id: id.trim() })),
    };
  }
  // 窗口批量：无显式 id → 与 scan/tool-calls 一致默认 7 天
  if (!args.startDate && !args.endDate && args.days == null) args.days = 7;
  const { startDate, endDate } = resolveWindow(args);
  return {
    source: args.source,
    startDate,
    endDate,
    rootsOnly: args.rootsOnly || undefined,
    cwd: args.cwd,
    limit: args.limit,
    offset: args.offset,
  };
}

async function cmdPrompts(args: CliArgs) {
  await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
  try {
    const batch = buildPromptsBatch(args);
    if (batch) {
      const { sessions, total, skipped } = listSessionPrompts(batch);
      if (args.jsonl) {
        // 流式：每行一个 session 条目，管道 grep/jq 接管
        for (const s of sessions) console.log(JSON.stringify(s));
        return;
      }
      printJson({ count: sessions.length, total, skipped, sessions }, args.pretty);
      return;
    }

    // 单条模式
    let source: SourceId;
    let sessionId: string;
    if (args.promptsSpec) {
      ({ source, sessionId } = parsePromptsSpec(args.promptsSpec));
    } else {
      sessionId = requireId(args, 'prompts');
      source = requireOneSource(args, 'prompts');
    }
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

/** 标题审查候选：当前标题 + prompt count + truncated prompts（Agent 判断是否需重写标题） */
async function cmdTitleReview(args: CliArgs) {
  const { startDate, endDate } = resolveWindow(args);
  await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
  try {
    const result = listTitleReview({
      source: args.source,
      startDate,
      endDate,
      rootsOnly: args.rootsOnly,
      promptPreviewCount: args.promptPreviewCount,
      promptPreviewChars: args.promptPreviewChars,
      includeEmpty: args.includeEmptyReview,
      limit: args.limit,
      offset: args.offset,
    });
    printJson(
      {
        mode: 'cache',
        total: result.total,
        returned: result.sessions.length,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        sessions: result.sessions,
        note: 'Agent 依据 title + prompt_count + prompts_preview 判断是否需重写;需改则 set-title --source=<s> --id=<id> --title=...',
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
    // list overlap 过滤 session；token 再按 usage_by_day 窗口裁剪（issue #2）
    const result = queryCached({
      source: args.source,
      startDate,
      endDate,
      parentId: args.parentId,
      rootsOnly: args.rootsOnly,
    });

    const stats = computeCliStats(result.sessions, {
      startDate,
      endDate,
      topFail: args.limit ?? 10,
    });
    const meta = loadMeta(paths.metaPath);
    const dbStats = countStats();

    printJson(
      {
        mode: 'cache',
        source: args.source,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        sessions: stats.sessions,
        clipped: stats.clipped,
        window: stats.window,
        split: stats.split,
        quality: stats.quality,
        bySource: stats.bySource,
        bySourceDetail: stats.bySourceDetail,
        by_model: stats.by_model,
        totals: stats.totals,
        tokensByDay: stats.tokensByDay,
        costByDay: stats.costByDay,
        tool_fail: stats.tool_fail,
        store: {
          paths,
          meta_last_sync_at: meta.last_sync_at ?? null,
          db_stats: dbStats,
        },
        note:
          'P0 clip+split+quality (#2); P1 by_model/cost/costByDay/tool_fail (#3). No host model-normalize.',
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
    case 'tool-errors':
      await cmdToolErrors(args);
      break;
    case 'failures':
      await cmdFailures(args);
      break;
    case 'handoff':
    case 'resume-summary':
      await cmdHandoff(args);
      break;
    case 'digest':
      await cmdDigest(args);
      break;
    case 'resolve':
      await cmdResolve(args);
      break;
    case 'prompts':
      await cmdPrompts(args);
      break;
    case 'set-title':
      await cmdSetTitle(args);
      break;
    case 'title-review':
      await cmdTitleReview(args);
      break;
    case 'stats':
      await cmdStats(args);
      break;
    case 'scan':
      await cmdScan(args);
      break;
    case 'tool-calls':
      await cmdToolCalls(args);
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
