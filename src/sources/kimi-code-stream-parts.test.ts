/**
 * kimi content.part 是流式 delta, 连续同类型必须拼接, 不能各成一块再用 \n 连接
 */
import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendKimiStreamedPart, listKimiCodeMessages } from './kimi-code';

describe('kimi streamed content.part 合并', () => {
  test('连续 text / reasoning 拼接, 空串忽略, 被 tool 打断则新开', () => {
    const parts: Array<{ type: string; text?: string; state?: string }> = [];
    appendKimiStreamedPart(parts, 'reasoning', 'plan');
    appendKimiStreamedPart(parts, 'reasoning', ' A');
    appendKimiStreamedPart(parts, 'text', '我先看');
    appendKimiStreamedPart(parts, 'text', '');
    appendKimiStreamedPart(parts, 'text', '一下这个目录');
    appendKimiStreamedPart(parts, 'text', '的整体情况。\n\n');
    parts.push({ type: 'tool' });
    appendKimiStreamedPart(parts, 'text', '再看消费方');
    expect(parts).toEqual([
      { type: 'reasoning', text: 'plan A', state: 'done' },
      { type: 'text', text: '我先看一下这个目录的整体情况。\n\n', state: 'done' },
      { type: 'tool' },
      { type: 'text', text: '再看消费方', state: 'done' },
    ]);
  });

  test('listKimiCodeMessages 把 token delta 收成一条 text part', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-stream-'));
    const dir = path.join(root, 'sessions', 'wd_t', 'session_stream_delta');
    fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    const loop = (event: Record<string, unknown>, time: number) =>
      JSON.stringify({ type: 'context.append_loop_event', agentId: 'main', event, time });
    const su = { turnId: '0', step: 1, stepUuid: 'step-1' };
    const wire = [
      loop({ type: 'step.begin', uuid: 'b1', ...su }, 1000),
      loop({ type: 'content.part', uuid: 't1', ...su, part: { type: 'think', think: 'check dir' } }, 1001),
      loop({ type: 'content.part', uuid: 'p1', ...su, part: { type: 'text', text: '我先看一下这个目录' } }, 1002),
      loop({ type: 'content.part', uuid: 'e1', ...su, part: { type: 'think', think: '' } }, 1003),
      loop({ type: 'content.part', uuid: 'p2', ...su, part: { type: 'text', text: '的整体情况。\n\n' } }, 1004),
      loop({ type: 'step.end', uuid: 'e', ...su, finishReason: 'end_turn' }, 1005),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), wire);

    const msgs = await listKimiCodeMessages({ sessionId: 'session_stream_delta', sessionDir: dir });
    const asst = msgs.find(m => m.role === 'assistant');
    expect(asst).toBeDefined();
    const textParts = (asst!.parts || []).filter(p => p.type === 'text');
    const thinkParts = (asst!.parts || []).filter(p => p.type === 'reasoning');
    expect(textParts).toHaveLength(1);
    expect(thinkParts).toHaveLength(1);
    expect(textParts[0].text).toBe('我先看一下这个目录的整体情况。\n\n');
    expect(asst!.text).toBe('我先看一下这个目录的整体情况。\n\n');
    expect(asst!.text).not.toContain('目录\n的');
    expect(thinkParts[0].text).toBe('check dir');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
