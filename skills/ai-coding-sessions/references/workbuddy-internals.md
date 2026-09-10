# WorkBuddy 内部机制与排障

排查 WorkBuddy 的时序 / 吞吐 / 「是不是 UI 拖慢了 loop」时看这里。数据形态与日志位置来自本机实测（session `0c89ceb3…`，deepseek-v4.1-flash）。

## 落盘位置（均在 `~/.workbuddy`）

- `workbuddy.db` — `sessions` / `session_usage` / `workspaces`
- `projects/<dir-hash>/<sid>.jsonl` — 主 session 事件流（`<dir-hash>` 是 cwd 编码）
- `projects/<dir-hash>/<sid>/subagents/agent-*.jsonl` — subagent 事件流
- `logs/<YYYY-MM-DD>/sdk/conversations/<sid>.log` — **桌面 SDK 侧**事件，含逐 chunk 时间戳（`agent_thought_chunk` / `agent_message_chunk`）
- `logs/<YYYY-MM-DD>/<project>__<hash>.log` — **CLI agent 进程**（Java，`pid=`）日志，含 TTFT / 流时长 / 状态机
- `logs/renderer.log` — 渲染进程日志（含 `[cl-diag-…]` / `[perf] heartbeat`）
- `traces/<pid>/trace_<hash>.json` — 内部 span（`generation` / `function` / `mcp_tools`）
- `logs/sandbox/<date>/sandbox_*.log` — 沙箱 shell 进程日志（命令级）

## 架构：两进程

- **CLI agent 进程**自己消费网络 SSE 并驱动 agent loop（发请求、执行工具、决定下一步）。
- **渲染进程**是独立消费者（经 SDK/ACP 事件拿到 chunk），**不 gate loop**。
- 结论：UI 渲染慢不会 backpressure 到模型请求；实测 loop 反而跑在渲染前面。

## JSONL 事件形态

事件 `type`：`message` / `reasoning` / `function_call` / `function_call_result` / `file-history-snapshot` / `ai-title`。

**关键：批量 flush。** 同一次 LLM call 的 `reasoning` / `message` / `function_call` 事件时间戳几乎同刻（实测 64 组里 62 组 <20ms，最大 161ms），说明整段生成结束后一次性落盘 —— **jsonl 没有逐 token 流式时间线**，组内最早时间戳 ≈ 该 call 结束时刻。

- 分组键：`providerData.messageId`（= 一次 sub-LLM-call）；`providerData.traceId`（≤ user 轮）。
- token/credit 在 `providerData.rawUsage`（`completion_tokens` 含 `completion_tokens_details.reasoning_tokens`；`prompt_tokens_details.cached_tokens` = cache read）。
- 时间流：`reasoning.ts` → `function_call.ts`(+~5ms) → `function_call_result.ts`(工具执行完) → 下一 call `reasoning.ts`。

## CLI agent 日志关键行

```bash
L=~/.workbuddy/logs/<date>/<project>__<hash>.log
rg -N 'First meaningful token received|Stream completed:|MODEL_REQUEST_STARTED|MODEL_RESPONSE_DONE|TOOL_STARTED|TOOL_ENDED|message-to-model-request latency|ToolManager\] execute OK' "$L"
```

- `First meaningful token received … ttft=(\d+)ms` — TTFT（含 prefill / 排队）
- `Stream completed: … elapsed=(\d+)ms` — 整段流时长；**纯解码 ≈ elapsed − ttft**
- 状态机：`MODEL_REQUEST_STARTED → MODEL_STREAM_STARTED → MODEL_RESPONSE_DONE → TOOL_STARTED → TOOL_ENDED`
- `ToolManager] execute OK … elapsed=` — 工具真实耗时

## 实测时序（一次 agent loop 的构成）

| 阶段 | 实测 | 说明 |
|------|------|------|
| 网络流完 → 工具启动 | **5~9ms** | `Stream completed` → `TOOL_STARTED`；工具不等 UI |
| 工具结束 → 下个模型请求 | **~950ms（sd 197，703~1881）** | 与输出长度**无关**；trace 记为 `mcp_tools`（CLI 侧 MCP/遥测），非渲染 |
| TTFT | ~1.0~1.7s | prefill（长上下文命中 cache） |
| 纯解码 | **~360 tps**（aggregate 367） | `elapsed − ttft` 口径，多数 call 300~430 |

**判据**：若 UX 残留流式真的 gate 了下个请求，`工具结束→下个请求` 的 gap 会随渲染内容量增长；实测恒定 → 否决。且 SDK 收到首个 chunk 仅比 CLI 慢 ~5ms。

## 本仓 workbuddy tps 口径

`workbuddy-source.ts:collectWorkbuddyStepSamples`：`netCall = created(cur) − 上一步最后 tool result ts`。

- 该窗口 = `mcp_tools(~0.9s) + generation(TTFT + decode)`，**已剔除工具执行**，但**含 TTFT 与 mcp_tools**。
- 所以看板的 `avg_tps`（如 224）天然低于纯解码（~360）；想反映「模型多快」用 `elapsed − ttft` 口径。

## trace span

`traces/<pid>/trace_*.json` 的 `spans[]` 有 `name/type/startedAt/endedAt/duration/parentId`：

- `generation`（type `generation`）= 单次 LLM call（≈ 流时长）
- `<ToolName>`（type `function`）= 工具执行
- `mcp_tools`（type `custom`）= 每步 5 个，两个 ~400ms → 每步固定 ~0.8~0.9s 开销来源

```bash
# 单 turn 的 span 时间线
bun -e 'const j=require(process.env.HOME+"/.workbuddy/traces/<pid>/trace_<hash>.json");for(const s of j.spans.sort((a,b)=>new Date(a.startedAt)-new Date(b.startedAt)))console.log(s.startedAt,s.duration+"ms",s.name)'
```
