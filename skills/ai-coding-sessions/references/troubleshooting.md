# AI Coding Sessions · 排查与扩展

## 排查

| 现象 | 检查点 |
|------|--------|
| 列表空 | 对应 CLI 数据目录是否存在；`--days`/`--start` 范围；source 是否装过 |
| 缓存旧 | `sync --days=N` / `--full`；宿主 `ensureFresh` / `?fresh=1` |
| kimi 列表停在 early/in-progress | 旧版 dirty 用 `state.updatedAt`（swarm 中不刷新）；应走 wire mtime:size。确认包版本后 `sync --source=kimi --days=1` |
| 成本 0 | 未 `configurePricing` 时预期为 0；或 → ai-model-pricing / models.dev |
| detail 失败 / not_found | `--source` 是否与 list 一致；id 是否完整（含 subagent 后缀） |
| trace 太大 | 默认勿加 `--io`；用 `--max-steps` / `--from`/`--to`；detail 用 `--max-output-chars` |
| subagent 找不到 | `children --id=<parent>` 或 `list --parent=`；先 `sync` 写缓存 |
| grok token 怪 | `usage_source` real vs estimate；看 `grok-code` / `grok-source` |
| zcode 列表空 | `~/.zcode/cli/db/db.sqlite` 是否存在 |
| SQLite 打不开 | 需 **Bun** + `bun:sqlite`；路径/权限/`mode=ro` URI 见 sources.md Windows 节 |
| 子计双算 | 聚合场景只用 root（`list --roots`）；token-stats 分位数仅 root |

## CLI 调试

```bash
bun src/store/cli.ts list --source=all --days=1 --limit=5 --raw
bun src/store/cli.ts refs --source=claude --days=7
bun src/store/cli.ts sync --days=1 --source=kimi --reconcile
```

stderr 有 sqlite 路径日志；stdout 应是纯 JSON。

## Subagent / 跨 CLI 调用陷阱 (grok / opencode / claude)

agent 调其他 CLI (kimi/opencode/claude/mm) 当 subagent 用时常见的失败模式:

| 现象 | 根因 | 排查/解决 |
|---|---|---|
| 长命令 60s 后变 `calling`, session 一直 in-progress | tool timeout 默认 60s, 命令被丢 background; agent 没轮询 `get_command_or_subagent_output` | `detail --from=N --to=M --tools-only` 看最后几个 step 是否停 `get_command_or_subagent_output: calling`; 下次给 tool `timeout: 0` 或拆短 prompt |
| agent reasoning 已写"调研结论", 但 subagent 还没返回 | agent 在等命令时并行自己下结论, 污染交付笔记 | `detail --include-reasoning` (或 detail 不带 `--tools-only`) 看 reasoning 时间戳 vs subagent 返回时间; 下次在 subagent 返回前 `todo_write` 标 in_progress |
| reasoning 里把 `--yolo` / `--auto` 混为同一 flag | CLI flag 互斥规则 agent 不熟, reasoning 偏差后重试 2-3 次才通 | skill 文档明确 flag 互斥; 首次试错后直接 `cmd --help` 复核 |
| model id 短名 `MiniMax-M3` 报 `not configured` | provider prefix 没带, 默认 model ≠ 短名 | `provider list --json` 拿全名; 或省 `-m` 走 default |
| context 撞满 100k+ | 累积 tool I/O + 长 reasoning | 改 `grok --worktree` 开新会话续作; 或 `claude --resume` / `kimi -c` |

诊断命令:

```bash
# 看 calling 卡哪
bun src/store/cli.ts detail --source=grok --id=<id> --from=28 --to=32 --tools-only
# 看 reasoning (污染检测)
bun src/store/cli.ts detail --source=grok --id=<id> --from=28 --to=32 --max-output-chars=2000
# 看 token 撞没撞满
bun src/store/cli.ts detail --source=grok --id=<id> --tools-only --max-output-chars=200 | jq '.info, .timing, .shape'
```

## 扩展

- 新 source：见 [sources.md](./sources.md)
- 新 CLI 子命令：`src/store/cli.ts` + 需要时下沉逻辑到 `session-trace.ts` 等
- 轨迹增强：P0/P1/P2 done — turn 分组 · grok 墙钟 · editDiffs · soft-fail · tool-errors · `--out` md/jsonl · 稳定 lag/prefill
- 跨 session 趋势：不要堆进 list → 宿主 **token-stats**
- 宿主 Web/REST：listSessionsCached + fillSessionPricing；勿 fork 包内 convert 逻辑
