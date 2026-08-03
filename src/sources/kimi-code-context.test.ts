/**
 * Kimi Code CLI Context Trend 集成测试
 *
 * 用真实本地数据检验 Kimi session 的 context 计算与趋势表现。
 */

import { describe, it, expect } from 'bun:test';
import { getOverallStats, OpenCodeMessage } from '../core';

import {
  listKimiCodeSessions,
  listKimiCodeMessages,
  getKimiSessionUsageSummary,
} from './kimi-code';
import { getSessionDetail } from './index';

const TEST_SESSION_ID = 'session_7dba5c10-3e2d-4517-8725-0cce02c0dc3c';

describe('Kimi Code CLI Context Trend 集成测试', () => {
  it('应该能列出 Kimi sessions 并找到目标 session', async () => {
    const sessions = await listKimiCodeSessions();
    const found = sessions.find((s) => s.sessionId === TEST_SESSION_ID);

    expect(found).toBeDefined();
    console.log(`找到目标 session: ${found?.title}`);
    console.log(`  sessionDir: ${found?.sessionDir}`);
  });

  it('应该能获取目标 session 的原始消息与统一格式消息', async () => {
    const rawMessages = await listKimiCodeMessages({ sessionId: TEST_SESSION_ID });
    const detail = await getSessionDetail({ sessionId: TEST_SESSION_ID, source: 'kimi' });

    expect(rawMessages.length).toBeGreaterThan(0);
    expect(detail).toBeDefined();
    expect(detail!.messages.length).toBeGreaterThan(0);

    console.log(`\n原始消息数: ${rawMessages.length}`);
    console.log(`统一消息数: ${detail!.messages.length}`);
  });

  it('应该输出 messages 的 token 结构', async () => {
    const detail = await getSessionDetail({ sessionId: TEST_SESSION_ID, source: 'kimi' });
    const messages = detail!.messages as OpenCodeMessage[];

    console.log('\n--- Messages Token 结构 ---');
    console.log('idx\trole\tid\t\t\tparentID\t\tcreated\t\t\t\t total\t input\t output\t cacheRead');
    messages.forEach((m, i) => {
      const info = m.info;
      const t = info.tokens || {};
      const c = t.cache || {};
      const time = new Date(info.time.created).toISOString();
      console.log(
        `${i}\t${info.role}\t${info.id.slice(0, 8)}\t\t${(info.parentID || '').slice(0, 8) || '-'}\t\t${time}\t${t.total ?? '-'}\t${t.input ?? '-'}\t${t.output ?? '-'}\t${c.read ?? '-'}`
      );
    });

    // 基本断言：所有 assistant message 的 token 字段非负，且包含 context 标记
    const assistantMsgs = messages.filter((m) => m.info.role === 'assistant');
    for (const m of assistantMsgs) {
      const t = m.info.tokens;
      expect(t).toBeDefined();
      expect(t!.input).toBeGreaterThanOrEqual(0);
      expect(t!.output).toBeGreaterThanOrEqual(0);
      expect(t!.cache?.read ?? 0).toBeGreaterThanOrEqual(0);
      expect(t!.cache?.write ?? 0).toBeGreaterThanOrEqual(0);
      expect(t!.context).toBeDefined();
      expect(t!.context!.input).toBeGreaterThanOrEqual(0);
      expect(t!.context!.cacheRead).toBeGreaterThanOrEqual(0);
      expect(t!.context!.total).toBe(t!.context!.input + t!.context!.cacheRead);
      // context 应该小于等于总消耗(input + cache.read + output)
      expect(t!.context!.total).toBeLessThanOrEqual(t!.total!);
    }
  });

  it('应该输出 trends 并验证 contextSize 使用最终 step 的上下文', async () => {
    const detail = await getSessionDetail({ sessionId: TEST_SESSION_ID, source: 'kimi' });
    const messages = detail!.messages as OpenCodeMessage[];
    const stats = getOverallStats(messages);

    console.log('\n--- Trends (contextSize = tokens.context ? tokens.context.input + cacheRead : input + cache.read) ---');
    const table = stats.trends!.map((t, i) => ({
      idx: i,
      userMsgId: t.userMsgId.slice(0, 8),
      endTime: new Date(t.endTime).toISOString().slice(11, 23),
      contextSize: t.contextSize,
      deltaTotal: t.delta.total,
      deltaInput: t.delta.input,
      deltaOutput: t.delta.output,
      deltaCacheRead: t.delta.cacheRead,
      msgCount: t.msgCount,
    }));
    console.table(table);

    // 计算其他口径供对比
    console.log('\n--- 其他 context 口径对比 ---');
    let cumInputCache = 0;
    let cumTotal = 0;
    const altTable = stats.trends!.map((t, i) => {
      cumInputCache += t.delta.input + t.delta.cacheRead;
      cumTotal += t.delta.total;
      return {
        idx: i,
        'tokens.context': t.contextSize,
        'input+cache.read (fallback)': t.delta.input + t.delta.cacheRead,
        'input+cache.read+output': t.delta.input + t.delta.cacheRead + t.delta.output,
        'cum(input+cache.read)': cumInputCache,
        'cum(total)': cumTotal,
      };
    });
    console.table(altTable);

    expect(stats.trends!.length).toBeGreaterThan(0);

    // 验证：每个 trend 的 contextSize 应该小于等于该轮 delta.input + delta.cache.read
    // (因为 context 只取最终 step，而不是所有 step 累加)
    for (const t of stats.trends!) {
      expect(t.contextSize).toBeLessThanOrEqual(t.delta.input + t.delta.cacheRead + 1);
    }

    // 验证：contextSize 应该呈现"增长到 200K+ 后回落"的宏观趋势
    // 找到第一个 contextSize >= 200K 的 trend，其之后至少有一个 trend 的 contextSize 明显回落(<100K)
    const firstHighIdx = stats.trends!.findIndex(t => t.contextSize >= 200_000);
    if (firstHighIdx >= 0) {
      const hasDropAfter = stats.trends!.slice(firstHighIdx + 1).some(t => t.contextSize < 100_000);
      expect(hasDropAfter).toBe(true);
    }
  });

  it('应该对比 session 级用量统计的两种来源', async () => {
    const detail = await getSessionDetail({ sessionId: TEST_SESSION_ID, source: 'kimi' });
    const messages = detail!.messages as OpenCodeMessage[];
    const stats = getOverallStats(messages);

    // 从 messages 累加
    const fromMessages = {
      input: stats.inputTokens,
      output: stats.outputTokens,
      cacheRead: stats.cacheReadTokens,
      cacheWrite: stats.cacheWriteTokens,
      total: stats.totalTokens,
    };

    // 从 wire.jsonl 直接累加所有 usage.record
    const fromWire = await getKimiSessionUsageSummary(TEST_SESSION_ID);

    console.log('\n--- Session 级用量对比 ---');
    console.log('从 messages 累加:', fromMessages);
    console.log('从 wire 直接累加:', {
      input: fromWire.inputOther,
      output: fromWire.output,
      cacheRead: fromWire.inputCacheRead,
      cacheWrite: fromWire.inputCacheCreation,
      total: fromWire.total,
    });

    // 允许少量误差：messages 累加应该与 wire 直接累加一致
    expect(fromMessages.input).toBeCloseTo(fromWire.inputOther, 0);
    expect(fromMessages.output).toBeCloseTo(fromWire.output, 0);
    expect(fromMessages.cacheRead).toBeCloseTo(fromWire.inputCacheRead, 0);
    expect(fromMessages.cacheWrite).toBeCloseTo(fromWire.inputCacheCreation, 0);
  });
});
