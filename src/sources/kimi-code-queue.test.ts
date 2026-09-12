/**
 * kimi 运行中插入 / 打断：prompt.steered + interruption injection
 */
import { describe, expect, test } from 'bun:test';
import { classifyKimiUserQueueOrigin } from './kimi-code';

const user = (text: string, time: number) => ({
  type: 'context.append_message',
  time,
  message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } },
});

describe('classifyKimiUserQueueOrigin', () => {
  test('prompt.steered → insert；skill turn.steer 忽略', () => {
    const events = [
      user('先做 A', 1),
      { type: 'prompt.steered', content: [{ type: 'text', text: '插一句' }], time: 2 },
      user('插一句', 3),
      { type: 'turn.steer', origin: { kind: 'user' }, time: 4 },
    ];
    expect(classifyKimiUserQueueOrigin(events, 0)).toBeUndefined();
    expect(classifyKimiUserQueueOrigin(events, 2)).toBe('insert');
  });

  test('interruption injection / turn.cancel → interrupt', () => {
    const events = [
      user('q1', 1),
      { type: 'turn.cancel', reason: 'user_cancelled', time: 2 },
      {
        type: 'context.append_message',
        time: 3,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<system-reminder>interrupted' }],
          origin: { kind: 'injection', variant: 'interruption' },
        },
      },
      user('怎么这么慢？', 4),
    ];
    expect(classifyKimiUserQueueOrigin(events, 3)).toBe('interrupt');
  });

  test('上一条的 turn.steer 不误标下一条', () => {
    const events = [
      user('q1', 1),
      { type: 'prompt.steered', time: 2 },
      user('插一句', 3),
      { type: 'turn.steer', origin: { kind: 'user' }, time: 4 },
      user('1+2', 5),
    ];
    expect(classifyKimiUserQueueOrigin(events, 2)).toBe('insert');
    expect(classifyKimiUserQueueOrigin(events, 4)).toBeUndefined();
  });
});
