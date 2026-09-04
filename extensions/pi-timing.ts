/**
 * pi timing 扩展: 记录 assistant 首 token 时刻 / 流式时长 → session jsonl custom entry
 *
 * 背景: pi jsonl 的 message envelope 只有 m.timestamp(请求发起) + 落盘时间(完成),
 * 无 TTFT/流式时长 → 本仓 ai-coding-sessions 的 pi source 只能用整段 call 时长推 TPS。
 * 本扩展在 pi 官方扩展机制上补齐时序数据, 无需改 pi 源码。
 *
 * 依据 (~/www/github/pi @ earendil-works/pi):
 * - message_update 仅在真实 delta 时触发 (start 事件走 message_start,
 *   packages/agent/src/harness/execution/assistant.ts isUpdateEvent) → 首次 update ≈ 首 token
 * - 扩展事件先于持久化 (packages/coding-agent/src/core/agent-session.ts
 *   "Emit to extensions first" → appendMessage) → custom entry 紧邻 assistant message 之前
 * - AssistantMessage.timestamp = 请求发起时刻 (pi-ai 各 api 实现 create partial 时 Date.now())
 *   → 直接当 t0, 无需 hook before_provider_request
 * - pi.appendEntry(customType, data) → SessionManager.appendCustomEntry()
 *   写 {type:"custom"} entry 到同一 jsonl, 不进 LLM context
 *
 * 落盘 schema (customType = "pi-timing"):
 *   { t0: 请求发起 ms, t1: 首 token ms, t2: 流结束 ms,
 *     ttftMs: t1-t0, streamDurationMs: t2-t1 }
 *
 * 用法: 软链到 ~/.pi/agent/extensions/pi-timing.ts (jiti 直接加载 TS, /reload 热重载)
 *   ln -sf <repo>/packages/ai-coding-sessions/extensions/pi-timing.ts ~/.pi/agent/extensions/pi-timing.ts
 *
 * 局限: 并行多 lane 同时流式时按 message.timestamp (请求发起 ms) 配对, 同 ms 并发流会串扰;
 * 默认串行 turn 下无影响。无流式 delta 的消息 (纯错误/瞬时失败) 不落 entry。
 */

interface PiTimingData {
  t0: number;
  t1: number;
  t2: number;
  ttftMs: number;
  streamDurationMs: number;
}

export default function (pi: any) {
  // key = assistant message.timestamp (请求发起 ms, partial 全程稳定); value = 首 token 时刻, 0 = 未见到
  const firstTokenAt = new Map<number, number>();

  const tsOf = (m: any): number =>
    m && typeof m.timestamp === 'number' && m.timestamp > 0 ? m.timestamp : 0;

  pi.on('message_start', (event: any) => {
    const m = event?.message;
    if (m?.role !== 'assistant') return;
    const ts = tsOf(m);
    if (!ts) return;
    if (!firstTokenAt.has(ts)) firstTokenAt.set(ts, 0);
  });

  pi.on('message_update', (event: any) => {
    const m = event?.message;
    if (m?.role !== 'assistant') return;
    const ts = tsOf(m);
    if (!ts) return;
    if (firstTokenAt.get(ts) === 0) firstTokenAt.set(ts, Date.now());
  });

  pi.on('message_end', (event: any) => {
    const m = event?.message;
    if (m?.role !== 'assistant') return;
    const t0 = tsOf(m);
    const t1 = firstTokenAt.get(t0) || 0;
    firstTokenAt.delete(t0);
    // 无流式 delta (error/aborted 且首 token 未到) → 不记录, 解析侧回退整段 call 时长
    if (!t0 || !t1) return;
    const t2 = Date.now();
    const data: PiTimingData = {
      t0,
      t1,
      t2,
      ttftMs: t1 - t0,
      streamDurationMs: t2 - t1,
    };
    try {
      pi.appendEntry('pi-timing', data);
    } catch {
      /* appendEntry 失败不阻断消息流 */
    }
  });
}
