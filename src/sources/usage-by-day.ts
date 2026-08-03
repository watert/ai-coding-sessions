/**
 * Session 跨天活动：按 message 时间切日 usage，供日统计/趋势使用
 */
import dayjs from 'dayjs';
import {
  calculateMessageCost,
  extractMessagePricingInput,
  type MessagePricingInput,
} from '../pricing';

export interface UsageByDayModel {
  modelKey: string;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
  cny: number;
}

export interface UsageByDay {
  date: string;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
  cny: number;
  byModel?: UsageByDayModel[];
}

export interface ActivitySpan {
  first_active_at_iso: string;
  last_active_at_iso: string;
  span_days: number;
  usage_by_day: UsageByDay[];
}

export interface TimedPricingMessage extends MessagePricingInput {
  /** 消息时间 ms */
  created: number;
}

type DayAgg = {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
  cny: number;
  byModel: Map<string, UsageByDayModel>;
};

function emptyDayAgg(): DayAgg {
  return {
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    usd: 0,
    cny: 0,
    byModel: new Map(),
  };
}

/** 按 message 时间聚合 usage_by_day + first/last/span */
export function buildActivitySpan(
  messages: TimedPricingMessage[],
  fallbackLastMs?: number,
  fallbackFirstMs?: number,
): ActivitySpan {
  const byDay = new Map<string, DayAgg>();
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const msg of messages) {
    const ts = msg.created;
    if (!ts || !Number.isFinite(ts)) continue;
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;

    const day = dayjs(ts).format('YYYY-MM-DD');
    const inTokens = msg.tokens?.input || 0;
    const outTokens = msg.tokens?.output || 0;
    const cr = msg.tokens?.cacheRead || 0;
    const cw = msg.tokens?.cacheWrite || 0;
    const tokenSum = inTokens + outTokens + cr + cw;

    let usd = 0;
    let cny = 0;
    if (msg.modelID) {
      const cost = calculateMessageCost(msg);
      usd = cost.totalCost;
      cny = cost.cny;
    }

    let dayAgg = byDay.get(day);
    if (!dayAgg) {
      dayAgg = emptyDayAgg();
      byDay.set(day, dayAgg);
    }
    dayAgg.tokens += tokenSum;
    dayAgg.input += inTokens;
    dayAgg.output += outTokens;
    dayAgg.cacheRead += cr;
    dayAgg.cacheWrite += cw;
    dayAgg.usd += usd;
    dayAgg.cny += cny;

    if (msg.modelID) {
      const key = `${msg.providerID || 'unknown'}/${msg.modelID}`;
      const m = dayAgg.byModel.get(key) || {
        modelKey: key,
        tokens: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        usd: 0,
        cny: 0,
      };
      m.tokens += tokenSum;
      m.input += inTokens;
      m.output += outTokens;
      m.cacheRead += cr;
      m.cacheWrite += cw;
      m.usd += usd;
      m.cny += cny;
      dayAgg.byModel.set(key, m);
    }
  }

  if (!Number.isFinite(minTs) && fallbackFirstMs != null) minTs = fallbackFirstMs;
  if (!Number.isFinite(maxTs) && fallbackLastMs != null) maxTs = fallbackLastMs;
  if (!Number.isFinite(minTs) && Number.isFinite(maxTs)) minTs = maxTs;
  if (!Number.isFinite(maxTs) && Number.isFinite(minTs)) maxTs = minTs;
  if (!Number.isFinite(minTs)) {
    const now = Date.now();
    minTs = now;
    maxTs = now;
  }

  const first_active_at_iso = new Date(minTs).toISOString();
  const last_active_at_iso = new Date(maxTs).toISOString();
  const span_days = Math.max(
    1,
    dayjs(maxTs).startOf('day').diff(dayjs(minTs).startOf('day'), 'day') + 1,
  );

  const usage_by_day: UsageByDay[] = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, agg]) => ({
      date,
      tokens: agg.tokens,
      input: agg.input,
      output: agg.output,
      cacheRead: agg.cacheRead,
      cacheWrite: agg.cacheWrite,
      usd: agg.usd,
      cny: agg.cny,
      byModel: Array.from(agg.byModel.values()),
    }));

  return { first_active_at_iso, last_active_at_iso, span_days, usage_by_day };
}

/** 从 UnifiedMessage / OpenCode message 结构构建 */
export function buildActivitySpanFromUnifiedMessages(
  messages: any[],
  fallbackLastMs?: number,
  fallbackFirstMs?: number,
): ActivitySpan {
  const timed: TimedPricingMessage[] = [];
  for (const msg of messages) {
    const info = msg?.info || msg || {};
    const created = info.time?.created ?? info.time?.start ?? 0;
    if (!created) continue;
    const extracted = extractMessagePricingInput(msg);
    if (extracted) {
      timed.push({ ...extracted, created });
    } else {
      timed.push({
        created,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    }
  }
  return buildActivitySpan(timed, fallbackLastMs, fallbackFirstMs);
}

/** 从 OpenCode MessageTimingStat 构建 */
export function buildActivitySpanFromTimingStats(
  stats: Array<{
    created?: number;
    providerID?: string;
    modelID?: string;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  }>,
  fallbackLastMs?: number,
  fallbackFirstMs?: number,
): ActivitySpan {
  const timed: TimedPricingMessage[] = stats
    .filter(s => s.created && Number.isFinite(s.created))
    .map(s => ({
      created: s.created as number,
      providerID: s.providerID,
      modelID: s.modelID,
      tokens: {
        input: s.input || 0,
        output: s.output || 0,
        cacheRead: s.cacheRead || 0,
        cacheWrite: s.cacheWrite || 0,
      },
    }));
  return buildActivitySpan(timed, fallbackLastMs, fallbackFirstMs);
}
