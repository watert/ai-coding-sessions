# AI Coding Sessions · Source 适配

## Source 表

| source | 本地形态（默认） | 适配文件 |
|--------|------------------|----------|
| `opencode` | OpenCode SQLite（`opencode db path`） | `opencode.ts` + 统一层 |
| `claude` | `~/.claude/` history + project JSONL | `claude-code.ts` + `claude-source.ts` |
| `kimi` | `~/.kimi-code/` index + wire.jsonl | `kimi-code.ts` + `kimi-source.ts`（含 subagent 虚拟 session） |
| `grok` | `~/.grok/sessions/` | `grok-code.ts` + `grok-source.ts`（真实 usage；cost 优先 costUsdTicks；旧 → `usage_source=estimate`） |
| `codex` | `~/.codex/` state sqlite + rollout JSONL | `codex-code.ts` + `codex-source.ts` |
| `zcode` | `~/.zcode/cli/db/db.sqlite` | `zcode-code.ts` + `zcode-source.ts` |
| `workbuddy` | `~/.workbuddy/workbuddy.db` + `projects/<hash>/<sid>.jsonl` | `workbuddy-code.ts` + `workbuddy-source.ts` |

路径均基于 `os.homedir()`；缺目录时跳过并 warn，其它 source 仍可用。

## 新 source 步骤

1. 实现 `src/sources/<name>-code.ts`（list 原始）+ `<name>-source.ts`（convert / detail）
2. 在 `src/sources/index.ts` 注册 `listSessions` / `getSessionDetail` / init·close
3. `store/schema.ts` 的 `SourceId` / `ALL_SOURCES` 补上
4. （可选）宿主前端 source 选项、REST 透传

## 字段对齐注意

| 主题 | 说明 |
|------|------|
| subagent | kimi/opencode 有 `parent_id` + `spawn_group_id`；用 `children` / `list --parent=` |
| grok usage | 新会话 real；旧 estimate；trace 时间戳可能偏序号化（见 #1 P1） |
| 成本 | 缓存不写 pricing；detail 依赖 `configurePricing` 或源内 cost 字段 |
| step 边界 | opencode 有 `step-start`/`step-finish`；其它多条 assistant 拼一轮 |

## 研究 agent 源码（可选）

对照 wire / tool schema 时自行 clone 上游（opencode、kimi-code、grok-build、claude dump 等）。  
**不要把本机绝对路径写进包代码**；仅维护者本地笔记即可。
