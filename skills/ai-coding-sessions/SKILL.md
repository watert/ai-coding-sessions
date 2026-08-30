---
name: ai-coding-sessions
description: 查询、分析、导出本地 AI Coding Sessions（opencode / claude / kimi / grok / codex / zcode / workbuddy / cursor）：会话列表/详情、轨迹 trace、handoff 跨 agent 续作摘要、prompts 导出、token/成本/TPS、subagent 聚合、tool 失败排查、缓存 sync、弱标题/set-title 生成覆盖标题。跨 session Token 看板用 token-stats；单价/models.dev 用 ai-model-pricing。
metadata:
  version: 1.8.0
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
- 弱标题 / Untitled / 生成或改 session title（`set-title`）/ 批量标题审查（`title-review`）
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
- **title overlay**：`title` = `custom_title || source_title`。`custom_title` 是缓存标注（Agent `set-title`），**sync 不覆盖**。列表/详情/resolve 都走 overlay。勿回写各 source 本地库（OpenCode 可用 `--write-source`）

## CLI（Agent 优先 JSON stdout）

```bash
# 包根或 monorepo 路径
bun src/store/cli.ts <cmd> …
# monorepo:
bun packages/ai-coding-sessions/src/store/cli.ts <cmd> …
```

| 命令 | 用途 |
|------|------|
| `list` | 缓存列表（`--live` · `--parent=` · `--roots` · **`--cwd=`** · `--untitled`） |
| `children` | 子 session |
| `trace` / `timeline` | **轨迹骨架**（默认无 tool I/O；`--format=md --out=`） |
| `tool-errors` | 单 session soft/hard 工具失败 |
| `failures` | **跨 source 失败汇总**（API 异常 + Tool fail；`--days=`/`--start=`/`--end=`/`--source=grok|opencode|kimi`；`--format=md --out=`） |
| `handoff` / `resume-summary` | **跨 agent 续作摘要**（inert；`--ref=` / `--cwd=`） |
| `digest` | **多 session 日度 digest**（roots → handoff 聚合；默认当天 roots-only；`--format=md` 按 project 分组，可 append memory） |
| `resolve` | 解析 `latest` / id / path / 标题（歧义 exit 2） |
| `detail` | 详情 live + 体量控制 + `timing` |
| `prompts` | 缓存 user prompts |
| `set-title` | 缓存 `custom_title`（`--clear` · OpenCode `--write-source`） |
| `title-review` | 标题审查候选：`title` + prompt count + truncated prompts（`--prompt-count=` / `--prompt-chars=` / `--include-empty`） |
| `stats` | token / bySource 聚合 |
| `scan` | **跨 session prompt 检索**（缓存 prompts 表, cache-first; `--grep=` · `--regex` · `--days=`） |
| `tool-calls` | **跨 session tool call 导出 jsonl**（每行自含 session 归因; `--build` 物化 / `--live` 直读 / `--tool=` / `--out=`; 落盘后 grep/jq/python 接管分析） |
| `sync` | 增量同步（`--reconcile` · `--full`） |
| `refs` | listRefs |

**轨迹推荐**（#1）：

```bash
bun src/store/cli.ts list --source=kimi --days=3 --roots --limit=20
bun src/store/cli.ts children --source=kimi --id=<parent>
bun src/store/cli.ts trace --source=kimi --id=<id>
bun src/store/cli.ts tool-errors --source=kimi --id=<id> --status=hard
bun src/store/cli.ts failures --days=7                  # 跨 source 失败汇总 (JSON)
bun src/store/cli.ts failures --source=grok --days=3 --format=md --out=failures.md
bun src/store/cli.ts trace --source=kimi --id=<id> --io --tool=Bash --max-steps=30
bun src/store/cli.ts trace --source=kimi --id=<id> --out=trace.md
bun src/store/cli.ts detail --source=kimi --id=<id> --tools-only --max-output-chars=500
bun src/store/cli.ts scan --grep='kimi -p' --days=90                      # prompt 侧 CLI 入口归因 (cache-first)
bun src/store/cli.ts tool-calls --build --days=90                          # tool call 物化 (增量)
bun src/store/cli.ts tool-calls --days=90 --out=tc.jsonl                   # 导出 jsonl (0.1s 级) → grep/jq/python
bun src/store/cli.ts tool-calls --days=14 --tool=Bash | grep 'grok -m'     # 管道直查
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

**日度 digest**（自动化 memory 整理原料；机械聚合、零 LLM）：

```bash
bun src/store/cli.ts digest                          # 今日 roots digest (JSON)
bun src/store/cli.ts digest --days=7 --limit=30 --source=all
bun src/store/cli.ts digest --cwd=. --format=md --out=digest.md   # 按 project 分组, 可直接 append memory
```

- 默认窗口 = 当天、roots-only（`--parent=` 时取其 children）、`--limit` 默认 20
- 逐 session live detail + handoff 聚合；空 session / detail 缺失自动 skip（输出 `skipped` 计数）
- digest 的 preview cap 比 handoff 更紧凑（user 300 / assistant 1200），`--text-preview=N` 覆盖

**改标题**（读 prompts → 生成 → 写缓存 overlay）：

```bash
bun src/store/cli.ts list --untitled --days=7 --roots          # 机械弱标题
bun src/store/cli.ts title-review --days=7 --roots             # Agent 审查: title + prompt count + truncated prompts
bun src/store/cli.ts prompts --source=kimi --id=<id>
bun src/store/cli.ts set-title --source=kimi --id=<id> --title="知乎爬虫评审"
bun src/store/cli.ts set-title --source=opencode --id=ses_xxx --title="..." --write-source
```

- **机械弱标题**（`isWeakTitle`，`list --untitled` 过滤）：空 / `Untitled` / `New Session` / `New session - <ISO>` 前缀
- **Agent 审查**（`title-review`）：非弱标题也可疑——源自动标题可能是整段 prompt、英文占位、词不达意。候选输出 `title + prompt_count + prompts_preview`（默认前 3 条 × 300 字符，`--prompt-count=` / `--prompt-chars=` 可调），由 Agent 依据 prompts 判断是否重写
- 一次最多改约 5 条。标题短、可检索，不要整段 prompt。

标志速查：`--cwd=` · `--ref=` · `--untitled` · `--title=` · `--clear` · `--write-source` · `--prompt-count=` · `--prompt-chars=` · `--include-empty` · `--text-preview=` · `--io` · `--reasoning` · `--tools-only` · `--no-reasoning` · `--max-output-chars=` · `--from=`/`--to=` · `--tool=` · `--status=` · `--jsonl` · `--format=` · `--out=` · `--with-children` · `--raw`  
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
  setSessionTitle, isWeakTitle,
  collectSessionFailures, resolveFailureWindow,
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
| 改 title | 包 CLI `set-title`（缓存 overlay）；宿主 `PATCH /api/ai-coding/session-title`；OpenCode 源库用 `--write-source` 或旧 `update-session-title` |

跨 session 看板 → **token-stats**；单价表 → **ai-model-pricing**。
