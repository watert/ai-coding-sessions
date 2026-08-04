---
name: ai-coding-sessions
description: 查询、分析、导出本地 AI Coding Sessions（opencode / claude / kimi / grok / codex / zcode / workbuddy / cursor）：会话列表/详情、轨迹 trace、handoff 跨 agent 续作摘要、prompts 导出、token/成本/TPS、subagent 聚合、tool 失败排查、缓存 sync。跨 session Token 看板用 token-stats；单价/models.dev 用 ai-model-pricing。
metadata:
  version: 1.7.3
---

# AI Coding Sessions

多数据源 AI 编程会话：**统一协议 + 库 API + SQLite 缓存 + Agent CLI**。只读聚合本地 CLI 落盘数据（无云、无账号）。

- 包 README：`../../README.md`
- 轨迹设计：[issue #1](https://github.com/watert/ai-coding-sessions/issues/1)
- 跨 agent handoff：[issue #4](https://github.com/watert/ai-coding-sessions/issues/4)
- Claude/Codex 主链 fidelity：[issue #5](https://github.com/watert/ai-coding-sessions/issues/5)
- 参考：[Source](./references/sources.md) · [CLI](./references/cli.md) · [排查](./references/troubleshooting.md)

## 触发场景

- 列表 / 详情 / **轨迹 trace** / **handoff 续作摘要** / prompts / stats
- 成本、token、TPS、latency、cache、subagent
- 缓存 sync / reconcile / 脏检
- 新 source 适配或字段不对

## 数据流

```
本地源 (SQLite / JSONL / wire / grok logs)
  → sources/*   list · convert · detail(live)
  → store/*     sync → sessions + prompts + usage_by_day
  → core/*      同构 stats + 静态单价表
  → CLI / 宿主 (REST · Web · 计价注入)
```

## 包布局

```
src/core/       同构协议、静态单价、列表预览
src/sources/    8 source + listSessions / getSessionDetail
src/store/      schema · sync · queryCached · session-trace · CLI
src/pricing.ts  configurePricing 钩子
skills/ai-coding-sessions/   本 skill
```

## Source

`opencode | claude | kimi | grok | codex | zcode | workbuddy | cursor`  
本地路径与适配见 [references/sources.md](./references/sources.md)。  
新 source：`*-code` + `*-source` → `sources/index.ts` 注册。

## 数据模型要点

- 列表：`id`, `title`, `source`, `parent_id`, `spawn_group_id`, `total_*`, `avg_tps`, `avg_latency_ms`, `session_status`, `usage_by_model`, `usage_by_day`, `editDiffs`, `usage_source`, `usage_is_incomplete`, `cost_is_partial` …
- `parent_id`：fork/subagent 父会话；`spawn_group_id`：同轮并发 subagent 组
- 状态：`in-progress` | `done` | `error` | `aborted` | `unknown`
- 详情 live：`info` + `messages` + `editDiffs` + 可选 `pricing`
- 缓存：**不存** `session.pricing`（存 `usage_by_model`，宿主可重计价）；detail/messages 不进 SQLite

## CLI（Agent 优先 JSON stdout）

```bash
# 包根或 monorepo 路径
bun src/store/cli.ts <cmd> …
# monorepo:
bun packages/ai-coding-sessions/src/store/cli.ts <cmd> …
```

| 命令 | 用途 |
|------|------|
| `list` | 缓存列表（`--live` · `--parent=` · `--roots` · **`--cwd=`**） |
| `children` | 子 session |
| `trace` / `timeline` | **轨迹骨架**（默认无 tool I/O；`--format=md --out=`） |
| `tool-errors` | 单 session soft/hard 工具失败 |
| `handoff` / `resume-summary` | **跨 agent 续作摘要**（inert；`--ref=` / `--cwd=`） |
| `resolve` | 解析 `latest` / id / path / 标题（歧义 exit 2） |
| `detail` | 详情 live + 体量控制 + `timing` |
| `prompts` | 缓存 user prompts |
| `stats` | token / bySource 聚合 |
| `sync` | 增量同步（`--reconcile` · `--full`） |
| `refs` | listRefs |

**轨迹推荐**（#1）：

```bash
bun src/store/cli.ts list --source=kimi --days=3 --roots --limit=20
bun src/store/cli.ts children --source=kimi --id=<parent>
bun src/store/cli.ts trace --source=kimi --id=<id>
bun src/store/cli.ts tool-errors --source=kimi --id=<id> --status=hard
bun src/store/cli.ts trace --source=kimi --id=<id> --io --tool=Bash --max-steps=30
bun src/store/cli.ts trace --source=kimi --id=<id> --out=trace.md
bun src/store/cli.ts detail --source=kimi --id=<id> --tools-only --max-output-chars=500
bun src/store/cli.ts sync --days=7 --source=all --reconcile
```

**跨 agent handoff**（#4）：

续作**摘要**（inert），不是 transcript。默认 cap：`goal`/`last_user_request` **500**、`last_assistant_action` **3000**。  
`--text-preview=N` 同时覆盖两者。要 tool I/O / 全文 → `detail`。

```bash
bun src/store/cli.ts list --cwd=. --days=7 --roots --limit=20
bun src/store/cli.ts resolve --source=grok --cwd=. --ref=latest
bun src/store/cli.ts handoff --source=grok --cwd=. --ref=latest
bun src/store/cli.ts handoff --source=kimi --id=<id> --format=md --out=handoff.md
bun src/store/cli.ts handoff --source=kimi --id=<id> --text-preview=8000   # 超长时
bun src/store/cli.ts detail --source=kimi --id=<id> --no-reasoning --max-output-chars=8000
```

标志速查：`--cwd=` · `--ref=` · `--text-preview=` · `--io` · `--reasoning` · `--tools-only` · `--no-reasoning` · `--max-output-chars=` · `--from=`/`--to=` · `--tool=` · `--status=` · `--jsonl` · `--format=` · `--out=` · `--with-children` · `--raw`  
完整说明 → [references/cli.md](./references/cli.md)

## 库 API 摘要

```ts
import {
  initAiCodingStats, listSessions, getSessionDetail,
  syncSessions, queryCached, getSessionPrompts,
  buildTraceSteps, shapeDetailMessages, collectToolErrors,
  formatTraceMarkdown, configurePricing,
  buildHandoff, formatHandoffMarkdown,
  resolveSessionRef, filterSessionsByCwd, matchesCwd,
} from 'ai-coding-sessions';
```

缓存默认：`~/data/ai-coding-sessions.sqlite` + `.meta.json`（`AI_CODING_SESSIONS_DB` / `_META`）。

## 成本

- 未 `configurePricing` 时动态 AUTO 常为 0；`core` 有静态表可自接
- 宿主可注入 models.dev + 汇率；缓存不固化 pricing

## 宿主集成（可选 monorepo）

本 skill **以包为准**。若在 fetch-av-cover 等宿主中：

| 能力 | 位置 |
|------|------|
| REST `/api/ai-coding/*` | 宿主 router + `listSessionsCached` / `fillSessionPricing` |
| Web Sessions / TokenStats | 宿主前端 + **token-stats** skill |
| 周报导出 / tool-errors / prompt-perf | 宿主 `opencode` CLI（见 [cli.md 宿主节](./references/cli.md)） |
| 改 title | 宿主 `update-session-title`（OpenCode 元数据） |

跨 session 看板 → **token-stats**；单价表 → **ai-model-pricing**。
