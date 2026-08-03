# ai-coding-sessions

[English](./README.md) · **中文**

**MIT** · 多源 AI Coding Session 列表 / 详情 / SQLite 缓存。

只读聚合本机 CLI 会话数据（Claude Code、OpenCode、Kimi、Grok Build、Codex、ZCode、WorkBuddy），统一为 OpenCode 形状协议。无云端、无账号、无遥测。

```
本地 CLI 数据 (SQLite / JSONL / wire / logs)
        │
        ▼
  sources/*   list · convert · detail(live)
  store/*     sync → sessions + prompts + usage_by_day
  core/*      同构 stats + 静态单价表
        │
        ▼
  宿主 (CLI / API / Web)  ·  可选 configurePricing()
```

## 状态

| 项 | 说明 |
|------|--------|
| License | MIT |
| Runtime | 优先 **Bun ≥ 1.2**（`bun:sqlite`）；Node 可用可选依赖 `better-sqlite3` |
| 路径 / Windows | `path.join` + 只读 SQLite `pathToFileURL`；env 根目录覆盖；JSONL 兼容 CRLF。**仍以 Bun 为主**，无完整 Win CI（[#6](https://github.com/watert/ai-coding-sessions/issues/6)） |
| 网络 | list / detail / sync 不需要网络 |
| 宿主耦合 | **无** — 纯包，不依赖私有 monorepo |
| npm | 源码优先；可从 git 或 path 安装（见下） |

## 安装

```bash
# git
bun add git+https://github.com/watert/ai-coding-sessions.git

# monorepo path
bun add ./packages/ai-coding-sessions
```

需要 [Bun](https://bun.sh)。各 CLI 默认本机路径下须已有数据（见 [数据源](#数据源)）。

## 库 API

### Live 列表 / 详情

```ts
import {
  initAiCodingStats,
  closeAiCodingStats,
  listSessions,
  getSessionDetail,
} from 'ai-coding-sessions';

await initAiCodingStats();

const { sessions, total, bySource } = await listSessions({
  source: 'all',           // 或 claude|opencode|kimi|grok|codex|zcode|workbuddy
  startDate: '2026-07-01', // 可选 YYYY-MM-DD
  endDate: '2026-07-31',
});

const detail = await getSessionDetail({
  sessionId: sessions[0].id,
  source: sessions[0].source,
});
// detail.info · detail.messages · detail.editDiffs · detail.pricing?

closeAiCodingStats();
```

### SQLite 缓存（长历史推荐）

```ts
import {
  syncSessions,
  queryCached,
  getSessionPrompts,
  ensureFresh,
  countStats,
} from 'ai-coding-sessions';

// 增量窗口（默认 7 天）
await syncSessions({ days: 7, source: 'all', reconcile: false });

const cached = queryCached({ source: 'kimi', startDate: '2026-07-01', limit: 50 });
const prompts = getSessionPrompts('kimi', cached.sessions[0].id);

// 宿主 API 常在 queryCached 前 ensureFresh
await ensureFresh({ maxAgeMs: 6 * 3600_000 });
console.log(countStats());
```

默认路径（可用 env 或 options 覆盖）：

| | 默认 |
|--|---------|
| SQLite | `~/data/ai-coding-sessions.sqlite` |
| Meta | `~/data/ai-coding-sessions.meta.json` |
| Env | `AI_CODING_SESSIONS_DB` / `AI_CODING_SESSIONS_META` |

**缓存策略**

- 列表行 + 完整 user **prompts** + **usage_by_day** → SQLite
- Session **detail / messages** → 始终 live（不缓存）
- **不存** `session.pricing`；缓存保留 `usage_by_model`，宿主可重计价而无需 resync
- 孤儿标记，不硬删

### 计价钩子

默认动态 AUTO 计价返回 `{ usd: 0, cny: 0 }`，除非宿主注入实现。`ai-coding-sessions/core` 仍带静态表，便于粗估。

```ts
import { configurePricing } from 'ai-coding-sessions';
import {
  AI_MODEL_PRICING_TABLE,
  calculateCost,
  USD_TO_CNY_RATE,
} from 'ai-coding-sessions/core';

// 最小静态接线示例 — 生产宿主请换 models.dev 等
configurePricing({
  getUsdToCnyRate: () => USD_TO_CNY_RATE,
  calculateMessageCost: (input) => {
    // map input.modelID → table row，再 calculateCost(...)
    return { totalCost: 0, cny: 0 };
  },
});
```

### Core（同构，无 fs/sqlite）

```ts
import {
  getOverallStats,
  AI_MODEL_PRICING_TABLE,
  calculateCost,
  formatCompact,
} from 'ai-coding-sessions/core';
```

## CLI（Agent 友好）

默认：**stdout JSON**（日志走 stderr）。面向 AI Agent：**list → 轨迹骨架 → 再挖 detail**。

轨迹设计说明：[issue #1](https://github.com/watert/ai-coding-sessions/issues/1)。

```bash
# 包根（或: bun run cli …）
bun src/store/cli.ts list --source=kimi --days=3 --limit=20
bun src/store/cli.ts list --source=kimi --roots --days=7
bun src/store/cli.ts list --cwd=. --days=7 --roots --limit=20
bun src/store/cli.ts children --source=kimi --id=<parentSessionId>
bun src/store/cli.ts resolve --source=grok --cwd=. --ref=latest
bun src/store/cli.ts handoff --source=grok --cwd=. --ref=latest       # 跨 agent 续作摘要（非全量 transcript）
bun src/store/cli.ts handoff --source=kimi --id=<id> --format=md --out=handoff.md
# 默认：user/goal 500、last_assistant_action 3000；--text-preview=N 同时覆盖
bun src/store/cli.ts trace --source=kimi --id=<id>                    # 骨架（~KB）
bun src/store/cli.ts trace --source=kimi --id=<id> --io --tool=Bash
bun src/store/cli.ts trace --source=kimi --id=<id> --jsonl --max-steps=30
bun src/store/cli.ts trace --source=kimi --id=<id> --format=md --out=trace.md
bun src/store/cli.ts tool-errors --source=kimi --id=<id> --status=hard
bun src/store/cli.ts detail --source=opencode --id=ses_xxx
bun src/store/cli.ts detail --source=kimi --id=<id> --tools-only --max-output-chars=500
bun src/store/cli.ts detail --source=kimi --id=<id> --from=0 --to=8 --no-reasoning --with-children
bun src/store/cli.ts prompts --source=kimi --id=<sessionId>
bun src/store/cli.ts stats --source=all --days=7   # 裁剪合计 + quality（issue #2）
bun src/store/cli.ts sync --days=7 --source=all --reconcile
bun src/store/cli.ts help
```

| 命令 | 数据 | 说明 |
|---------|------|--------|
| `list` | 默认缓存，或 `--live` | `--parent=` / `--roots` / **`--cwd=`**；默认紧凑字段 |
| `children` | 缓存 | 等价 `list --parent=<id>` |
| `resolve` | 缓存 | `latest` \| id \| path \| 标题；歧义 exit 2（[#4](https://github.com/watert/ai-coding-sessions/issues/4)） |
| `handoff` | **live** | 跨 agent 续作摘要（inert；user 500 / assistant 3000）；别名 `resume-summary`（#4） |
| `trace` | **live** | 时间线骨架（默认无 tool I/O）；别名 `timeline` |
| `tool-errors` | **live** | 单 session soft/hard 工具失败行 |
| `detail` | **live** | 完整 messages；用体量 flag 适配 Agent 上下文 |
| `prompts` | 缓存 | 仅 user prompts |
| `stats` | 缓存 | **P0** 裁剪 + split + quality（[#2](https://github.com/watert/ai-coding-sessions/issues/2)）；**P1** `by_model` · 可选成本 · `costByDay` · `tool_fail`（[#3](https://github.com/watert/ai-coding-sessions/issues/3)） |
| `sync` | 写缓存 | `--full` / `--reconcile` |
| `refs` | live refs | 不 convert / 不写库 |

**Trace / detail 标志：** `--io` · `--reasoning` · `--tools-only` · `--no-reasoning` · `--max-output-chars=N` · `--from=`/`--to=` · `--tool=` · `--status=`（`error`/`soft`/`hard`/`completed`） · `--jsonl` · `--format=json\|jsonl\|md` · `--out=PATH` · `--with-children` · `--max-steps=`

**跨 source 稳定 timing：** step 上 `lag_ms`（TTFT）· `prefill_tps` · `decode_tps` · `duration_ms`；detail/trace 另有 session 级 `timing`。

**推荐 Agent 流程**

```text
list --roots → 选 id
children --id=…          # 有 subagent 时
trace --id=…             # 低成本全路径
tool-errors --id=…       # 仅失败/soft
trace --id=… --io --from=N --to=M   # 切片深挖
trace --id=… --out=trace.md
detail --tools-only --max-output-chars=500 --from=N --to=M
```

`trace` 输出含 `steps[]`（`turn` / `lag_ms` / tool `soft`）与 `turns[]` 摘要。

通用标志：`--source=` · `--days=` · `--start=` · `--end=` · `--limit=` · `--offset=` · `--db=` · `--meta=` · `--raw`。

**兼容旧调用：** 无子命令 = `sync`；`--prompts=src:id`；`--refs-only`。

更重的宿主分析（`export-weekly-prompts`、跨 session `analyze-tool-errors`、完整 token-stats）暂不在本包。

npm scripts：`bun run cli` · `bun run sync` · `bun run sync:reconcile`。

## 数据源

| Source | 本地数据（默认） | 说明 |
|--------|----------------------|--------|
| `opencode` | OpenCode SQLite（`opencode db path`） | 保真度最高 |
| `claude` | `~/.claude/` history + 项目 JSONL | Subagent 在 session 目录下 |
| `kimi` | `~/.kimi-code/` index + wire.jsonl | 虚拟 subagent session |
| `grok` | `~/.grok/sessions/` | 有真实 usage 则用；否则 `usage_source=estimate`；墙钟来自 updates |
| `codex` | `~/.codex/` state sqlite + rollout JSONL | |
| `zcode` | `~/.zcode/cli/db/db.sqlite` | |
| `workbuddy` | `~/.workbuddy/workbuddy.db` + 项目 JSONL | |

某 source 目录不存在会告警并跳过（其它源仍可用）。

统一 session 字段（节选）：`id`、`title`、`source`、`parent_id`、`spawn_group_id`、token 合计、`avg_tps` / `avg_latency_ms`、`session_status`、`usage_by_model`、`usage_by_day`、`bashSignals`、`deliverableSignals`、可选 `pricing`。

## 依赖

**无私有 / monorepo 依赖。** npm 运行时依赖（均为宽松许可）：

| 包 | License | 用途 |
|---------|---------|------|
| `dayjs` | MIT | 日期 |
| `lodash` | MIT | 工具 |
| `zod` | MIT | Schema（OpenCode / Claude / Kimi） |
| `debug` | MIT | 调试日志（`DEBUG=…`） |
| `diff` | BSD-3-Clause | 行 diff（Kimi / Grok editDiffs 等） |
| `better-sqlite3` | MIT | **可选** — 无 `bun:sqlite` 时的 Node 回落 |

运行时 I/O 仅本地文件系统 + SQLite。宿主可自行拉 [models.dev](https://models.dev) 做实时单价；**本包不强制**。

## 脚本

```bash
bun test src          # 单元测试
bun run check         # tsc --noEmit
bun run sync          # store CLI
bun run sync:reconcile
```

## 包布局

```
src/
  core/       同构协议、静态单价、列表预览
  sources/    7 个适配器 + listSessions / getSessionDetail
  store/      schema、sync、queryCached、session-trace、CLI
  lib/        sqlite、jsonl-cache、date-utils、timing-stats
  pricing.ts  configurePricing 钩子
  index.ts    入口
skills/
  ai-coding-sessions/   Agent skill（SKILL.md + references）
core.ts       再导出 → src/core（兼容旧路径）
```

Agent skill：`skills/ai-coding-sessions/SKILL.md`（主仓 `.agents/skills/ai-coding-sessions` 软链指回此处）。

Exports：

- `ai-coding-sessions` — 主入口
- `ai-coding-sessions/core` — 同构
- `ai-coding-sessions/pricing` — 仅钩子

## License

[MIT](./LICENSE) © 2026 waterwu

第三方包保留各自许可（如上 MIT / BSD-3-Clause）。

## 相关（仅宿主，不在本仓）

生产宿主可能另有：REST（`/api/ai-coding/*`）、Web Sessions UI、token-stats 看板、`export-weekly-prompts`、`analyze-tool-errors`、`analyze-prompt-perf`、models.dev 桥。均属**本包范围外**。
