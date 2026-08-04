import { describe, expect, test } from 'bun:test';
import {
  normalizeCursorToolName,
  parseCursorToolParams,
  cursorToolResultText,
  type CursorBubble,
} from './cursor-code';
import { convertCursorBubblesToMessages, convertCursorTranscriptToMessages } from './cursor-source';

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
  test('groups user + assistant text + tool', () => {
    const bubbles: CursorBubble[] = [
      {
        bubbleId: 'u1',
        type: 1,
        text: '<user_query>\nhello world\n</user_query>',
        createdAt: '2026-08-04T03:24:03.498Z',
      },
      {
        bubbleId: 'a1',
        type: 2,
        text: 'looking…',
        createdAt: '2026-08-04T03:24:10.000Z',
        modelInfo: { modelName: 'default' },
      },
      {
        bubbleId: 't1',
        type: 2,
        text: '',
        createdAt: '2026-08-04T03:24:11.000Z',
        toolFormerData: {
          name: 'run_terminal_command_v2',
          toolCallId: 'call-1',
          status: 'completed',
          params: '{"command":"echo hi"}',
          result: '{"output":"hi\\n","rejected":false}',
        },
      },
      {
        bubbleId: 'a2',
        type: 2,
        text: 'done',
        createdAt: '2026-08-04T03:24:12.000Z',
      },
    ];

    const msgs = convertCursorBubblesToMessages('sid-1', bubbles, {
      fallbackCwd: '/tmp/proj',
      fallbackModel: 'default',
    });

    expect(msgs).toHaveLength(2);
    expect(msgs[0].info.role).toBe('user');
    expect((msgs[0].parts[0] as any).text).toBe('hello world');
    expect(msgs[1].info.role).toBe('assistant');
    expect(msgs[1].info.modelID).toBe('default');
    const tools = msgs[1].parts.filter((p: any) => p.type === 'tool');
    const texts = msgs[1].parts.filter((p: any) => p.type === 'text');
    expect(tools).toHaveLength(1);
    expect((tools[0] as any).tool).toBe('Bash');
    expect((tools[0] as any).state.input.command).toBe('echo hi');
    expect((tools[0] as any).state.output).toContain('hi');
    expect(texts.map((p: any) => p.text)).toEqual(['looking…', 'done']);
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
