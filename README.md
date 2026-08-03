# ai-coding-sessions

多 source AI Coding Session 列表/详情协议与（后续）SQLite 缓存。

## 入口

| 路径 | 说明 |
|------|------|
| `ai-coding-sessions/core` | 同构层：消息协议、getOverallStats、静态单价表、列表预览格式化 |
| `ai-coding-sessions` | Node 主入口（M1 = core；后续含 sources/store） |

## M1 范围

从 monorepo `@project/common` 迁入 core，**零行为变化**。sources / SQLite 同步见上游 issue。
