/**
 * kimi 429 限流重试: 失败 attempt 不产出空 message, retry 数据聚合到下一条真实 assistant message
 */
import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listKimiCodeMessages } from './kimi-code';

describe('kimi turn.step.retrying (429 限流)', () => {
  test('失败 attempt 被 skip, retryCount/waitMs/rateLimit429 聚合到成功 attempt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-ratelimit-'));
    const dir = path.join(root, 'sessions', 'wd_t', 'session_rate_limit');
    fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    const loop = (event: Record<string, unknown>, time: number) =>
      JSON.stringify({ type: 'context.append_loop_event', agentId: 'main', event, time });
    // 顶层 retrying 事件 (不在 context.append_loop_event 内)
    const retrying = (stepId: string, delayMs: number, failedAttempt: number, time: number) =>
      JSON.stringify({
        type: 'turn.step.retrying', agentId: 'main', turnId: 0, step: failedAttempt + 1,
        stepId, failedAttempt, nextAttempt: failedAttempt + 2, maxAttempts: 10,
        delayMs, errorName: 'APIProviderRateLimitError',
        errorMessage: '429 rate_limit_error', statusCode: 429, time,
      });
    const su = { turnId: '0', step: 1 };
    // attempt1 (失败, 无 lat/usage) → retrying → attempt2 (失败) → retrying → attempt3 (成功)
    const wire = [
      loop({ type: 'turn.prompt', input: [], origin: { kind: 'user' }, time: 1000 }, 1000),
      // user 消息
      JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [], origin: { kind: 'user' } }, time: 1001 }),
      loop({ type: 'step.begin', uuid: 'a1', ...su, step: 2 }, 1010),
      loop({ type: 'step.end', uuid: 'a1', ...su, step: 2 }, 1012),
      retrying('a1', 501.4, 1, 1013),
      loop({ type: 'step.begin', uuid: 'a2', ...su, step: 3 }, 1514),
      loop({ type: 'step.end', uuid: 'a2', ...su, step: 3 }, 1516),
      retrying('a2', 1068.6, 2, 1517),
      loop({ type: 'step.begin', uuid: 'a3', ...su, step: 4 }, 2585),
      loop({ type: 'content.part', uuid: 't1', ...su, step: 4, stepUuid: 'a3', part: { type: 'text', text: 'ok' } }, 2600),
      loop({ type: 'step.end', uuid: 'a3', ...su, step: 4, finishReason: 'end_turn', llmFirstTokenLatencyMs: 800, llmStreamDurationMs: 1200, usage: { inputOther: 100, output: 20, inputCacheRead: 0, inputCacheCreation: 0 } }, 3800),
      JSON.stringify({ type: 'usage.record', model: 'minimax-cn-coding-plan/MiniMax-M3', usage: { inputOther: 100, output: 20, inputCacheRead: 0, inputCacheCreation: 0 }, time: 3801 }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), wire);

    const msgs = await listKimiCodeMessages({ sessionId: 'session_rate_limit', sessionDir: dir });
    const asst = msgs.filter(m => m.role === 'assistant');
    // 失败 attempt 不产出空 message
    expect(asst).toHaveLength(1);
    const a = asst[0]!;
    expect(a.text).toBe('ok');
    expect(a.latencyMs).toBe(800);
    expect(a.retryCount).toBe(2);
    expect(a.retryWaitMs).toBe(Math.round(501.4 + 1068.6));
    expect(a.rateLimit429).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('turn 全失败无载体 → retry carry 到下一个 turn 的成功 message', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-carry-'));
    const dir = path.join(root, 'sessions', 'wd_t', 'session_carry');
    fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    const loop = (event: Record<string, unknown>, time: number) =>
      JSON.stringify({ type: 'context.append_loop_event', agentId: 'main', event, time });
    const retrying = (stepId: string, delayMs: number, failedAttempt: number, turn: number, time: number) =>
      JSON.stringify({
        type: 'turn.step.retrying', agentId: 'main', turnId: turn, step: failedAttempt + 1,
        stepId, failedAttempt, nextAttempt: failedAttempt + 2, maxAttempts: 10,
        delayMs, errorName: 'APIProviderRateLimitError', errorMessage: '429', statusCode: 429, time,
      });
    // turn0 全失败(1 次 retry)，turn1 开头先失败 1 次再成功
    const wire = [
      JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'q1' }], toolCalls: [], origin: { kind: 'user' } }, time: 1000 }),
      loop({ type: 'step.begin', uuid: 't0a1', turnId: '0', step: 1 }, 1010),
      loop({ type: 'step.end', uuid: 't0a1', turnId: '0', step: 1 }, 1012),
      retrying('t0a1', 500, 1, 0, 1013),
      JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'q2' }], toolCalls: [], origin: { kind: 'user' } }, time: 2000 }),
      loop({ type: 'step.begin', uuid: 't1a1', turnId: '1', step: 1 }, 2010),
      loop({ type: 'step.end', uuid: 't1a1', turnId: '1', step: 1 }, 2012),
      retrying('t1a1', 700, 1, 1, 2013),
      loop({ type: 'step.begin', uuid: 't1a2', turnId: '1', step: 2 }, 2713),
      loop({ type: 'content.part', uuid: 't1p1', turnId: '1', step: 2, stepUuid: 't1a2', part: { type: 'text', text: 'done' } }, 2720),
      loop({ type: 'step.end', uuid: 't1a2', turnId: '1', step: 2, finishReason: 'end_turn', llmFirstTokenLatencyMs: 300, llmStreamDurationMs: 500, usage: { inputOther: 50, output: 10, inputCacheRead: 0, inputCacheCreation: 0 } }, 3220),
      JSON.stringify({ type: 'usage.record', model: 'm', usage: { inputOther: 50, output: 10, inputCacheRead: 0, inputCacheCreation: 0 }, time: 3221 }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), wire);

    const msgs = await listKimiCodeMessages({ sessionId: 'session_carry', sessionDir: dir });
    const asst = msgs.filter(m => m.role === 'assistant');
    expect(asst).toHaveLength(1);
    expect(asst[0]!.text).toBe('done');
    expect(asst[0]!.retryCount).toBe(2);
    expect(asst[0]!.retryWaitMs).toBe(1200);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('无 retrying 的普通 step 不带 retry 字段', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-clean-'));
    const dir = path.join(root, 'sessions', 'wd_t', 'session_clean');
    fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    const loop = (event: Record<string, unknown>, time: number) =>
      JSON.stringify({ type: 'context.append_loop_event', agentId: 'main', event, time });
    const su = { turnId: '0', step: 1 };
    const wire = [
      loop({ type: 'step.begin', uuid: 'b1', ...su }, 1000),
      loop({ type: 'step.end', uuid: 'b1', ...su, finishReason: 'end_turn', llmFirstTokenLatencyMs: 500, usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 } }, 2000),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), wire);

    const msgs = await listKimiCodeMessages({ sessionId: 'session_clean', sessionDir: dir });
    const asst = msgs.find(m => m.role === 'assistant');
    expect(asst).toBeDefined();
    expect(asst!.retryCount).toBeUndefined();
    expect(asst!.retryWaitMs).toBeUndefined();
    expect(asst!.rateLimit429).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
