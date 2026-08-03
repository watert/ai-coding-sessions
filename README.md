# ai-coding-sessions

多 source AI Coding Session 列表/详情协议与（后续）SQLite 缓存。

## 入口

| 路径 | 说明 |
|------|------|
| `ai-coding-sessions/core` | 同构层：消息协议、getOverallStats、静态单价表、列表预览格式化 |
| `ai-coding-sessions` | Node：7 source list/detail、lib、pricing hooks |
| `configurePricing()` | 注入 models.dev / 汇率实现（server-hono bridge） |

## 进度

- **M1** core 自 monorepo common 迁入
- **M2** lib + 7 sources + listSessions；server-hono 以 shim 接入；**无缓存**
- M3+ store / sync / meta JSON
