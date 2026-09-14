# ai-coding-sessions

[English](./README.md) · **中文**

**MIT** · 多源 AI Coding Session 列表 / 详情 / SQLite 缓存。

只读聚合本机 CLI / Desktop 会话数据（Claude Code、OpenCode、Kimi、Grok Build、Codex、ZCode、WorkBuddy、Cursor），统一为 OpenCode 形状协议。无云端、无账号、无遥测。

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
| Runtime | **仅 Bun ≥ 1.2**（`bun:sqlite`）。测试与 CLI 以 Bun 为准。 |
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

需要 [Bun](https://bun.sh)。各 CLI 默认本机路径下须已有数据（见 [支持的数据源](#支持的数据源supported-sources)）。

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
  source: 'all',           // 或 claude|opencode|kimi|grok|codex|zcode|workbuddy|cursor
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
bun src/store/cli.ts digest --days=1 --format=md --out=digest.md   # 多 session 日度 digest（roots，按 project 分组）
bun src/store/cli.ts trace --source=kimi --id=<id>                    # 骨架（~KB）
bun src/store/cli.ts trace --source=kimi --id=<id> --io --tool=Bash
bun src/store/cli.ts trace --source=kimi --id=<id> --jsonl --max-steps=30
bun src/store/cli.ts trace --source=kimi --id=<id> --format=md --out=trace.md
bun src/store/cli.ts tool-errors --source=kimi --id=<id> --status=hard
bun src/store/cli.ts detail --source=opencode --id=ses_xxx
bun src/store/cli.ts detail --source=kimi --id=<id> --tools-only --max-output-chars=500
bun src/store/cli.ts detail --source=kimi --id=<id> --from=0 --to=8 --no-reasoning --with-children
bun src/store/cli.ts prompts --source=kimi --id=<sessionId>
bun src/store/cli.ts prompts --source=kimi --id=<id1>,<id2>       # 同 source 批量（逗号分隔）
bun src/store/cli.ts prompts --source=kimi --days=7 --roots --limit=20   # 窗口批量（默认 7 天; --jsonl 每行一个 session）
bun src/store/cli.ts list --untitled --days=7 --roots
bun src/store/cli.ts set-title --source=kimi --id=<id> --title="知乎爬虫评审"
bun src/store/cli.ts stats --source=all --days=7   # bySource + by_model + tokensByDay/costByDay + root/sub 拆分
bun src/store/cli.ts stats --days=14 --model=deepseek --by=model,day   # --model= 子串过滤; 模型 × 日 交叉表
bun src/store/cli.ts sync --days=7 --source=all --reconcile
bun src/store/cli.ts tool-calls --build --days=90  # 物化 tool calls（cache-first 导出 / grep）
bun src/store/cli.ts skill-reads --build --days=90 # 物化 skill 读取（Skill tool + skills/ 文件读取）
bun src/store/cli.ts perf                          # 性能检查：list(×2)/detail/extract 采样 + 阈值警告
bun src/store/cli.ts help
```

| 命令 | 数据 | 说明 |
|---------|------|--------|
| `list` | 默认缓存，或 `--live` | `--parent=` / `--roots` / **`--cwd=`** / `--untitled`；默认紧凑字段 |
| `children` | 缓存 | 等价 `list --parent=<id>` |
| `resolve` | 缓存 | `latest` \| id \| path \| 标题；歧义 exit 2（[#4](https://github.com/watert/ai-coding-sessions/issues/4)） |
| `handoff` | **live** | 跨 agent 续作摘要（inert；user 500 / assistant 3000）；别名 `resume-summary`（#4） |
| `digest` | 缓存列表 + **live** detail | 多 session 日度 digest（roots → handoff 聚合；默认当天、roots-only；`--format=md` 按 project 分组，面向自动化 memory 整理） |
| `trace` | **live** | 时间线骨架（默认无 tool I/O）；别名 `timeline` |
| `tool-errors` | **live** | 单 session soft/hard 工具失败行 |
| `detail` | **live** | 完整 messages；用体量 flag 适配 Agent 上下文 |
| `prompts` | 缓存 | 仅 user prompts（单条 `--id`；批量 `--id=a,b` / 窗口过滤；`--jsonl` 每行一个 session） |
| `set-title` | 写缓存 | `custom_title` overlay（sync 不覆盖）；`--clear`；OpenCode `--write-source` |
| `stats` | 缓存 | 多维度聚合：窗口裁剪 + root/subagent 拆分 + quality（[#2](https://github.com/watert/ai-coding-sessions/issues/2)）；`by_model` · `tokensByDay` · `costByDay` · `tool_fail`（[#3](https://github.com/watert/ai-coding-sessions/issues/3)）；**`--model=`** 子串过滤 · **`--by=model,day`** 模型 × 日交叉 |
| `sync` | 写缓存 | `--full` / `--reconcile`；对本次 upsert 的 session 自动顺手物化 `skill_reads`（`skillReads: false` 关闭） |
| `tool-calls` | 缓存（build）/ live | 跨 session tool call jsonl 导出；每行带 `model`（主导模型）/ `day` / `msg_idx`（同 idx = 一个 assistant message 内的并行调用）；`--build` 增量物化，`--tool=`/`--status=` 过滤 |
| `skill-reads` | 缓存（build）/ live | skill 使用轨迹：Skill tool 调用 + `skills/<name>/` 下文件读取；`--skill=NAME`（支持 `%` 模糊），sqlite 中 session 级 JSON 行 |
| `perf` | live | 性能检查：各 source list(×2)/detail/extract 采样 + 阈值警告——见[性能检查](#性能检查performance-check) |
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

## 性能检查（Performance check）

**任何涉及 `sources/*`（list / detail 路径）、`store/sync.ts` 或物化表（`tool_calls`、`skill_reads`）的变更，合入前必须跑性能检查：**

```bash
bun src/store/cli.ts perf                 # 全 source，14 天窗口，各采样 5 个
bun src/store/cli.ts perf --days=30 --limit=8 --source=grok   # 定向检查
```

输出解读：

- `list_ms` / `list2_ms` —— live `listSessions` 连跑两次。`list2_ms` 应显著低于 `list_ms`（命中进程内缓存）。若 list 慢**且** `list2_ms ≈ list_ms`，说明 list 层缺缓存、或 TTL 比单次 list 还短。
- list 缓存 TTL **归属缓存条目、由调用方声明**：默认 3s；批量入口（`skill-reads --build`、`tool-calls --build`、`perf`）通过 `warmSourceListCache(source, ttlMs)` 以长 TTL 预热，避免扫描中途 TTL 过期重扫（grok 一次 ~800ms）把尖刺打进某个 session 的 detail 计时。
- `detail_avg_ms` / `detail_max_ms` —— live detail 采样。偏高通常是 detail 内部逐 session 重跑全量 list（典型 O(N²) 放大）或后置重计算。
- `slowest` —— 采样内最慢 detail 任务 top5（session_id + 耗时 + 消息数），把最贵的任务点名而不是被平均掩盖。默认各 source 只采样最近 5 个；`--all` 扫全窗口（如 `perf --all --days=30`）。
- `extract_avg_ms` —— 对采样 messages 跑 `extractSkillReads`；纯 CPU 遍历，应接近 0。
- 内置警告阈值：`list_ms > 1000`、`detail_avg_ms > 300`、`list2_ms` 无改善。注意 live `listSessions` 设计上含全量 convert（宿主对外服务应走 SQLite 缓存）；「慢但稳定」是已知取舍，**相对变更前基线的回退不是**。

真实机器基线参考（2026-09，约 850 个缓存 session）：总耗时 < 60s；opencode/kimi/grok `list_ms` 秒级（全量 convert），其余亚秒级；所有 `detail_avg_ms` < 150ms；`extract_avg_ms` ≈ 0。

## 支持的数据源（Supported Sources）

| Source | 本地数据（默认） | 保真度 / 限制 |
|--------|----------------------|----------------|
| `opencode` | OpenCode SQLite（`opencode db path`） | 最高（真实 usage、step timing、subagent） |
| `claude` | `~/.claude/` history + 项目 JSONL | Subagent 在 session 目录；长会话主链去重 |
| `kimi` | `~/.kimi-code/` index + wire.jsonl | 虚拟 subagent（`parent_id` / `spawn_group_id`） |
| `grok` | `~/.grok/sessions/` | 有真实 usage 则用；否则 `usage_source=estimate`（多轮 context 可累加） |
| `codex` | `~/.codex/` state sqlite + rollout JSONL / `.jsonl.zst` | 感知 compact / rollback；`.zst` 可能需 `zstd` |
| `zcode` | `~/.zcode/cli/db/db.sqlite` | |
| `workbuddy` | `~/.workbuddy/workbuddy.db` + 项目 JSONL | 虚拟 subagent（主 jsonl `Agent` tool → `projects/.../<sid>/subagents/agent-*.jsonl`） |
| `pi` | `~/.pi/agent/sessions/*.jsonl` | 真实 usage/cost；pi-subagents sidecar 子会话（`parent_id` / `spawn_group_id`） |
| `cursor` | Cursor Desktop `state.vscdb` + `~/.cursor/projects/*/agent-transcripts` | 见下方 **Cursor 限制** |

某 source 目录不存在会告警并跳过（其它源仍可用）。

环境变量覆盖（节选）：`CLAUDE_CONFIG_DIR`、`KIMI_DATA_DIR`、`CODEX_HOME`、`GROK_HOME` / `GROK_SESSIONS_DIR`、`ZCODE_HOME` / `ZCODE_DB_PATH`、`WORKBUDDY_HOME`、`CURSOR_HOME`、`CURSOR_APP_DATA`、`CURSOR_STATE_DB`。完整表见 skill `references/sources.md`。

### Cursor 限制

仅 **Cursor Desktop 本机数据**（`state.vscdb` + agent-transcripts），不含云端历史、非 Cursor CLI 远端。

| 主题 | 行为 |
|------|------|
| 消息 | 主源：`composerHeaders` + bubble（`toolFormerData`）；bubble 空时回退 project `agent-transcripts` JSONL |
| Step | 按 **thinking 边界**拆 assistant（`capabilityType=30` / `thinking.text` → `reasoning`；tool=`capabilityType=15`），对齐 UI「Thought for Xs」多轮 |
| Token usage | 本地 **无 billed / per-call usage**（`usageData` 空，`bubble.tokenCount` 多为 0） |
| Context 快照 | 仅会话末次窗口：`promptTokenBreakdown` + `contextUsagePercent` → 挂 **last assistant** 的 `tokens.context` / `last_message_tokens` |
| `usage_source` | 仅有 context 快照时为 `estimate`；仅当 bubble 真有 token 才为 `real` |
| 合计 / 成本 | context used **不**写入 session `total_tokens` / `usage_by_day`（避免 token-stats 把窗口占用当累计消耗）；estimate 路径 pricing 为 `0` |
| vs Grok estimate | Grok 可多轮 context 累加；Cursor **只有一帧**末次窗口 |
| 模型 | 常见 `default` / `auto`，provider `cursor` |
| Subagent | 无 kimi/opencode 式 parent/spawn 图 |

统一 session 字段（节选）：`id`、`title`、`source_title`、`custom_title`、`title_is_custom`、`source`、`parent_id`、`spawn_group_id`、token 合计、`avg_tps` / `avg_latency_ms`、`session_status`、`usage_by_model`、`usage_by_day`、`bashSignals`、`deliverableSignals`、可选 `pricing`。overlay 后 `title` = `custom_title || source_title`。

## 依赖

**无私有 / monorepo 依赖。** npm 运行时依赖（均为宽松许可）：

| 包 | License | 用途 |
|---------|---------|------|
| `dayjs` | MIT | 日期 |
| `lodash` | MIT | 工具 |
| `zod` | MIT | Schema（OpenCode / Claude / Kimi） |
| `debug` | MIT | 调试日志（`DEBUG=…`） |
| `diff` | BSD-3-Clause | 行 diff（Kimi / Grok editDiffs 等） |

运行时 I/O 仅本地文件系统 + SQLite（`bun:sqlite`）。宿主可自行拉 [models.dev](https://models.dev) 做实时单价；**本包不强制**。

## 脚本

```bash
bun test src          # hermetic 单测（无需本机真实 CLI 数据）
ACS_LIVE_TESTS=1 bun test src/sources/opencode.test.ts   # 可选真机冒烟
bun run check         # tsc --noEmit
bun run sync          # store CLI
bun run sync:reconcile
```

Fixture 生成器在 `src/sources/__fixtures__/`（不提交大二进制）。可用 env 覆盖根路径（`OPENCODE_DB_PATH`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME` 等）。

## 包布局

```
src/
  core/       同构协议、静态单价、列表预览
  sources/    8 个适配器 + listSessions / getSessionDetail
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
