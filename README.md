# ai-coding-sessions

**MIT** · Multi-source AI coding session list / detail / SQLite cache.

Read-only aggregation of local CLI session data (Claude Code, OpenCode, Kimi, Grok Build, Codex, ZCode, WorkBuddy) into one OpenCode-shaped protocol. No cloud, no account, no telemetry.

```
local CLI data (SQLite / JSONL / wire / logs)
        │
        ▼
  sources/*   list · convert · detail(live)
  store/*     sync → sessions + prompts + usage_by_day
  core/*      isomorphic stats + static price table
        │
        ▼
  your host (CLI / API / Web)  ·  optional configurePricing()
```

## Status

| Item | Notes |
|------|--------|
| License | MIT |
| Runtime | **Bun ≥ 1.2** preferred (`bun:sqlite`); Node via optional `better-sqlite3` |
| Network | None required for list/detail/sync |
| Host coupling | **None** — pure package, no private monorepo imports |
| npm | Source-first; install from git or path (see below) |

## Install

```bash
# git
bun add git+https://github.com/watert/ai-coding-sessions.git

# monorepo path
bun add ./packages/ai-coding-sessions
```

Requires [Bun](https://bun.sh). Peer data must already exist under each CLI’s default home paths (see [Sources](#sources)).

## Library API

### Live list / detail

```ts
import {
  initAiCodingStats,
  closeAiCodingStats,
  listSessions,
  getSessionDetail,
} from 'ai-coding-sessions';

await initAiCodingStats();

const { sessions, total, bySource } = await listSessions({
  source: 'all',           // or claude|opencode|kimi|grok|codex|zcode|workbuddy
  startDate: '2026-07-01', // optional YYYY-MM-DD
  endDate: '2026-07-31',
});

const detail = await getSessionDetail({
  sessionId: sessions[0].id,
  source: sessions[0].source,
});
// detail.info · detail.messages · detail.editDiffs · detail.pricing?

closeAiCodingStats();
```

### SQLite cache (recommended for large history)

```ts
import {
  syncSessions,
  queryCached,
  getSessionPrompts,
  ensureFresh,
  countStats,
} from 'ai-coding-sessions';

// incremental window (default 7 days)
await syncSessions({ days: 7, source: 'all', reconcile: false });

const cached = queryCached({ source: 'kimi', startDate: '2026-07-01', limit: 50 });
const prompts = getSessionPrompts('kimi', cached.sessions[0].id);

// host APIs often call ensureFresh before queryCached
await ensureFresh({ maxAgeMs: 6 * 3600_000 });
console.log(countStats());
```

Default paths (override with env or options):

| | Default |
|--|---------|
| SQLite | `~/data/ai-coding-sessions.sqlite` |
| Meta | `~/data/ai-coding-sessions.meta.json` |
| Env | `AI_CODING_SESSIONS_DB` / `AI_CODING_SESSIONS_META` |

**Caching policy**

- List rows + full user **prompts** + **usage_by_day** → SQLite
- Session **detail / messages** → always live (not cached)
- `session.pricing` is **not** stored; cache keeps `usage_by_model` so hosts can reprice without resync
- Orphans are marked, never hard-deleted

### Pricing hooks

Out of the box, dynamic AUTO pricing returns `{ usd: 0, cny: 0 }` unless the host injects implementations. A static table still ships under `ai-coding-sessions/core` for simple estimates.

```ts
import { configurePricing } from 'ai-coding-sessions';
import {
  AI_MODEL_PRICING_TABLE,
  calculateCost,
  USD_TO_CNY_RATE,
} from 'ai-coding-sessions/core';

// minimal static wiring example — replace with models.dev in production hosts
configurePricing({
  getUsdToCnyRate: () => USD_TO_CNY_RATE,
  calculateMessageCost: (input) => {
    // map input.modelID → table row, then calculateCost(...)
    return { totalCost: 0, cny: 0 };
  },
});
```

### Core (isomorphic, no fs/sqlite)

```ts
import {
  getOverallStats,
  AI_MODEL_PRICING_TABLE,
  calculateCost,
  formatCompact,
} from 'ai-coding-sessions/core';
```

## Store CLI

Sync / reconcile / dump prompts. Analysis-oriented subcommands (tool errors, prompt perf, weekly export) live in **host** projects today; this package CLI is intentionally cache-focused.

```bash
# from package root
bun src/store/cli.ts --days=7 --source=all --reconcile
bun src/store/cli.ts --full --source=opencode
bun src/store/cli.ts --refs-only --source=claude
bun src/store/cli.ts --prompts=kimi:<sessionId>
bun src/store/cli.ts --help

# monorepo
bun packages/ai-coding-sessions/src/store/cli.ts --days=7 --source=all --reconcile
```

| Flag | Meaning |
|------|---------|
| `--days=N` | Sync window (default 7); ignored with `--full` / `--start` |
| `--start=` / `--end=` | `YYYY-MM-DD` window |
| `--source=` | `all` or one of the 7 sources |
| `--full` | Full rebuild window + orphan mark |
| `--reconcile` | After sync, compare cache vs live |
| `--refs-only` | `listRefs` only (no convert/write) |
| `--prompts=src:id` | Dump cached prompts JSON |
| `--db=` / `--meta=` | Override store paths |

npm scripts: `bun run sync` · `bun run sync:reconcile`.

## Sources

| Source | Local data (defaults) | Notes |
|--------|----------------------|--------|
| `opencode` | OpenCode SQLite (`opencode db path`) | Full fidelity |
| `claude` | `~/.claude/` history + project JSONL | Subagents under session dirs |
| `kimi` | `~/.kimi-code/` index + wire.jsonl | Virtual subagent sessions |
| `grok` | `~/.grok/sessions/` | Real usage when present; else `usage_source=estimate` |
| `codex` | `~/.codex/` state sqlite + rollout JSONL | |
| `zcode` | `~/.zcode/cli/db/db.sqlite` | |
| `workbuddy` | `~/.workbuddy/workbuddy.db` + project JSONL | |

Missing source dirs are skipped with a warning (other sources still work).

Unified session fields (subset): `id`, `title`, `source`, `parent_id`, `spawn_group_id`, token totals, `avg_tps` / `avg_latency_ms`, `session_status`, `usage_by_model`, `usage_by_day`, `bashSignals`, `deliverableSignals`, optional `pricing`.

## Dependencies

**No private / monorepo dependencies.** npm runtime deps (all permissive):

| Package | License | Role |
|---------|---------|------|
| `dayjs` | MIT | Dates |
| `lodash` | MIT | Utilities |
| `zod` | MIT | Schemas (OpenCode / Claude / Kimi) |
| `debug` | MIT | Debug logs (`DEBUG=…`) |
| `diff` | BSD-3-Clause | Edit diff (Kimi) |
| `better-sqlite3` | MIT | **Optional** — Node fallback when `bun:sqlite` unavailable |

Runtime I/O is local filesystem + SQLite only. Optional host may fetch [models.dev](https://models.dev) for live prices; that is **not** required by this package.

## Scripts

```bash
bun test src          # unit tests
bun run check         # tsc --noEmit
bun run sync          # store CLI
bun run sync:reconcile
```

## Package layout

```
src/
  core/       isomorphic protocol, static pricing, list preview
  sources/    7 adapters + listSessions / getSessionDetail
  store/      schema, sync, queryCached, CLI
  lib/        sqlite, jsonl-cache, date-utils, timing-stats
  pricing.ts  configurePricing hooks
  index.ts    Node entry
core.ts       re-export → src/core (legacy path)
```

Exports:

- `ai-coding-sessions` — Node entry
- `ai-coding-sessions/core` — isomorphic
- `ai-coding-sessions/pricing` — hooks only

## License

[MIT](./LICENSE) © 2026 waterwu

Third-party packages keep their own licenses (MIT / BSD-3-Clause as above).

## Related (host-only, not in this repo)

Production hosts may add: REST (`/api/ai-coding/*`), Web sessions UI, token-stats dashboard, `export-weekly-prompts`, `analyze-tool-errors`, `analyze-prompt-perf`, models.dev bridge. Those are **out of scope** for this package.
