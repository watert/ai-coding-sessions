/**
 * 同步 / 对账 CLI
 *
 *   bun packages/ai-coding-sessions/src/store/cli.ts --days=7 --source=all
 *   bun packages/ai-coding-sessions/src/store/cli.ts --days=7 --source=claude --reconcile
 *   bun packages/ai-coding-sessions/src/store/cli.ts --full --source=opencode
 *   bun packages/ai-coding-sessions/src/store/cli.ts --refs-only --source=all
 *
 * env: AI_CODING_SESSIONS_DB / AI_CODING_SESSIONS_META
 */

import { ALL_SOURCES, isSourceId, type SourceId } from './schema';
import { syncSessions, reconcileSessions } from './sync';
import { listRefs } from './list-refs';
import { initStoreDb, closeStoreDb } from './db';
import { initAiCodingStats, closeAiCodingStats } from '../sources/index';
import { queryCached, getSessionPrompts } from './query';
import { countStats } from './upsert';
import { loadMeta } from './meta';

function parseArgs(argv: string[]) {
  const out: {
    days?: number;
    source: SourceId | 'all';
    full: boolean;
    reconcile: boolean;
    refsOnly: boolean;
    prompts?: string; // source:sessionId
    dbPath?: string;
    metaPath?: string;
    help: boolean;
  } = {
    source: 'all',
    full: false,
    reconcile: false,
    refsOnly: false,
    help: false,
  };

  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--full') out.full = true;
    else if (a === '--reconcile') out.reconcile = true;
    else if (a === '--refs-only') out.refsOnly = true;
    else if (a.startsWith('--days=')) out.days = Number(a.slice('--days='.length));
    else if (a.startsWith('--source=')) {
      const s = a.slice('--source='.length);
      if (s === 'all' || isSourceId(s)) out.source = s;
      else throw new Error(`invalid --source=${s}; use all|${ALL_SOURCES.join('|')}`);
    } else if (a.startsWith('--db=')) out.dbPath = a.slice('--db='.length);
    else if (a.startsWith('--meta=')) out.metaPath = a.slice('--meta='.length);
    else if (a.startsWith('--prompts=')) out.prompts = a.slice('--prompts='.length);
  }
  return out;
}

function usage() {
  console.log(`ai-coding-sessions store CLI (M3)

Usage:
  bun src/store/cli.ts [options]

Options:
  --days=N          sync window (default 7); ignored with --full
  --source=NAME     all|claude|opencode|kimi|grok|codex|zcode|workbuddy
  --full            full rebuild window + orphan mark
  --reconcile       after sync, compare cache vs live
  --refs-only       only listRefs (no convert/write)
  --prompts=src:id  dump cached prompts for one session
  --db=PATH         override sqlite path
  --meta=PATH       override meta json path
  -h, --help

Env:
  AI_CODING_SESSIONS_DB
  AI_CODING_SESSIONS_META
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  if (args.refsOnly) {
    await initAiCodingStats();
    try {
      const since = args.full
        ? undefined
        : Date.now() - (args.days ?? 7) * 86400000;
      const refs = await listRefs({ source: args.source, since });
      console.log(JSON.stringify({ count: refs.length, refs: refs.slice(0, 50), truncated: refs.length > 50 }, null, 2));
    } finally {
      closeAiCodingStats();
    }
    return;
  }

  if (args.prompts) {
    const [source, ...rest] = args.prompts.split(':');
    const sessionId = rest.join(':');
    if (!isSourceId(source) || !sessionId) {
      throw new Error('--prompts expects source:sessionId');
    }
    await initStoreDb({ dbPath: args.dbPath, metaPath: args.metaPath });
    try {
      const rows = getSessionPrompts(source, sessionId);
      console.log(JSON.stringify({ source, sessionId, count: rows.length, prompts: rows }, null, 2));
    } finally {
      closeStoreDb();
    }
    return;
  }

  console.error(`[cli] sync source=${args.source} days=${args.days ?? 7} full=${args.full}`);
  const result = await syncSessions({
    days: args.days,
    source: args.source,
    full: args.full,
    dbPath: args.dbPath,
    metaPath: args.metaPath,
    closeAfter: false,
  });

  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        paths: result.paths,
        duration_ms: result.duration_ms,
        totals: result.totals,
        stats: result.stats,
        bySource: result.bySource,
      },
      null,
      2,
    ),
  );

  if (args.reconcile) {
    console.error('[cli] reconcile…');
    const rec = await reconcileSessions({
      days: args.days,
      source: args.source,
      full: args.full,
      dbPath: args.dbPath,
      metaPath: args.metaPath,
      closeAfter: false,
    });
    console.log(JSON.stringify({ reconcile: rec }, null, 2));
    if (!rec.ok) process.exitCode = 2;
  }

  // 抽样缓存
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
