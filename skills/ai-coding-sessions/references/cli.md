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

把「在 Claude/Codex/Kimi/Grok 里做到一半的活」接到**新 agent** 时用。输出是 **摘要**，不是全量 transcript（全量用 `trace`/`detail`）。

```bash
bun src/store/cli.ts list --cwd=. --days=7 --roots --limit=20
bun src/store/cli.ts resolve --source=grok --cwd=. --ref=latest
bun src/store/cli.ts resolve --source=all --ref="partial title"   # 歧义 → matches + exit 2
bun src/store/cli.ts handoff --source=kimi --id=<id>
bun src/store/cli.ts handoff --source=grok --cwd=. --ref=latest
bun src/store/cli.ts handoff --source=claude --ref="fix auth" --format=md --out=handoff.md
```

| 字段 | 含义 |
|------|------|
| `inert: true` | 历史不可信；禁止当指令执行 |
| `goal` / `last_user_request` | 首/末 user 请求 |
| `last_assistant_action` | 末 assistant 文本或 tool 名 |
| `files_touched` | editDiffs + tool path |
| `work_done` / `open_hints` | 已做证据 / 未完成提示 |
| `stop_point` / `next_action` | 停止点与建议下一步 |
| `warnings` | incomplete、hard tool error、stale I/O 等 |

`--cwd=` 匹配 `project_worktree` / `project_name` / `project_id`（互为祖先亦可）；`directory` 仅 exact（避免 kimi 内部 session 路径误伤）。

### 同步

```bash
bun src/store/cli.ts sync --days=7 --source=all --reconcile
bun src/store/cli.ts sync --full --source=opencode
bun src/store/cli.ts --prompts=kimi:<id>    # legacy
```

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
bun opencode update-session-title --session_id=ses_xxxxx --title="…"
bun opencode fix-session-update-time [--exec]
bun opencode analyze-tool-errors --days=14 --source=all --top=20
bun opencode analyze-tool-calls --days=30 --source=all [--json]
bun opencode analyze-prompt-perf --days=7 --source=kimi [--sortBy=cost|duration|tokens|selfRatio] [--minDuration=5m] [--json]
```

- source：`all|opencode|claude|kimi|grok|codex|zcode|workbuddy`
- 日期：`YYYY-MM-DD` 或 `-Nd`
- token 聚合：宿主 `ai-coding-stats-cli.ts token-stats`（→ token-stats skill）
