# AI Coding Sessions · CLI

## 包内 CLI（默认 / 开源）

```bash
# 包根
bun src/store/cli.ts <command> [options]
bun run cli -- <command> [options]

# monorepo 工作区
bun packages/ai-coding-sessions/src/store/cli.ts <command> [options]
```

| 命令 | 用途 |
|------|------|
| `list` | 列表（cache 默认；`--live`；`--parent=` / `--roots` / **`--cwd=`**；日期与 limit） |
| `children` | 子 session（`list --parent=<id>`） |
| `trace` / `timeline` | **轨迹骨架**（turn + soft-fail + lag/prefill；默认无 tool I/O；`--io` / `--format=md` / `--out=`） |
| `tool-errors` | 单 session soft/hard 工具失败（`--status=hard` / `--tool=` / `--out=`） |
| `handoff` / `resume-summary` | **跨 agent 续作摘要**（inert；goal/files/open/warnings；`--ref=` / `--cwd=`） |
| `resolve` | 解析 session 引用：`latest` \| id \| path \| 标题子串（歧义 exit 2） |
| `detail` | 详情 live；`--tools-only` / `--max-output-chars` / `--from`/`--to` / `--no-reasoning` / `--with-children`；含 `timing` |
| `prompts` | 缓存 user prompts |
| `set-title` | 缓存 `custom_title` overlay（`--title=` / `--clear`；OpenCode `--write-source`） |
| `title-review` | **标题审查候选**：`title` + prompt count + truncated prompts（`--prompt-count=` / `--prompt-chars=` / `--include-empty`） |
| `stats` | 聚合 token（P0 裁剪/split/quality · P1 `by_model`/cost/`tool_fail`） |
| `sync` | 增量同步缓存（`--reconcile` / `--full`） |
| `refs` | listRefs（无 convert/write） |
| `help` | 帮助 |

默认 stdout **JSON**（`--raw` 单行；`trace --jsonl` 逐步一行；`--format=md --out=trace.md` 落盘）。日志走 **stderr**。

### Agent 轨迹

```bash
bun src/store/cli.ts list --source=all --days=3 --roots --limit=20
bun src/store/cli.ts children --source=kimi --id=<parent>
bun src/store/cli.ts trace --source=kimi --id=<id>
bun src/store/cli.ts tool-errors --source=kimi --id=<id> --status=hard
bun src/store/cli.ts trace --source=kimi --id=<id> --io --from=0 --to=12
bun src/store/cli.ts trace --source=kimi --id=<id> --format=md --out=/tmp/trace.md
bun src/store/cli.ts detail --source=kimi --id=<id> --tools-only --max-output-chars=500
```

