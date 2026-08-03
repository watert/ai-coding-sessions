# AI Coding Sessions · 排查与扩展

## 排查

| 现象 | 检查点 |
|------|--------|
| 列表空 | 对应 CLI 数据目录是否存在；`--days`/`--start` 范围；source 是否装过 |
| 缓存旧 | `sync --days=N` / `--full`；宿主 `ensureFresh` / `?fresh=1` |
| 成本 0 | 未 `configurePricing` 时预期为 0；或 → ai-model-pricing / models.dev |
| detail 失败 / not_found | `--source` 是否与 list 一致；id 是否完整（含 subagent 后缀） |
| trace 太大 | 默认勿加 `--io`；用 `--max-steps` / `--from`/`--to`；detail 用 `--max-output-chars` |
| subagent 找不到 | `children --id=<parent>` 或 `list --parent=`；先 `sync` 写缓存 |
| grok token 怪 | `usage_source` real vs estimate；看 `grok-code` / `grok-source` |
| zcode 列表空 | `~/.zcode/cli/db/db.sqlite` 是否存在 |
| SQLite 打不开 | Bun 优先 `bun:sqlite`；Node 需 optional `better-sqlite3` |
| 子计双算 | 聚合场景只用 root（`list --roots`）；token-stats 分位数仅 root |

## CLI 调试

```bash
bun src/store/cli.ts list --source=all --days=1 --limit=5 --raw
bun src/store/cli.ts refs --source=claude --days=7
bun src/store/cli.ts sync --days=1 --source=kimi --reconcile
```

stderr 有 sqlite 路径日志；stdout 应是纯 JSON。

## 扩展

- 新 source：见 [sources.md](./sources.md)
- 新 CLI 子命令：`src/store/cli.ts` + 需要时下沉逻辑到 `session-trace.ts` 等
- 轨迹增强：P0/P1/P2 done — turn 分组 · grok 墙钟 · editDiffs · soft-fail · tool-errors · `--out` md/jsonl · 稳定 lag/prefill
- 跨 session 趋势：不要堆进 list → 宿主 **token-stats**
- 宿主 Web/REST：listSessionsCached + fillSessionPricing；勿 fork 包内 convert 逻辑
