/**
 * workbuddy 逐 LLM call 时长采样口径测试：
 * 事件仅在 call 结束后 flush，anchor 链 = user ts / 上一步 tool result ts
 */
import { describe, expect, it } from 'bun:test';
import { convertWorkbuddyEventsToMessages, collectWorkbuddyStepSamples } from './workbuddy-source';
import type { WorkbuddyJsonlEvent } from './workbuddy-code';

const T0 = 1_788_000_000_000;

describe('collectWorkbuddyStepSamples', () => {
  it('首步锚定 user ts，后续步锚定上一步 tool result ts（剔除工具执行时间）', () => {
    const events: WorkbuddyJsonlEvent[] = [
      { id: 'u1', type: 'message', role: 'user', timestamp: T0, content: [{ type: 'input_text', text: 'hi' }] },
      // call1: user 后 5s flush，tool 执行 15s
      { id: 'fc1', type: 'function_call', name: 'read', callId: 'c1', timestamp: T0 + 5_000, providerData: { messageId: 'm1' }, arguments: '{}' },
      { id: 'fr1', type: 'function_call_result', callId: 'c1', timestamp: T0 + 20_000, status: 'completed', output: 'ok', providerData: { messageId: 'm1' } },
      // call2: result 后 3s flush → stepMs 应为 3000 而非距 user 23s
      { id: 'fc2', type: 'function_call', name: 'edit', callId: 'c2', timestamp: T0 + 23_000, providerData: { messageId: 'm2' }, arguments: '{}' },
      { id: 'fr2', type: 'function_call_result', callId: 'c2', timestamp: T0 + 24_000, status: 'completed', output: 'done', providerData: { messageId: 'm2' } },
      // call3: 无 tool result 时锚 = 上一步 flush
      { id: 'a3', type: 'message', role: 'assistant', timestamp: T0 + 26_000, content: [{ type: 'output_text', text: 'fin' }], providerData: { messageId: 'm3' } },
    ];
    const msgs = convertWorkbuddyEventsToMessages('s1', events);
    const samples = collectWorkbuddyStepSamples(msgs);
    expect(samples.map((s) => s.stepMs)).toEqual([5_000, 3_000, 2_000]);
  });

  it('时间戳缺失/乱序样本 stepMs=0（由聚合层过滤）', () => {
    const events: WorkbuddyJsonlEvent[] = [
      { id: 'u1', type: 'message', role: 'user', timestamp: T0, content: [{ type: 'input_text', text: 'hi' }] },
      // flush 早于 anchor（异常数据）
      { id: 'a1', type: 'message', role: 'assistant', timestamp: T0 - 1000, content: [{ type: 'output_text', text: 'x' }], providerData: { messageId: 'm1' } },
    ];
    const samples = collectWorkbuddyStepSamples(convertWorkbuddyEventsToMessages('s1', events));
    expect(samples).toHaveLength(1);
    expect(samples[0].stepMs).toBe(0);
  });

  it('outputTokens 计入 reasoning token', () => {
    const events: WorkbuddyJsonlEvent[] = [
      { id: 'u1', type: 'message', role: 'user', timestamp: T0, content: [{ type: 'input_text', text: 'hi' }] },
      {
        id: 'a1', type: 'message', role: 'assistant', timestamp: T0 + 4_000,
        content: [{ type: 'output_text', text: 'yo' }],
        providerData: {
          messageId: 'm1',
          rawUsage: { prompt_tokens: 10, completion_tokens: 42, completion_tokens_details: { reasoning_tokens: 8 } },
        },
      },
    ];
    const samples = collectWorkbuddyStepSamples(convertWorkbuddyEventsToMessages('s1', events));
    expect(samples[0].stepMs).toBe(4_000);
    expect(samples[0].outputTokens).toBe(50);
  });
});
