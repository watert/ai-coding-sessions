/**
 * checkSessionStatus 纯函数边界（不依赖本机 OpenCode SQLite）
 */
import { describe, expect, it } from 'bun:test';
import { checkSessionStatus, determineSessionStatusFromLastMessage } from './opencode';

function msg(partial: {
  role: string;
  finish?: string;
  error?: unknown;
  completed?: number;
  parts?: any[];
  compaction?: boolean;
}): any {
  return {
    info: {
      id: 'm',
      role: partial.role,
      finish: partial.finish,
      error: partial.error,
      compaction: partial.compaction,
      time: {
        created: 1000,
        ...(partial.completed != null ? { completed: partial.completed } : {}),
      },
    },
    parts: partial.parts ?? [{ type: 'text', text: 'x' }],
  };
}

describe('checkSessionStatus', () => {
  it('空消息 → done', () => {
    expect(checkSessionStatus([])).toBe('done');
  });

  it('最后是 user → in-progress', () => {
    expect(checkSessionStatus([
      msg({ role: 'user' }),
    ])).toBe('in-progress');
  });

  it('assistant finish=stop + completed → done', () => {
    expect(checkSessionStatus([
      msg({ role: 'user' }),
      msg({ role: 'assistant', finish: 'stop', completed: 2000 }),
    ])).toBe('done');
  });

  it('finish=tool-calls → in-progress', () => {
    expect(checkSessionStatus([
      msg({ role: 'assistant', finish: 'tool-calls', parts: [
        { type: 'tool', tool: 'Read', state: { status: 'completed' } },
      ] }),
    ])).toBe('in-progress');
  });

  it('tool calling/running → in-progress', () => {
    expect(checkSessionStatus([
      msg({
        role: 'assistant',
        finish: 'stop',
        completed: 2000,
        parts: [{ type: 'tool', tool: 'Bash', state: { status: 'calling' } }],
      }),
    ])).toBe('in-progress');

    expect(checkSessionStatus([
      msg({
        role: 'assistant',
        parts: [{ type: 'tool', tool: 'Bash', state: { status: 'running' } }],
      }),
    ])).toBe('in-progress');
  });

  it('MessageAbortedError → aborted', () => {
    expect(checkSessionStatus([
      msg({ role: 'assistant', error: { name: 'MessageAbortedError' } }),
    ])).toBe('aborted');
    expect(checkSessionStatus([
      msg({ role: 'assistant', error: 'Aborted by user' }),
    ])).toBe('aborted');
  });

  it('其它 error → error', () => {
    expect(checkSessionStatus([
      msg({ role: 'assistant', error: { name: 'ProviderError', message: 'rate limit' } }),
    ])).toBe('error');
  });

  it('compact 摘要 assistant → done', () => {
    expect(checkSessionStatus([
      msg({
        role: 'assistant',
        compaction: true,
        parts: [{ type: 'text', text: '[Context Compacted] summary' }],
      }),
    ])).toBe('done');
  });

  it('compact 触发但尚无摘要（user）→ in-progress', () => {
    expect(checkSessionStatus([
      msg({
        role: 'user',
        parts: [{ type: 'text', text: '[Context Compacted]' }],
      }),
    ])).toBe('in-progress');
  });

  it('无 finish 但有 completed → done；无 completed → in-progress', () => {
    expect(checkSessionStatus([
      msg({ role: 'assistant', completed: 2000 }),
    ])).toBe('done');
    expect(checkSessionStatus([
      msg({ role: 'assistant' }), // no completed
    ])).toBe('in-progress');
  });

  it('parts 为空 → in-progress', () => {
    expect(checkSessionStatus([
      msg({ role: 'assistant', finish: undefined, parts: [] }),
    ])).toBe('in-progress');
  });

  it('finish=interrupted 空 parts → aborted（kimi user_cancelled）', () => {
    expect(checkSessionStatus([
      msg({
        role: 'assistant',
        finish: 'tool-calls',
        completed: 2000,
        parts: [{ type: 'tool', tool: 'Bash', state: { status: 'completed' } }],
      }),
      msg({ role: 'assistant', finish: 'interrupted', completed: 3000, parts: [] }),
    ])).toBe('aborted');
  });

  it('finish=interrupted 即使有 calling tool → aborted', () => {
    expect(checkSessionStatus([
      msg({
        role: 'assistant',
        finish: 'interrupted',
        completed: 2000,
        parts: [{ type: 'tool', tool: 'Bash', state: { status: 'calling' } }],
      }),
    ])).toBe('aborted');
  });

  it('tool 失败不算 session error（只看 message.error）', () => {
    expect(checkSessionStatus([
      msg({
        role: 'assistant',
        finish: 'stop',
        completed: 2000,
        parts: [{ type: 'tool', tool: 'Bash', state: { status: 'error', error: 'exit 1' } }],
      }),
    ])).toBe('done');
  });

  it('list compact last_message（无 parts 包装）finish=stop → done', () => {
    expect(determineSessionStatusFromLastMessage({
      role: 'assistant',
      finish: 'stop',
      time: { completed: 2000 },
    })).toBe('done');
  });

  it('list compact last_message 无 finish/completed → in-progress', () => {
    expect(determineSessionStatusFromLastMessage({
      role: 'assistant',
      time: { created: 1000 },
    })).toBe('in-progress');
  });

  it('list compact last_message finish=interrupted → aborted', () => {
    expect(determineSessionStatusFromLastMessage({
      role: 'assistant',
      finish: 'interrupted',
      time: { completed: 2000 },
    })).toBe('aborted');
  });

  it('list compact last_message compaction assistant → done', () => {
    expect(determineSessionStatusFromLastMessage({
      role: 'assistant',
      agent: 'compaction',
      mode: 'compaction',
    })).toBe('done');
  });

  it('历史消息有 running 后台 tool + 最后是 stop 文本 → in-progress', () => {
    expect(checkSessionStatus([
      msg({
        role: 'assistant',
        finish: 'tool-calls',
        parts: [{ type: 'tool', tool: 'Bash', state: { status: 'running' } }],
      }),
      msg({ role: 'assistant', finish: 'stop', completed: 3000 }),
    ])).toBe('in-progress');
  });
});
