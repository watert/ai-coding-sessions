---
name: ai-coding-sessions
description: 查询、分析、导出本地 AI Coding Sessions（opencode / claude / kimi / grok / codex / zcode / workbuddy / cursor）：会话列表/详情、轨迹 trace、handoff 跨 agent 续作摘要、prompts 导出、token/成本/TPS（按模型/按天聚合、模型×日交叉）、subagent 聚合、tool 失败排查、缓存 sync、弱标题/set-title 生成覆盖标题、skill 使用频次盘点 / 审计。跨 session Token 看板用 token-stats；单价/models.dev 用 ai-model-pricing。
metadata:
  version: 1.12.0
---

# AI Coding Sessions

多数据源 AI 编程会话：**统一协议 + 库 API + SQLite 缓存 + Agent CLI**。只读聚合本地 CLI 落盘数据（无云、无账号）。

- 包 README：`../../README.md`
- 轨迹设计：[issue #1](https://github.com/watert/ai-coding-sessions/issues/1)
- 跨 agent handoff：[issue #4](https://github.com/watert/ai-coding-sessions/issues/4)
- Claude/Codex 主链 fidelity：[issue #5](https://github.com/watert/ai-coding-sessions/issues/5)
- 参考：[Source](./references/sources.md) · [CLI](./references/cli.md) · [排查](./references/troubleshooting.md) · [其它 agent](./references/other-agents.md) · [WorkBuddy 内部机制](./references/workbuddy-internals.md)

## 触发场景

- 列表 / 详情 / **轨迹 trace** / **handoff 续作摘要** / prompts / stats
- **按模型 / 按天趋势聚合**（`stats --model=` · `--by=model,day`）与裸查 sqlite 口径
- Agent 对话中自识别当前会话（`list --cwd` + `in-progress` + prompts 比对）
- 成本、token、TPS、latency、cache、subagent
- 缓存 sync / reconcile / 脏检
- 弱标题 / Untitled / 生成或改 session title（`set-title`）/ 批量标题审查（`title-review`）
- 新 source 适配或字段不对
- **技能使用频次盘点 / 审计 / skill 命中统计 / 哪个 session 触发了某 skill**（`skill-reads`；详见「审计 / 盘点」段）
- 未实现 agent 本地目录 / 本机有哪些 CLI 落盘数据（check 脚本, **不实现解析**）

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
src/sources/    9 source + listSessions / getSessionDetail
src/store/      schema · sync · queryCached · session-trace · CLI
src/pricing.ts  configurePricing 钩子
skills/ai-coding-sessions/   本 skill
```

## Source

`opencode | claude | kimi | grok | codex | zcode | workbuddy | cursor | pi`  
本地路径与适配见 [references/sources.md](./references/sources.md)。  
WorkBuddy 时序 / 吞吐 / 日志排查 → [workbuddy-internals.md](./references/workbuddy-internals.md)。  
未实现 agent 目录与落盘形态 → [other-agents.md](./references/other-agents.md)。  
本机探测：`bun skills/ai-coding-sessions/scripts/check-local-agents.ts`（`--format=md` · `--kind=other` · `--all`；pi 行会附带 **pi-timing extension** 检查）。  
**pi-timing extension**（pi source 真 TTFT/流式时长 → TPS 的数据源，缺了则回退整段 call 时长估算）：

```bash
ln -sf packages/ai-coding-sessions/extensions/pi-timing.ts ~/.pi/agent/extensions/pi-timing.ts
```  
新 source：`*-code` + `*-source` → `sources/index.ts` 注册。

## 审计 / 盘点（skill-reads）

**口径**：Skill tool 调用 + read 类工具命中 `skills/<name>/`（含 `SKILL.md` 主文件）。每个 session 级物化为一行 `reads` JSON 列，导出时打平 jsonl。  
**典型场景**：30 天 skill 使用频次、跨 source 命中分布、按 skill / session 反查、回放某次会话实际读了哪几个 skill。

**三阶段语义**：`--build`（物化，**不写文件**）→ 默认 cache-first 导出 → `--live`（跳过物化表直读）。

```bash
# 第一步：物化（增量；已 built 且 last_active 未超过 built_at 的 session 跳过）
bun packages/ai-coding-sessions/src/store/cli.ts skill-reads --build --days=30

# 第二步：导出（默认 cache-first 读物化表打平 jsonl；每行 self-contained 含 source/session_id/skill/path）
bun packages/ai-coding-sessions/src/store/cli.ts skill-reads --days=30 --out=/tmp/skills.jsonl

# 兜底：跳过物化表 live 直读（适合物化错过 / 临时抽样；不写 sqlite skill_reads）
bun packages/ai-coding-sessions/src/store/cli.ts skill-reads --days=30 --live --out=/tmp/skills-live.jsonl

# 强制重建（绕过 built_at 短路；适合新 source extractor 接入后 / 怀疑识别漏数据）
bun packages/ai-coding-sessions/src/store/cli.ts skill-reads --build --days=30 --full
```

- `--build`：live 提取并物化到 sqlite `skill_reads` 表（**增量，不写文件**，必须分两步）
- `--out=PATH`：导出到文件（独立步骤；默认按 `--format=jsonl` 每行一个 event，stdout 直读时同样 jsonl）
- `--live`：跳过物化表，直接 `getSessionDetail` + `extractSkillReads` 兜底导出（**不读写 sqlite `skill_reads`**，适合排查"为什么某 session 没物化到"）
- `--full` / `--force-rebuild`：`--build` 时跳过 `builtAt != null && lastActiveMs <= builtAt` 短路，强制重提窗口内所有 session（参考 sync `--full` 语义）
- `--skill=NAME`：精确匹配（`--skill=vault-ops`）/ 子串模糊（`--skill='ai-%'`，`%` 替换通配语义）
- `--format=json`：包装为 `{ok, count, records: [...]}` 数组（适合直接 pipe 给 `jq` / `python -m json.tool`）；默认 `jsonl` 每行一 record
- `--limit=N`：行数上限（默认 5000）

> ⚠️ `--build --out=` 合在同一行 **不会** 落盘：build 只物化表，写文件请单独再跑导出。常见踩坑见 issue #14。

**JSON stdout**：CLI **默认静默** sqlite 生命周期 banner（`[sqlite:…] 运行时/已关闭`）。Agent 把 stdout+stderr 一起 `JSON.parse` 时不再撕碎。排查连接时加 `--verbose`（或 `AI_CODING_SESSIONS_QUIET=0`）：

```bash
bun packages/ai-coding-sessions/src/store/cli.ts skill-reads --days=30 --format=json | python3 -m json.tool
bun packages/ai-coding-sessions/src/store/cli.ts list --source=kimi --days=1 --limit=1 --verbose
```

## 数据模型要点

- 列表：`id`, `title`, `source`, `parent_id`, `spawn_group_id`, `total_*`, `avg_tps`, `avg_latency_ms`, `session_status`, `usage_by_model`, `usage_by_day`, `editDiffs`, `usage_source`, `usage_is_incomplete`, `cost_is_partial`, `insert_count`, `queued_count`, `interrupt_count` …
- 运行中插入（`userParts.origin` / `prompts.origin`）：`insert` 不打断当前轮插话 · `queued` 等本轮结束再送 · `interrupt` 先打断再重说。pi 无显式 flag（tool 循环推断 insert）；kimi 用 `prompt.steered` / `injection.interruption`；grok 用 while-working 前缀 / `prior_turn_interrupt=mid_turn_abort`
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
| `prompts` | 缓存 user prompts（单条 `--id`；批量 `--id=a,b` / 窗口过滤；`--jsonl`；**默认每条截断 300 字符**——前后各 150 用 `...` join, `--truncate-chars=0` 全量原文） |
| `set-title` | 缓存 `custom_title`（`--clear` · OpenCode `--write-source`） |
| `title-review` | 标题审查候选：`title` + prompt count + truncated prompts（`--prompt-count=` / `--prompt-chars=` / `--include-empty`） |
| `stats` | **多维度聚合**：`by_model` / `tokensByDay` / `costByDay` / `split`(root vs subagent) / `tool_fail` / `quality`；**`--model=` 子串过滤** · **`--by=model,day` 模型×日交叉** |
| `scan` | **跨 session prompt 检索**（缓存 prompts 表, cache-first; `--grep=` · `--regex` · `--days=`） |
| `tool-calls` | **跨 session tool call 导出 jsonl**（每行自含归因: `model` 主导模型 / `day` / `msg_idx` 统一 messages 下标——同 idx 多条 = 一个 msg 内的并行调用; `--build` 物化 / `--live` 直读 / `--tool=` / `--out=`; 落盘后 grep/jq/python 接管分析） |
| `skill-reads` | **skill 使用频次盘点**（`--build` 物化 / 默认 cache 导出 / `--live` 直读 / `--full` 强制重建 / `--skill=` / `--out=`; 三阶段见「审计 / 盘点」段） |
| `sync` | 增量同步（`--reconcile` · `--full`） |
| `refs` | listRefs |

**按模型 / 趋势聚合**（先看 `stats`，别急着裸查 sqlite；口径与直查姿势见 [CLI](./references/cli.md)）：

```bash
bun src/store/cli.ts stats --source=all --days=7                       # bySource + by_model + tokensByDay/costByDay + split(root/sub) + tool_fail
bun src/store/cli.ts stats --days=14 --model=deepseek-flash            # 只看某模型（大小写不敏感子串; 收窄 session 与模型维度）
bun src/store/cli.ts stats --days=14 --model=deepseek --by=model,day   # 模型 × 日 交叉（by_model_day）
```

**识别当前会话**（Agent 在对话中定位"我"是哪条 session；**标题不可信**——各 agent 标题生成机制不同，主要靠 prompts 识别）：

```bash
bun src/store/cli.ts sync --days=1 --source=all           # cache-first, 先保证当前会话已落缓存 (增量很快)
bun src/store/cli.ts list --cwd=. --days=0 --compact | jq '[.sessions[] | select(.session_status=="in-progress")]'
bun src/store/cli.ts resolve --cwd=. --ref=latest          # 多数场景: 最近活跃一条就是当前会话
bun src/store/cli.ts prompts --source=<s> --id=<id>        # 默认截断 300, 用 prompt 内容比对确认
```

- 判定顺序：`--cwd=` 圈定项目 → `session_status=="in-progress"` 且 `last_active_at_iso` 最新 → `prompts` 首条预览比对（当前会话的首条 prompt 就是你正在处理的请求）
- 缓存可能滞后于本轮对话，拿不准就先 `sync --days=1`
- `list --compact` 输出含 `session_status`（`in-progress`/`done`/`error`/`aborted`/`unknown`），无服务端 running 筛选参数，jq 客户端过滤即可
- 不要用 `title-review` 做自识别：它排除已有 `custom_title` 的 session，恰好会漏掉当前会话

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
bun src/store/cli.ts prompts --source=kimi --id=<id1>,<id2>       # 同 source 批量 (逗号分隔)
bun src/store/cli.ts prompts --source=kimi --days=7 --roots --limit=20   # 窗口批量 (默认 7 天; --jsonl 每行一个 session)
bun src/store/cli.ts set-title --source=kimi --id=<id> --title="知乎爬虫评审"
bun src/store/cli.ts set-title --source=opencode --id=ses_xxx --title="..." --write-source
```

- **机械弱标题**（`isWeakTitle`，`list --untitled` 过滤）：空 / `Untitled` / `New Session` / `New session - <ISO>` 前缀
- **Agent 审查**（`title-review`）：非弱标题也可疑——源自动标题可能是整段 prompt、英文占位、词不达意。候选输出 `title + prompt_count + prompts_preview`（默认前 3 条 × 300 字符，`--prompt-count=` / `--prompt-chars=` 可调），由 Agent 依据 prompts 判断是否重写
- `prompts` 默认每条截断 300 字符（`--truncate-chars=` 可调，`0` = 全量原文）；标题生成用途够用，逐字核对时才关
- 一次最多改约 5 条。标题短、可检索，不要整段 prompt。

标志速查：`--cwd=` · `--ref=` · `--untitled` · `--title=` · `--clear` · `--write-source` · `--prompt-count=` · `--prompt-chars=` · `--include-empty` · `--truncate-chars=` · `--text-preview=` · `--io` · `--reasoning` · `--tools-only` · `--no-reasoning` · `--max-output-chars=` · `--from=`/`--to=` · `--tool=` · `--status=` · `--jsonl` · `--format=` · `--out=` · `--with-children` · `--raw` · `--verbose`  
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
