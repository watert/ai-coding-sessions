import { describe, expect, test } from 'bun:test';
import {
  normalizeCursorToolName,
  parseCursorToolParams,
  cursorToolResultText,
  type CursorBubble,
} from './cursor-code';
import {
  convertCursorBubblesToMessages,
  convertCursorTranscriptToMessages,
  applyCursorContextEstimateToMessages,
  extractCursorContextEstimate,
} from './cursor-source';
import type { CursorComposerData } from './cursor-code';

describe('cursor tool normalize', () => {
  test('maps common Cursor tool names', () => {
    expect(normalizeCursorToolName('run_terminal_command_v2')).toBe('Bash');
    expect(normalizeCursorToolName('read_file_v2')).toBe('Read');
    expect(normalizeCursorToolName('glob_file_search')).toBe('Glob');
    expect(normalizeCursorToolName('ripgrep_raw_search')).toBe('Grep');
    expect(normalizeCursorToolName('custom_thing')).toBe('custom_thing');
  });

  test('parse params + result text', () => {
    expect(parseCursorToolParams('{"command":"ls"}')).toEqual({ command: 'ls' });
    expect(cursorToolResultText('{"output":"ok","rejected":false}')).toBe('ok');
    expect(cursorToolResultText({ contents: 'file body' })).toBe('file body');
  });
});

describe('convertCursorBubblesToMessages', () => {
  test('splits steps on thinking + keeps reasoning', () => {
    const bubbles: CursorBubble[] = [
      {
        bubbleId: 'u1',
        type: 1,
        text: '<user_query>\nhello world\n</user_query>',
        createdAt: '2026-08-04T03:24:03.498Z',
      },
      // step1: thought → text → tool
      {
        bubbleId: 'th1',
        type: 2,
        text: '',
        createdAt: '2026-08-04T03:24:09.000Z',
        capabilityType: 30,
        thinkingDurationMs: 1095,
        thinking: { text: '正在查看 subtree…', signature: '' },
        modelInfo: { modelName: 'default' },
      },
      {
        bubbleId: 'a1',
        type: 2,
        text: '先看配置',
        createdAt: '2026-08-04T03:24:10.000Z',
      },
      {
        bubbleId: 't1',
        type: 2,
        text: '',
        createdAt: '2026-08-04T03:24:11.000Z',
        capabilityType: 15,
        toolFormerData: {
          name: 'run_terminal_command_v2',
          toolCallId: 'call-1',
          status: 'completed',
          params: '{"command":"echo hi"}',
          result: '{"output":"hi\\n","rejected":false}',
        },
      },
      // step2: thought → final text
      {
        bubbleId: 'th2',
        type: 2,
        text: '',
        createdAt: '2026-08-04T03:24:20.000Z',
        capabilityType: 30,
        thinkingDurationMs: 50,
        thinking: { text: '准备总结', signature: '' },
      },
      {
        bubbleId: 'a2',
        type: 2,
        text: 'done',
        createdAt: '2026-08-04T03:24:21.000Z',
      },
    ];

    const msgs = convertCursorBubblesToMessages('sid-1', bubbles, {
      fallbackCwd: '/tmp/proj',
      fallbackModel: 'default',
    });

    expect(msgs).toHaveLength(3); // user + 2 assistant steps
    expect(msgs[0].info.role).toBe('user');
    expect((msgs[0].parts[0] as any).text).toBe('hello world');

    expect(msgs[1].info.role).toBe('assistant');
    const r1 = msgs[1].parts.filter((p: any) => p.type === 'reasoning');
    const t1 = msgs[1].parts.filter((p: any) => p.type === 'text');
    const tools = msgs[1].parts.filter((p: any) => p.type === 'tool');
    expect(r1).toHaveLength(1);
    expect((r1[0] as any).text).toContain('subtree');
    expect(t1.map((p: any) => p.text)).toEqual(['先看配置']);
    expect(tools).toHaveLength(1);
    expect((tools[0] as any).tool).toBe('Bash');

    expect(msgs[2].info.role).toBe('assistant');
    const r2 = msgs[2].parts.filter((p: any) => p.type === 'reasoning');
    const t2 = msgs[2].parts.filter((p: any) => p.type === 'text');
    expect((r2[0] as any).text).toContain('总结');
    expect(t2.map((p: any) => p.text)).toEqual(['done']);
  });
});

describe('convertCursorTranscriptToMessages', () => {
  test('parses anthropic-style transcript lines', () => {
    const msgs = convertCursorTranscriptToMessages(
      'sid-tx',
      [
        {
          role: 'user',
          message: {
            content: [
              {
                type: 'text',
                text: '<timestamp>x</timestamp>\n<user_query>\nping\n</user_query>',
              },
            ],
          },
        },
        {
          role: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'pong' },
              { type: 'tool_use', name: 'Read', id: 'tu1', input: { path: '/a' } },
            ],
          },
        },
      ],
      { fallbackCwd: '/tmp' },
    );
    expect(msgs).toHaveLength(2);
    expect((msgs[0].parts[0] as any).text).toBe('ping');
    expect(msgs[1].parts.some((p: any) => p.type === 'tool' && p.tool === 'Read')).toBe(true);
  });
});

describe('cursor context estimate', () => {
  const composer: CursorComposerData = {
    promptTokenBreakdown: {
      totalUsedTokens: 40639,
      maxTokens: 256000,
      categories: [
        { id: 'tools', estimatedTokens: 10000 },
        { id: 'conversation', estimatedTokens: 16000 },
      ],
    },
    contextUsagePercent: 15.87,
  };

  test('extractCursorContextEstimate', () => {
    const est = extractCursorContextEstimate(composer);
    expect(est?.used).toBe(40639);
    expect(est?.maxTokens).toBe(256000);
    expect(est?.byCategory.tools).toBe(10000);
  });

  test('applyCursorContextEstimateToMessages hangs on last assistant', () => {
    const base = convertCursorBubblesToMessages('s1', [
      { bubbleId: 'u1', type: 1, text: 'hi', createdAt: '2026-08-04T00:00:00Z' },
      { bubbleId: 'a1', type: 2, text: 'yo', createdAt: '2026-08-04T00:00:01Z' },
    ]);
    const { messages, applied, used } = applyCursorContextEstimateToMessages(base, composer);
    expect(applied).toBe(true);
    expect(used).toBe(40639);
    const asst = messages.find((m) => m.info.role === 'assistant')!;
    expect(asst.info.tokens?.context?.total).toBe(40639);
    expect(asst.info.tokens?.input).toBe(40639);
    expect(asst.info.tokens?.output).toBe(0);
    expect((asst.info as any).cursorContextEstimate.byCategory.conversation).toBe(16000);
  });

  test('does not override real bubble tokens', () => {
    const base = convertCursorBubblesToMessages('s1', [
      { bubbleId: 'u1', type: 1, text: 'hi', createdAt: '2026-08-04T00:00:00Z' },
      {
        bubbleId: 'a1',
        type: 2,
        text: 'yo',
        createdAt: '2026-08-04T00:00:01Z',
        tokenCount: { inputTokens: 100, outputTokens: 50 },
      },
    ]);
    const { applied } = applyCursorContextEstimateToMessages(base, composer);
    expect(applied).toBe(false);
    expect(base[1].info.tokens?.input).toBe(100);
    expect(base[1].info.tokens?.output).toBe(50);
  });
});
