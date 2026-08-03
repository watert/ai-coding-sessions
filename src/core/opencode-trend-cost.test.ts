import { describe, expect, it } from 'bun:test';
import {
  enrichTokenTrendsWithCost,
  getOverallStats,
  reconcileTokenStatsWithSessionPricing,
  resolveMessageContextSize,
  type OpenCodeMessage,
  type ModelPricing,
  type SessionExportPricing,
} from './opencode';

function msg(partial: {
  id: string;
  role: 'user' | 'assistant';
  parentID?: string;
  modelID?: string;
  providerID?: string;
  tokens?: { input: number; output: number; reasoning?: number; cache?: { read?: number; write?: number }; total?: number };
}): OpenCodeMessage {
  const tokens = partial.tokens
    ? {
        ...partial.tokens,
        total: partial.tokens.total
          ?? (partial.tokens.input + partial.tokens.output + (partial.tokens.cache?.read || 0) + (partial.tokens.cache?.write || 0)),
      }
    : undefined;
  return {
    id: partial.id,
    info: {
      id: partial.id,
      role: partial.role,
      parentID: partial.parentID,
      sessionID: 's1',
      modelID: partial.modelID,
      providerID: partial.providerID,
      time: { created: 1000, completed: 2000 },
      tokens: tokens as any,
    },
    parts: [{ type: 'text', text: 'x' }],
  } as any;
}

const fixedPricing: ModelPricing = {
  id: 'test-model',
  name: 'Test',
  totalContext: '128K',
  maxOutput: '8K',
  priceCurrency: 'USD',
  inputPrice: 1,
  outputPrice: 2,
  cacheReadPrice: 0.1,
  cacheWritePrice: 0.5,
};

describe('enrichTokenTrendsWithCost', () => {
  const messages: OpenCodeMessage[] = [
    msg({ id: 'u1', role: 'user' }),
    msg({
      id: 'a1', role: 'assistant', parentID: 'u1',
      providerID: 'xai', modelID: 'grok-4',
      tokens: { input: 1_000_000, output: 500_000, cache: { read: 0, write: 0 } },
    }),
    msg({ id: 'u2', role: 'user' }),
    msg({
      id: 'a2', role: 'assistant', parentID: 'u2',
      providerID: 'xai', modelID: 'grok-4',
      tokens: { input: 2_000_000, output: 0, cache: { read: 1_000_000, write: 0 } },
    }),
  ];

  it('非 AUTO：固定单价，合计等于整段 token 计价', () => {
    const stats = getOverallStats(messages);
    const enriched = enrichTokenTrendsWithCost(messages, stats.trends!, { pricing: fixedPricing });
    const sum = enriched.reduce((s, t) => s + (t.deltaCost?.total || 0), 0);
    // round1: in 1 + out 0.5*2 = 2; round2: in 2 + cacheRead 0.1 = 2.1 → total 4.1
    expect(sum).toBeCloseTo(4.1, 6);
    expect(enriched[enriched.length - 1].endCost?.total).toBeCloseTo(4.1, 6);
  });

  it('AUTO：用 session.pricing.details 反推，合计=details.usd', () => {
    const sessionPricing: SessionExportPricing = {
      usd: 3.5,
      cny: 25.2,
      details: [{
        modelKey: 'xai/grok-4',
        input: 3_000_000,
        output: 500_000,
        cacheRead: 1_000_000,
        cacheWrite: 0,
        usd: 3.5,
        cny: 25.2,
        inputCost: 3.0,
        outputCost: 0.4,
        cacheReadCost: 0.1,
        cacheWriteCost: 0,
      }],
    };
    const stats = getOverallStats(messages);
    const enriched = enrichTokenTrendsWithCost(messages, stats.trends!, { sessionPricing });
    const sum = enriched.reduce((s, t) => s + (t.deltaCost?.total || 0), 0);
    expect(sum).toBeCloseTo(3.5, 6);
    // round1: 1M*1 + 0.5M*0.8 = 1 + 0.4 = 1.4
    expect(enriched[0].deltaCost?.total).toBeCloseTo(1.4, 6);
    // round2: 2M*1 + 1M*0.1 = 2.1
    expect(enriched[1].deltaCost?.total).toBeCloseTo(2.1, 6);
  });

  it('不计 reasoning 为额外输出费', () => {
    const withReason: OpenCodeMessage[] = [
      msg({ id: 'u1', role: 'user' }),
      msg({
        id: 'a1', role: 'assistant', parentID: 'u1',
        providerID: 'xai', modelID: 'grok-4',
        tokens: { input: 0, output: 1_000_000, reasoning: 1_000_000 },
      }),
    ];
    const stats = getOverallStats(withReason);
    const enriched = enrichTokenTrendsWithCost(withReason, stats.trends!, { pricing: fixedPricing });
    // 只按 output 1M * $2，不把 reasoning 再加一遍
    expect(enriched[0].deltaCost?.total).toBeCloseTo(2, 6);
    expect(enriched[0].deltaCost?.reasoning).toBe(0);
  });
});

