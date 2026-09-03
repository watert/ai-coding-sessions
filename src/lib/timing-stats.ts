/**
 * assistant 延迟 / decode TPS / prefill TPS 列表聚合（Claude、Kimi 等 source 共用）
 */

const MAX_LATENCY_MS = 300_000;
const MAX_TPS = 1000;

export interface TimingLists {
  latencyList: number[];
  tpsList: number[];
  prefillTpsList: number[];
}

export function createTimingLists(): TimingLists {
  return { latencyList: [], tpsList: [], prefillTpsList: [] };
}

export interface TimingSample {
  /** 首 token 延迟（TTFT）。无 TTFT 数据的 source 可缺省，仅用 decodeDurationMs 算 tps */
  latencyMs?: number;
  outputTokens?: number;
  /** decode 阶段时长，缺省则用 latencyMs */
  decodeDurationMs?: number;
  inputTokens?: number;
}

/** 追加一条 assistant 样本（与 Claude/Kimi 原有过滤规则一致） */
export function pushAssistantTimingSample(lists: TimingLists, sample: TimingSample): void {
  const { latencyMs, outputTokens = 0, decodeDurationMs, inputTokens = 0 } = sample;
  const hasLatency = !!latencyMs && latencyMs > 0 && latencyMs < MAX_LATENCY_MS;
  const decodeMs = decodeDurationMs && decodeDurationMs > 0 ? decodeDurationMs : (latencyMs || 0);
  // 既无 latency 也无 decode 时长 → 无任何时序信息，丢弃
  if (!hasLatency && decodeMs <= 0) return;

  if (hasLatency) lists.latencyList.push(latencyMs!);

  if (outputTokens > 0 && decodeMs > 0) {
    const tps = outputTokens / (decodeMs / 1000);
    if (tps > 0 && tps < MAX_TPS) {
      lists.tpsList.push(tps);
    }
  }

  if (hasLatency && inputTokens > 0) {
    lists.prefillTpsList.push(Number((inputTokens / (latencyMs! / 1000)).toFixed(2)));
  }
}

export interface TimingSummary {
  avg_tps?: number;
  avg_latency_ms?: number;
  avg_prefill_tps?: number;
  assistant_tps_list?: number[];
  latency_list?: number[];
  prefill_tps_list?: number[];
}

export function summarizeTimingLists(lists: TimingLists): TimingSummary {
  const { latencyList, tpsList, prefillTpsList } = lists;
  const avgLatencyMs = latencyList.length > 0
    ? Math.round(latencyList.reduce((a, b) => a + b, 0) / latencyList.length)
    : undefined;
  const avgTps = tpsList.length > 0
    ? Number((tpsList.reduce((a, b) => a + b, 0) / tpsList.length).toFixed(2))
    : undefined;
  const avgPrefillTps = prefillTpsList.length > 0
    ? Number((prefillTpsList.reduce((a, b) => a + b, 0) / prefillTpsList.length).toFixed(2))
    : undefined;

  return {
    avg_tps: avgTps,
    avg_latency_ms: avgLatencyMs,
    avg_prefill_tps: avgPrefillTps,
    assistant_tps_list: tpsList.length > 0 ? tpsList : undefined,
    latency_list: latencyList.length > 0 ? latencyList : undefined,
    prefill_tps_list: prefillTpsList.length > 0 ? prefillTpsList : undefined,
  };
}