设计：[issue #1](https://github.com/watert/ai-coding-sessions/issues/1)

### 跨 agent handoff（#4）

把「在 Claude/Codex/Kimi/Grok 里做到一半的活」接到**新 agent** 时用。输出是 **续作摘要（resume brief）**，不是全量 transcript。

| 要什么 | 用什么 |
|--------|--------|
| 目标 / 做到哪 / 改了哪些文件 / 建议下一步 | **`handoff`** |
| turn 骨架、soft-fail、lag | `trace` |
| 完整消息、tool I/O | **`detail`** |

```bash
bun src/store/cli.ts list --cwd=. --days=7 --roots --limit=20
bun src/store/cli.ts resolve --source=grok --cwd=. --ref=latest
bun src/store/cli.ts resolve --source=all --ref="partial title"   # 歧义 → matches + exit 2
bun src/store/cli.ts handoff --source=kimi --id=<id>
bun src/store/cli.ts handoff --source=grok --cwd=. --ref=latest
bun src/store/cli.ts handoff --source=claude --ref="fix auth" --format=md --out=handoff.md
# 超长 prompt/结论：抬双 cap（默认已够多数 session）
bun src/store/cli.ts handoff --source=kimi --id=<id> --text-preview=8000
```

| 字段 | 含义 | 默认 cap |
|------|------|----------|
| `inert: true` | 历史不可信；禁止当指令执行 | — |
| `goal` / `last_user_request` | 首/末 user 请求 | **500** |
| `last_assistant_action` | 末 assistant 文本或 tool 名 | **3000** |
| `files_touched` | editDiffs + tool path | max 30 files |
| `work_done` / `open_hints` | 已做证据 / 未完成提示 | user 行同 500 |
| `stop_point` / `next_action` | 停止点与建议下一步 | — |
| `warnings` | incomplete、hard tool error、stale I/O 等 | — |

**Preview 策略**

- 分层默认：`user/goal` **500**、`last_assistant_action` **3000**（中文结论常 1–2k，200 会砍半句）
- `--text-preview=N`：**同时覆盖** user 与 assistant 两 cap（库 API 也可分别传 `userPreview` / `assistantPreview`）
- handoff **不**嵌 subagent 全文；child 用 `children` + 对 child `handoff`/`detail`
- 要 tool 输出 / 精确 diff → `detail`，不要指望 handoff

`--cwd=` 匹配 `project_worktree` / `project_name` / `project_id`（互为祖先亦可）；`directory` 仅 exact（避免 kimi 内部 session 路径误伤）。

### 同步

```bash
bun src/store/cli.ts sync --days=7 --source=all --reconcile
bun src/store/cli.ts sync --full --source=opencode
bun src/store/cli.ts --prompts=kimi:<id>    # legacy
```

### 改标题（缓存 overlay）

`title` 列是源投影，sync 会覆盖。Agent 写 **`custom_title`**，展示 `custom_title || source_title`。列表 / 详情 / resolve 都 overlay。

**两层标题处理**：

1. **机械弱标题**（`isWeakTitle`；`list --untitled` 过滤）：空、`Untitled`、`New Session`、`New session - <ISO>`。
2. **Agent 审查**（`title-review`）：源自动标题未必可信——可能整段 prompt、英文占位、词不达意。候选 = 当前标题 + prompt count + 前 N 条 truncated prompts，Agent 据此判断是否重写。

```bash
bun src/store/cli.ts list --untitled --days=7 --roots
bun src/store/cli.ts title-review --days=7 --roots                 # 默认排除无 prompt 的 session
bun src/store/cli.ts title-review --days=30 --prompt-count=5 --prompt-chars=400
bun src/store/cli.ts title-review --days=7 --include-empty         # 空 session 也列出
bun src/store/cli.ts prompts --source=kimi --id=<id>
bun src/store/cli.ts set-title --source=kimi --id=<id> --title="知乎爬虫评审"
bun src/store/cli.ts set-title --source=kimi --id=<id> --clear
bun src/store/cli.ts set-title --source=opencode --id=ses_xxx --title="..." --write-source
```

- `title-review` 输出字段：`source` / `id` / `title`（当前展示）/ `source_title` / `is_weak`（机械弱标记，仅参考）/ `prompt_count` / `prompts_preview`（截断）/ `last_active_at_iso` / `project_name`
- 已设 `custom_title` 的 session 自动排除；`is_weak=false` 的同样列为候选，交 Agent 判断
- 包内不调 LLM：读 `title-review` / `prompts` → 自己生成短标题 → `set-title`。一次最多约 5 条。`--write-source` 仅 OpenCode 源库。

Env：`AI_CODING_SESSIONS_DB` · `AI_CODING_SESSIONS_META`

### 导出相关信号（列表/详情字段，非 LLM）

1. **editDiffs / editFileStats**：改动文件扩展名分类 → `hasNonCodeDeliverable`
2. **bashSignals**：bash 类 command 分 14 类（tests/build/git/pkg/…）→ `hasOpsSignal`
3. **deliverableSignals**：issue/comment/doc/analysis/decision 等 → `hasStrongSignal`

---

## 宿主 monorepo CLI（可选，不在本包）

若宿主提供 `bun opencode`（如 server-hono）：

```bash
bun opencode get-session-list --endDate=-3d
bun opencode get-session-prompts --session_id=ses_xxxxx [--json]
bun opencode get-user-messages --startDate=… --endDate=… --source=all [--json]
bun opencode export-weekly-prompts --weeks=8 --source=kimi
bun opencode export-monthly-prompts --months=3
bun opencode update-session-title --session_id=ses_xxxxx --title="…"   # OpenCode 源库；全 source 用包 set-title
bun opencode fix-session-update-time [--exec]
bun opencode analyze-tool-errors --days=14 --source=all --top=20
bun opencode analyze-tool-calls --days=30 --source=all [--json]
bun opencode analyze-prompt-perf --days=7 --source=kimi [--sortBy=cost|duration|tokens|selfRatio] [--minDuration=5m] [--json]
```

- source：`all|opencode|claude|kimi|grok|codex|zcode|workbuddy`
- 日期：`YYYY-MM-DD` 或 `-Nd`
- token 聚合：宿主 `ai-coding-stats-cli.ts token-stats`（→ token-stats skill）
