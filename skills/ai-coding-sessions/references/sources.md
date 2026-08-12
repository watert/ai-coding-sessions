# AI Coding Sessions · Source 适配

## Source 表

| source | 本地形态（默认） | 适配文件 |
|--------|------------------|----------|
| `opencode` | OpenCode SQLite（`opencode db path`） | `opencode.ts` + 统一层 |
| `claude` | `~/.claude/` history + project JSONL | `claude-code.ts` + `claude-main-chain.ts` + `claude-source.ts` |
| `kimi` | `~/.kimi-code/` index + wire.jsonl | `kimi-code.ts` + `kimi-source.ts`（含 subagent 虚拟 session） |
| `grok` | `~/.grok/sessions/` | `grok-code.ts` + `grok-source.ts`（真实 usage；cost 优先 costUsdTicks；旧 → `usage_source=estimate`） |
| `codex` | `~/.codex/` state sqlite + rollout JSONL/`.jsonl.zst` | `codex-code.ts` + `codex-source.ts` |
| `zcode` | `~/.zcode/cli/db/db.sqlite` | `zcode-code.ts` + `zcode-source.ts` |
| `workbuddy` | `~/.workbuddy/workbuddy.db` + `projects/<hash>/<sid>.jsonl` + `.../<sid>/subagents/agent-*.jsonl` | `workbuddy-code.ts` + `workbuddy-source.ts`（`Agent` tool → 虚拟 subagent，`parent_id` / `spawn_group_id`） |
| `cursor` | Desktop `state.vscdb`（composerHeaders + bubbleId）+ `~/.cursor/projects/*/agent-transcripts` | `cursor-code.ts` + `cursor-source.ts` |

路径均基于 `os.homedir()` + `path.join`；缺目录时跳过并 warn，其它 source 仍可用。

### 环境变量覆盖（对齐 [ccusage](https://github.com/ccusage/ccusage) 习惯）

| 变量 | source | 说明 |
|------|--------|------|
| `CLAUDE_CONFIG_DIR` | claude | 逗号分隔；可指向 config 根或 `…/projects`；否则 `XDG_CONFIG_HOME/claude` → `~/.claude`（优先存在） |
| `KIMI_DATA_DIR` | kimi | 逗号分隔；否则优先存在的 `~/.kimi-code` / `~/.kimi` |
| `CODEX_HOME` | codex | 逗号分隔；默认 `~/.codex` |
| `GROK_HOME` / `GROK_SESSIONS_DIR` | grok | 可指 `~/.grok` 或 `…/sessions` |
| `ZCODE_HOME` / `ZCODE_DB_PATH` | zcode | 可指 db 文件或 `.zcode` 根 |
| `WORKBUDDY_HOME` | workbuddy | 默认 `~/.workbuddy` |
| `CURSOR_HOME` | cursor | 默认 `~/.cursor`（projects / transcripts） |
| `CURSOR_APP_DATA` | cursor | Desktop 应用数据根；macOS 默认 `~/Library/Application Support/Cursor` |
| `CURSOR_STATE_DB` | cursor | 直接指定 `state.vscdb` 路径 |
| `OPENCODE_DB_PATH` | opencode | 直接指定 `opencode.db`（优先于 `opencode db path`；hermetic 测试用） |

测试：`ACS_LIVE_TESTS=1` 才跑依赖本机真实 CLI 数据的冒烟（默认 skip）。各 source list/convert 主路径见 `src/sources/__fixtures__/` + `source-fixtures.test.ts` / `opencode.test.ts`。

实现：`src/lib/home-paths.ts`（`resolveHomeDir` / `resolveDataRoot`）。

### Windows 路径注意

- SQLite 只读：`toReadonlyUri` 用 `pathToFileURL` → `file:///C:/…?mode=ro`（勿手拼 `file:C:\…`）
- Claude project 目录名：`/` 与 `\` 均编码为 `-`
- JSONL 按行切分兼容 CRLF（`splitLines`：cache / Claude / kimi index / codex rollout / workbuddy）
- 缓存 meta 原子写：Windows 下 rename 覆盖目标会先 unlink
- **文档与验收按 Bun-only**；sqlite 层仍保留 better-sqlite3 代码分支但不宣传

## 新 source 步骤

1. 实现 `src/sources/<name>-code.ts`（list 原始）+ `<name>-source.ts`（convert / detail）
2. 在 `src/sources/index.ts` 注册 `listSessions` / `getSessionDetail` / init·close
3. `store/schema.ts` 的 `SourceId` / `ALL_SOURCES` 补上
4. （可选）宿主前端 source 选项、REST 透传

## 字段对齐注意

| 主题 | 说明 |
|------|------|
| subagent | kimi/opencode/workbuddy 有 `parent_id` + `spawn_group_id`；用 `children` / `list --parent=` |
| grok usage | 新会话 real；旧 estimate；trace 时间戳可能偏序号化（见 #1 P1） |
| 成本 | 缓存不写 pricing；detail 依赖 `configurePricing` 或源内 cost 字段 |
| step 边界 | opencode 有 `step-start`/`step-finish`；其它多条 assistant 拼一轮 |
| **Claude 主链**（[#5](https://github.com/watert/ai-coding-sessions/issues/5)） | `parentUuid` leaf 链；`compact_boundary` / snip；跳过 `isSidechain`；并行 tool sibling 回收 → 避免长会话 token **重复计入** |
| **Codex compact**（#5） | `.jsonl.zst`（需 `zstd`）；`compacted.replacement_history`；`thread_rolled_back` → 修正 usage 口径 |
| **Cursor usage** | 本地 **无 billed / per-call usage**（`usageData={}`，`bubble.tokenCount` 全 0）。**有**末次 context 快照：`composerData.promptTokenBreakdown`（`totalUsedTokens` / `maxTokens` / categories）+ `contextUsagePercent` → 挂 last assistant `tokens.context`，`usage_source=estimate`，**不**写入 `total_tokens`（避免 token-stats 把窗口占用当累计消耗）。Grok estimate 是多轮 context 累加；Cursor 只有一帧 |
| **Cursor steps** | bubble 按 **thinking 边界**拆 assistant（`capabilityType=30` / `thinking.text` → `reasoning` part）；tool=`capabilityType=15`+`toolFormerData`；text 归当前 step。对齐 UI「Thought for Xs」多轮，勿把整段 type=2 合成一条 |

改完 Claude/Codex 解析后需 **`sync --reconcile`**（或 `?fresh=1`）再看 token-stats。

## 研究 agent 源码（可选）

对照 wire / tool schema 时自行 clone 上游（opencode、kimi-code、grok-build、claude dump 等）。  
**不要把本机绝对路径写进包代码**；仅维护者本地笔记即可。
