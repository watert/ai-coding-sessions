# ai-coding-sessions

**English** · [中文](./README.zh.md)

**MIT** · Multi-source AI coding session list / detail / SQLite cache.

Read-only aggregation of local CLI / Desktop session data (Claude Code, OpenCode, Kimi, Grok Build, Codex, ZCode, WorkBuddy, Cursor) into one OpenCode-shaped protocol. No cloud, no account, no telemetry.

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
| Paths / Windows | `path.join` + `pathToFileURL` readonly SQLite; env roots (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, …); CRLF-safe jsonl. **Still Bun-first** — not full Win CI ([#6](https://github.com/watert/ai-coding-sessions/issues/6)) |
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

Requires [Bun](https://bun.sh). Peer data must already exist under each CLI’s default home paths (see [Supported Sources](#supported-sources)).

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
  source: 'all',           // or claude|opencode|kimi|grok|codex|zcode|workbuddy|cursor
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

## CLI (Agent-friendly)

Default: **JSON on stdout** (logs on stderr). Designed for AI Agents to **list → trace skeleton → dig detail**.

Trajectory design notes: [issue #1](https://github.com/watert/ai-coding-sessions/issues/1).

```bash
# from package root (or: bun run cli …)
bun src/store/cli.ts list --source=kimi --days=3 --limit=20
bun src/store/cli.ts list --source=kimi --roots --days=7
bun src/store/cli.ts list --cwd=. --days=7 --roots --limit=20
bun src/store/cli.ts children --source=kimi --id=<parentSessionId>
bun src/store/cli.ts resolve --source=grok --cwd=. --ref=latest
bun src/store/cli.ts handoff --source=grok --cwd=. --ref=latest       # cross-agent resume brief (not full transcript)
bun src/store/cli.ts handoff --source=kimi --id=<id> --format=md --out=handoff.md
# defaults: user/goal 500 chars, last_assistant_action 3000; override both with --text-preview=N
bun src/store/cli.ts trace --source=kimi --id=<id>                    # skeleton (~KB)
bun src/store/cli.ts trace --source=kimi --id=<id> --io --tool=Bash
bun src/store/cli.ts trace --source=kimi --id=<id> --jsonl --max-steps=30
bun src/store/cli.ts trace --source=kimi --id=<id> --format=md --out=trace.md
bun src/store/cli.ts tool-errors --source=kimi --id=<id> --status=hard
bun src/store/cli.ts detail --source=opencode --id=ses_xxx
bun src/store/cli.ts detail --source=kimi --id=<id> --tools-only --max-output-chars=500
bun src/store/cli.ts detail --source=kimi --id=<id> --from=0 --to=8 --no-reasoning --with-children
bun src/store/cli.ts prompts --source=kimi --id=<sessionId>
bun src/store/cli.ts stats --source=all --days=7   # clipped totals + quality (issue #2)
bun src/store/cli.ts sync --days=7 --source=all --reconcile
bun src/store/cli.ts help
```

| Command | Data | Notes |
|---------|------|--------|
| `list` | cache (default) or `--live` | `--parent=` / `--roots` / **`--cwd=`**; compact by default |
| `children` | cache | `list --parent=<id>` |
| `resolve` | cache | `latest` \| id \| path \| title; ambiguous → exit 2 ([#4](https://github.com/watert/ai-coding-sessions/issues/4)) |
| `handoff` | **live** | cross-agent resume brief (inert; user 500 / assistant 3000); alias `resume-summary` (#4) |
| `trace` | **live** | timeline skeleton (no tool I/O by default); alias `timeline` |
| `tool-errors` | **live** | soft/hard tool failure rows for one session |
| `detail` | **live** | full messages; use size flags to fit Agent context |
| `prompts` | cache | user prompts only |
| `stats` | cache | **P0** clip + split + quality ([#2](https://github.com/watert/ai-coding-sessions/issues/2)); **P1** `by_model` · optional cost · `costByDay` · `tool_fail` ([#3](https://github.com/watert/ai-coding-sessions/issues/3)) |
| `sync` | write cache | `--full` / `--reconcile` |
| `refs` | live refs | no convert/write |

**Trace / detail flags:** `--io` · `--reasoning` · `--tools-only` · `--no-reasoning` · `--max-output-chars=N` · `--from=`/`--to=` · `--tool=` · `--status=` · `--jsonl` · `--format=json\|jsonl\|md` · `--out=PATH` · `--with-children` · `--max-steps=`

**Trace step timing (stable across sources):** `lag_ms` (TTFT) · `prefill_tps` · `decode_tps` · `duration_ms`. Detail/trace also expose session-level `timing` (`avg_latency_ms` / `avg_prefill_tps` / `avg_tps`).

**Recommended Agent workflow**

```text
list --roots → pick id
children --id=…          # subagents if any
trace --id=…             # cheap full path
tool-errors --id=…       # soft/hard failures only
trace --id=… --io --from=N --to=M   # dig a slice
trace --id=… --out=trace.md        # export markdown
detail --tools-only --max-output-chars=500 --from=N --to=M
```

Common flags: `--source=` · `--days=` · `--start=` · `--end=` · `--limit=` · `--offset=` · `--db=` · `--meta=` · `--raw`.

**Legacy:** bare flags = `sync`; `--prompts=src:id`; `--refs-only`.

Heavier host analysis (`export-weekly-prompts`, cross-session `analyze-tool-errors`, full token-stats) stays out of this package for now.

npm scripts: `bun run cli` · `bun run sync` · `bun run sync:reconcile`.

## Supported Sources

| Source | Local data (defaults) | Fidelity / limits |
|--------|----------------------|-------------------|
| `opencode` | OpenCode SQLite (`opencode db path`) | Full fidelity (real usage, step timing, subagents) |
| `claude` | `~/.claude/` history + project JSONL | Subagents under session dirs; main-chain de-dup for long sessions |
| `kimi` | `~/.kimi-code/` index + wire.jsonl | Virtual subagent sessions (`parent_id` / `spawn_group_id`) |
| `grok` | `~/.grok/sessions/` | Real usage when present; else `usage_source=estimate` (multi-turn context accumulate) |
| `codex` | `~/.codex/` state sqlite + rollout JSONL / `.jsonl.zst` | Compact / rollback aware; zstd may need `zstd` CLI |
| `zcode` | `~/.zcode/cli/db/db.sqlite` | |
| `workbuddy` | `~/.workbuddy/workbuddy.db` + project JSONL | |
| `cursor` | Cursor Desktop `state.vscdb` + `~/.cursor/projects/*/agent-transcripts` | See **Cursor limits** below |

Missing source dirs are skipped with a warning (other sources still work).

Env overrides (subset): `CLAUDE_CONFIG_DIR`, `KIMI_DATA_DIR`, `CODEX_HOME`, `GROK_HOME` / `GROK_SESSIONS_DIR`, `ZCODE_HOME` / `ZCODE_DB_PATH`, `WORKBUDDY_HOME`, `CURSOR_HOME`, `CURSOR_APP_DATA`, `CURSOR_STATE_DB`. Full table in skill `references/sources.md`.

### Cursor limits

Cursor is **Desktop-only** (local `state.vscdb` + agent-transcripts). Not cloud history, not Cursor CLI remote.

| Topic | Behavior |
|-------|----------|
| Messages | Primary: `composerHeaders` + bubble body (`toolFormerData`). Fallback: project `agent-transcripts` JSONL when bubbles are empty |
| Steps | Assistant turns split on **thinking boundaries** (`capabilityType=30` / `thinking.text` → `reasoning` part; tools = `capabilityType=15`) — matches UI multi-step “Thought for Xs”, not one giant assistant blob |
| Token usage | Local store has **no billed / per-call usage** (`usageData` empty, `bubble.tokenCount` usually 0) |
| Context snapshot | Last-window only: `composerData.promptTokenBreakdown` + `contextUsagePercent` → hung on **last assistant** as `tokens.context` / `last_message_tokens` |
| `usage_source` | `estimate` when only context snapshot exists; `real` only if bubble tokens appear |
| Totals / cost | Context used is **not** written to session `total_tokens` / `usage_by_day` (avoids token-stats treating window fill as cumulative spend). Pricing stays `0` on estimate path |
| vs Grok estimate | Grok can accumulate multi-turn context frames; Cursor has **one end-of-session frame** |
| Models | Often `default` / `auto` under provider `cursor` |
| Subagents | No parent/spawn graph equivalent to kimi/opencode |

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
  sources/    8 adapters + listSessions / getSessionDetail
  store/      schema, sync, queryCached, session-trace, CLI
  lib/        sqlite, jsonl-cache, date-utils, timing-stats
  pricing.ts  configurePricing hooks
  index.ts    Node entry
skills/
  ai-coding-sessions/   Agent skill (SKILL.md + references)
core.ts       re-export → src/core (legacy path)
```

Agent skill: `skills/ai-coding-sessions/SKILL.md`（主仓 `.agents/skills/ai-coding-sessions` 软链指回此处）。

Exports:

- `ai-coding-sessions` — Node entry
- `ai-coding-sessions/core` — isomorphic
- `ai-coding-sessions/pricing` — hooks only

## License

[MIT](./LICENSE) © 2026 waterwu

Third-party packages keep their own licenses (MIT / BSD-3-Clause as above).

## Related (host-only, not in this repo)

Production hosts may add: REST (`/api/ai-coding/*`), Web sessions UI, token-stats dashboard, `export-weekly-prompts`, `analyze-tool-errors`, `analyze-prompt-perf`, models.dev bridge. Those are **out of scope** for this package.
