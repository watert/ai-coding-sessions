# ai-coding-sessions

多 source AI Coding Session 列表/详情协议与 SQLite 缓存。

## 入口

| 路径 | 说明 |
|------|------|
| `ai-coding-sessions/core` | 同构层：消息协议、getOverallStats、静态单价表、列表预览格式化 |
| `ai-coding-sessions` | Node：7 source list/detail、store、lib、pricing hooks |
| `configurePricing()` | 宿主注入 models.dev / 汇率实现 |

## Store（M3）

| 路径 | 默认 |
|------|------|
| SQLite | `~/data/ai-coding-sessions.sqlite` |
| meta JSON | `~/data/ai-coding-sessions.meta.json` |

环境变量：`AI_CODING_SESSIONS_DB` / `AI_CODING_SESSIONS_META`

```bash
# 增量同步（7 天）+ 对账
bun packages/ai-coding-sessions/src/store/cli.ts --days=7 --source=all --reconcile

# 全量 + orphan 标记
bun packages/ai-coding-sessions/src/store/cli.ts --full --source=all

# 仅 listRefs
bun packages/ai-coding-sessions/src/store/cli.ts --refs-only --source=claude

# 查 prompts
bun packages/ai-coding-sessions/src/store/cli.ts --prompts=claude:<sessionId>
```

API：`syncSessions` / `queryCached` / `getSessionPrompts` / `listRefs` / `ensureFresh` / `reconcileSessions`

- **Detail live-only**：不进 SQLite
- **Prompts 完整落库**：`prompts` 表
- **无 sync_state 表**：新鲜度看 meta JSON
- **Orphan 只标记不删**
- **payload 无 pricing**：列 `usage_by_model` + 日表 `usage_by_day.usage_by_model`

## 进度

- **M1** core 自 monorepo common 迁入
- **M2** lib + 7 sources + listSessions；宿主 shim 接入；**无缓存**
- **M3** store schema + sync + meta JSON + CLI
- **M4** 宿主 `listSessionsCached` + `fillSessionPricing` + `?fresh=1`/`?live=1`
- **M5** token-stats 切缓存 + usage_by_day 按日裁剪；文档；公开仓 `watert/ai-coding-sessions`