describe('resolveMessageContextSize / trend context', () => {
  it('优先 context.total，避免 Grok 计费 input+cacheRead 冒充窗口', () => {
    expect(resolveMessageContextSize({
      total: 15684,
      input: 446,
      cache: { read: 15197 },
      context: { total: 55152, input: 446, cacheRead: 15197 },
    })).toBe(55152);

    // 无 total 时回退 input+cacheRead
    expect(resolveMessageContextSize({
      total: 100,
      input: 40,
      cache: { read: 60 },
      context: { total: 0, input: 40, cacheRead: 60 },
    })).toBe(100);

    // 无 context 时用计费分项
    expect(resolveMessageContextSize({
      total: 100,
      input: 40,
      cache: { read: 60 },
    })).toBe(100);
  });

  it('getOverallStats trends.contextSize 用 context.total（Grok 窗口）', () => {
    const messages: OpenCodeMessage[] = [
      msg({ id: 'u1', role: 'user' }),
      msg({
        id: 'a1', role: 'assistant', parentID: 'u1',
        providerID: 'xai', modelID: 'grok-4.5',
        tokens: {
          input: 446,
          output: 41,
          total: 15684,
          cache: { read: 15197 },
        },
      }),
    ];
    // 补上 context（msg helper 未透传 context 字段）
    (messages[1].info.tokens as any).context = {
      total: 55152,
      input: 446,
      cacheRead: 15197,
    };

    const stats = getOverallStats(messages);
    expect(stats.trends?.[0].contextSize).toBe(55152);
    // 旧逻辑 input+cacheRead=15643，会错
    expect(stats.trends?.[0].contextSize).not.toBe(446 + 15197);
    expect(stats.contextMessage?.totalTokens).toBe(55152);
  });

  it('无 assistant 的 user 不进 trends（避免 compact 残坑占位）', () => {
    const messages: OpenCodeMessage[] = [
      msg({ id: 'u0', role: 'user' }), // 无 reply
      msg({ id: 'u1', role: 'user' }),
      msg({
        id: 'a1', role: 'assistant', parentID: 'u1',
        tokens: { input: 10, output: 5, total: 15 },
      }),
    ];
    const stats = getOverallStats(messages);
    expect(stats.trends?.length).toBe(1);
    expect(stats.trends?.[0].userMsgId).toBe('u1');
  });

  it('contextSize 取桶内峰值而非仅末条', () => {
    const messages: OpenCodeMessage[] = [
      msg({ id: 'u1', role: 'user' }),
      msg({
        id: 'a1', role: 'assistant', parentID: 'u1',
        tokens: { input: 1, output: 1, total: 2 },
      }),
      msg({
        id: 'a2', role: 'assistant', parentID: 'u1',
        tokens: { input: 1, output: 1, total: 2 },
      }),
    ];
    (messages[1].info.tokens as any).context = { total: 200_000, input: 1, cacheRead: 0 };
    (messages[2].info.tokens as any).context = { total: 50_000, input: 1, cacheRead: 0 }; // 末条回落
    const stats = getOverallStats(messages);
    expect(stats.trends?.[0].contextSize).toBe(200_000);
  });
});

describe('reconcileTokenStatsWithSessionPricing', () => {
  it('用 pricing.details 覆盖低估的 message 累加（Cost Distribution 同源）', () => {
    // message 只看见少量 token
    const messages: OpenCodeMessage[] = [
      msg({ id: 'u1', role: 'user' }),
      msg({
        id: 'a1', role: 'assistant', parentID: 'u1',
        providerID: 'xai', modelID: 'grok-4.5',
        tokens: { input: 100, output: 10, cache: { read: 1000 } },
      }),
    ];
    const raw = getOverallStats(messages);
    expect(raw.cacheReadTokens).toBe(1000);

    // session 总账：真实 cache 大很多 + 静态表分项
    const sessionPricing: SessionExportPricing = {
      usd: 5.6644192,
      cny: 38.3,
      details: [
        {
          modelKey: 'xai/grok-4.5',
          input: 292130,
          output: 101266,
          cacheRead: 14_908_544,
          cacheWrite: 0,
          usd: 5.6644192,
          cny: 38.3,
          inputCost: 0.58426,
          outputCost: 0.607596,
          cacheReadCost: 4.4725632,
          cacheWriteCost: 0,
        },
      ],
    };

    const fixed = reconcileTokenStatsWithSessionPricing(raw, sessionPricing, {
      total_tokens: 15_301_940,
      total_input: 292130,
      total_output: 101266,
      total_cache_read: 14_908_544,
    });

    expect(fixed.cacheReadTokens).toBe(14_908_544);
    expect(fixed.inputTokens).toBe(292130);
    expect(fixed.outputTokens).toBe(101266);
    expect(fixed.totalTokens).toBe(292130 + 101266 + 14_908_544);
    expect(fixed.inputCost).toBeCloseTo(0.58426, 6);
    expect(fixed.outputCost).toBeCloseTo(0.607596, 6);
    expect(fixed.cacheReadCost).toBeCloseTo(4.4725632, 6);
    expect(fixed.totalCost).toBeCloseTo(5.6644192, 6);
    // cacheRead $0.3/M
    expect(fixed.cacheReadCost / fixed.cacheReadTokens * 1e6).toBeCloseTo(0.3, 6);
    expect(fixed.models[0].modelID).toBe('grok-4.5');
    expect(fixed.models[0].cacheReadTokens).toBe(14_908_544);
    expect(fixed.models[0].cacheReadCost).toBeCloseTo(4.4725632, 6);
    // trends 保留
    expect(fixed.trends?.length).toBe(raw.trends?.length);
  });
});
