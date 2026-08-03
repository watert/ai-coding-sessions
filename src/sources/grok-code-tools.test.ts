/**
 * Grok tool status 解析：chat_history tool_result 默认 completed，
 * updates failed 优先；soft（FileTooLarge / CrossHostRedirect）降为 completed。
 */
import { describe, it, expect, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  listGrokCodeMessages,
  classifyGrokToolErrorText,
  classifyGrokToolFailure,
  attachGrokWallClockTimestamps,
  readGrokWallClockEvents,
  type GrokMessageItem,
} from './grok-code';
import { calculateEditDiffsFromGrokMessages } from './grok-source';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-tools-'));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSession(
  name: string,
  chat: unknown[],
  updates: unknown[],
  sessionId = name,
): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    info: { id: sessionId },
    current_model_id: 'grok-4.5',
    updated_at: new Date().toISOString(),
  }));
  fs.writeFileSync(
    path.join(dir, 'chat_history.jsonl'),
    chat.map((x) => JSON.stringify(x)).join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'updates.jsonl'),
    updates.map((x) => JSON.stringify(x)).join('\n') + (updates.length ? '\n' : ''),
  );
  return dir;
}

function toolUpdate(callId: string, status: string, contentText?: string, rawOutput?: unknown) {
  const update: Record<string, unknown> = {
    sessionUpdate: 'tool_call_update',
    toolCallId: callId,
    status,
  };
  if (contentText != null) {
    update.content = [{ type: 'content', content: { type: 'text', text: contentText } }];
  }
  if (rawOutput !== undefined) update.rawOutput = rawOutput;
  return {
    method: 'session/update',
    params: { update },
  };
}

describe('classifyGrokToolErrorText', () => {
  it('soft: file_too_large / cross_host_redirect', () => {
    expect(classifyGrokToolErrorText('contains 72044 tokens, which exceeds the maximum allowed tokens (25000 tokens)').kind)
      .toBe('file_too_large');
    expect(classifyGrokToolErrorText('Error: cross-host redirect from a.com to https://b.com/x').severity)
      .toBe('soft');
  });

  it('hard: file_not_found / invalid_args / edit', () => {
    expect(classifyGrokToolErrorText('Error: /tmp/x.md does not exist.').kind).toBe('file_not_found');
    expect(classifyGrokToolErrorText('Failed to parse arguments for tool `read_file`: missing field `target_file`').kind)
      .toBe('invalid_args');
    expect(classifyGrokToolErrorText('The string to replace was not found in the file').kind).toBe('edit_no_match');
  });
});

describe('listGrokCodeMessages tool status', () => {
  it('chat_history tool_result alone → completed', async () => {
    const dir = writeSession('only-chat', [
      { type: 'user', content: '<user_query>hi</user_query>' },
      {
        type: 'assistant',
        content: '',
        model_id: 'grok-4.5',
        tool_calls: [{ id: 'c1', name: 'list_dir', arguments: '{}' }],
      },
      { type: 'tool_result', tool_call_id: 'c1', content: 'a\nb' },
    ], []);

    const msgs = await listGrokCodeMessages({ sessionId: 'only-chat', sessionDir: dir });
    const tools = msgs.flatMap((m) => m.toolCalls || []);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe('completed');
    expect(tools[0].result).toBe('a\nb');
  });

  it('updates failed 盖掉 chat_history completed（FileNotFound hard）', async () => {
    const callId = 'call-failed-1';
    const err = 'Error: /tmp/missing.md does not exist.';
    const dir = writeSession('chat-completed-updates-failed', [
      { type: 'user', content: '<user_query>read</user_query>' },
      {
        type: 'assistant',
        content: '',
        model_id: 'grok-4.5',
        tool_calls: [{ id: callId, name: 'read_file', arguments: '{"target_file":"/tmp/missing.md"}' }],
      },
      { type: 'tool_result', tool_call_id: callId, content: err },
    ], [
      toolUpdate(callId, 'in_progress'),
      toolUpdate(callId, 'failed', err, {
        type: 'ReadFile',
        FileNotFound: err,
      }),
    ]);

    const msgs = await listGrokCodeMessages({
      sessionId: 'chat-completed-updates-failed',
      sessionDir: dir,
    });
    const tools = msgs.flatMap((m) => m.toolCalls || []);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe('failed');
    expect(tools[0].errorKind).toBe('file_not_found');
    expect(tools[0].errorSeverity).toBe('hard');
    expect(String(tools[0].result)).toContain('does not exist');
  });

  it('FileTooLarge soft → completed（不计入 hard fail）', async () => {
    const callId = 'call-too-large';
    const msg = 'The requested line range (offset=1, limit=80) contains 72044 tokens, which exceeds the maximum allowed tokens (25000 tokens).';
    const dir = writeSession('soft-too-large', [
      { type: 'user', content: '<user_query>read big</user_query>' },
      {
        type: 'assistant',
        content: '',
        model_id: 'grok-4.5',
        tool_calls: [{ id: callId, name: 'read_file', arguments: '{}' }],
      },
      { type: 'tool_result', tool_call_id: callId, content: msg },
    ], [
      toolUpdate(callId, 'failed', msg, { type: 'ReadFile', FileTooLarge: msg }),
    ]);

    const tools = (await listGrokCodeMessages({ sessionId: 'soft-too-large', sessionDir: dir }))
      .flatMap((m) => m.toolCalls || []);
    expect(tools[0].status).toBe('completed');
    expect(tools[0].errorSeverity).toBe('soft');
    expect(tools[0].errorKind).toBe('file_too_large');
  });

  it('CrossHostRedirect soft → completed', async () => {
    const callId = 'call-redirect';
    const msg = 'Error: cross-host redirect from a.com to https://b.com/x. Make a new web_fetch call with the redirect URL if needed.';
    const dir = writeSession('soft-redirect', [
      { type: 'user', content: '<user_query>fetch</user_query>' },
      {
        type: 'assistant',
        content: '',
        model_id: 'grok-4.5',
        tool_calls: [{ id: callId, name: 'web_fetch', arguments: '{}' }],
      },
      { type: 'tool_result', tool_call_id: callId, content: msg },
    ], [
      toolUpdate(callId, 'failed', msg, {
        type: 'WebFetch',
        CrossHostRedirect: { original_host: 'a.com', redirect_url: 'https://b.com/x' },
      }),
    ]);

    const tools = (await listGrokCodeMessages({ sessionId: 'soft-redirect', sessionDir: dir }))
      .flatMap((m) => m.toolCalls || []);
    expect(tools[0].status).toBe('completed');
    expect(tools[0].errorKind).toBe('cross_host_redirect');
    expect(tools[0].errorSeverity).toBe('soft');
  });

  it('MCP failed 抽出可读文本（非 [object Object]）', async () => {
    const callId = 'call-mcp';
    const dir = writeSession('mcp-fail', [
      { type: 'user', content: '<user_query>mcp</user_query>' },
      {
        type: 'assistant',
        content: '',
        model_id: 'grok-4.5',
        tool_calls: [{ id: callId, name: 'use_tool', arguments: '{}' }],
      },
    ], [
      toolUpdate(callId, 'failed', undefined, {
        type: 'MCP',
        tool_name: 'github__issue_read',
        server_name: 'GitHub',
        output: { Error: 'failed to get issue: 404 Not Found' },
      }),
    ]);

    const tools = (await listGrokCodeMessages({ sessionId: 'mcp-fail', sessionDir: dir }))
      .flatMap((m) => m.toolCalls || []);
    expect(tools[0].status).toBe('failed');
    expect(tools[0].errorKind).toBe('mcp_error');
    expect(String(tools[0].result)).toContain('404');
    expect(String(tools[0].result)).not.toContain('[object Object]');
  });

  it('completed 不被后续 in_progress 回退', async () => {
    const callId = 'call-done-1';
    const dir = writeSession('no-downgrade-in-progress', [
      { type: 'user', content: '<user_query>x</user_query>' },
      {
        type: 'assistant',
        content: '',
        model_id: 'grok-4.5',
        tool_calls: [{ id: callId, name: 'bash', arguments: '{"command":"echo hi"}' }],
      },
      { type: 'tool_result', tool_call_id: callId, content: 'exit: 0\nhi' },
    ], [
      toolUpdate(callId, 'completed', 'exit: 0\nhi'),
      toolUpdate(callId, 'in_progress'),
    ]);

    const msgs = await listGrokCodeMessages({
      sessionId: 'no-downgrade-in-progress',
      sessionDir: dir,
    });
    const tools = msgs.flatMap((m) => m.toolCalls || []);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe('completed');
  });

  it('仅 updates failed（无 chat tool_result）→ failed', async () => {
    const callId = 'ctc_backend_fail';
    const dir = writeSession('backend-failed-only', [
      { type: 'user', content: '<user_query>search</user_query>' },
      {
        type: 'backend_tool_call',
        kind: {
          tool_type: 'read_file',
          name: 'read_file',
          id: callId,
          input: '{"target_file":"/nope"}',
        },
      },
    ], [
      toolUpdate(callId, 'failed', 'File not found', {
        type: 'ReadFile',
        FileNotFound: 'File not found',
      }),
    ]);

    const msgs = await listGrokCodeMessages({
      sessionId: 'backend-failed-only',
      sessionDir: dir,
    });
    const tools = msgs.flatMap((m) => m.toolCalls || []);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe('failed');
  });
});

describe('classifyGrokToolFailure rawOutput', () => {
  it('优先 rawOutput kind', () => {
    const r = classifyGrokToolFailure({
      rawOutput: { type: 'ReadFile', FileTooLarge: 'too big' },
      content: 'other',
    });
    expect(r.kind).toBe('file_too_large');
    expect(r.severity).toBe('soft');
    expect(r.message).toContain('too big');
  });
});

function wallRow(
  sessionUpdate: string,
  agentTimestampMs: number,
  extra: Record<string, unknown> = {},
  metaExtra: Record<string, unknown> = {},
) {
  return {
    timestamp: Math.floor(agentTimestampMs / 1000),
    method: 'session/update',
    params: {
      update: { sessionUpdate, ...extra },
      _meta: { agentTimestampMs, ...metaExtra },
    },
  };
}

describe('attachGrokWallClockTimestamps (P1)', () => {
  it('uses updates wall clock instead of +1ms synthetic', async () => {
    const call1 = 'call-wall-1';
    const call2 = 'call-wall-2';
    const t0 = 1_700_000_000_000;
    const dir = writeSession('wall-clock-1', [
      { type: 'user', content: '<user_query>hi</user_query>' },
      {
        type: 'assistant',
        content: 'step1',
        model_id: 'grok-4.5',
        tool_calls: [{ id: call1, name: 'read_file', arguments: '{}' }],
      },
      { type: 'tool_result', tool_call_id: call1, content: 'a' },
      {
        type: 'assistant',
        content: 'step2',
        model_id: 'grok-4.5',
        tool_calls: [{ id: call2, name: 'bash', arguments: '{}' }],
      },
      { type: 'tool_result', tool_call_id: call2, content: 'ok' },
      { type: 'assistant', content: 'done', model_id: 'grok-4.5', tool_calls: [] },
    ], [
      wallRow('user_message_chunk', t0, { content: { type: 'text', text: 'hi' } }),
      wallRow('agent_thought_chunk', t0 + 100, { content: { type: 'text', text: 'think' } }, { turnStartMs: t0 }),
      wallRow('tool_call', t0 + 500, { toolCallId: call1, title: 'read' }, { turnStartMs: t0 }),
      wallRow('tool_call_update', t0 + 800, { toolCallId: call1, status: 'completed' }, { turnStartMs: t0 }),
      wallRow('tool_call', t0 + 2000, { toolCallId: call2, title: 'bash' }, { turnStartMs: t0 }),
      wallRow('tool_call_update', t0 + 2500, { toolCallId: call2, status: 'completed' }, { turnStartMs: t0 }),
      wallRow('agent_message_chunk', t0 + 3000, { content: { type: 'text', text: 'done' } }, { turnStartMs: t0 }),
      wallRow('turn_completed', t0 + 3100, { prompt_id: 'p1', stop_reason: 'end' }),
    ]);

    const wall = readGrokWallClockEvents(dir);
    expect(wall.userStarts[0]).toBe(t0);
    expect(wall.assistantStarts.length).toBeGreaterThanOrEqual(2);
    expect(wall.toolTimes.get(call1)?.start).toBe(t0 + 500);
    expect(wall.toolTimes.get(call1)?.end).toBe(t0 + 800);

    const msgs = await listGrokCodeMessages({ sessionId: 'wall-clock-1', sessionDir: dir });
    const assistants = msgs.filter((m) => m.role === 'assistant');
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    // 不再是 user+1 / user+2
    expect(assistants[0].timestamp).toBeGreaterThanOrEqual(t0 + 100);
    expect(assistants[0].timeSource).toBe('wall');
    if (assistants[1]) {
      expect(assistants[1].timestamp - assistants[0].timestamp).toBeGreaterThan(10);
    }
    const tc = assistants.flatMap((m) => m.toolCalls).find((t) => t.toolCallId === call1);
    expect(tc?.startMs).toBe(t0 + 500);
    expect(tc?.endMs).toBe(t0 + 800);
  });

  it('fallback linear interpolate without wall events', () => {
    const msgs: GrokMessageItem[] = [
      { uuid: 'u', sessionId: 's', role: 'user', timestamp: 1, text: '<user_query>x</user_query>', toolCalls: [] },
      { uuid: 'a', sessionId: 's', role: 'assistant', timestamp: 2, text: 'y', toolCalls: [] },
    ];
    attachGrokWallClockTimestamps(msgs, { createdMs: 1000, lastActiveMs: 3000 });
    expect(msgs[0].timestamp).toBe(1000);
    expect(msgs[1].timestamp).toBe(3000);
    expect(msgs[0].timeSource).toBe('synthetic');
  });
});

describe('calculateEditDiffsFromGrokMessages (P1)', () => {
  it('search_replace / write line stats', () => {
    const messages = [
      {
        info: { id: 'a', role: 'assistant' },
        parts: [
          {
            type: 'tool',
            tool: 'search_replace',
            state: {
              status: 'completed',
              input: {
                file_path: '/tmp/a.ts',
                old_string: 'line1\nline2\n',
                new_string: 'line1\nline2b\nline3\n',
              },
            },
          },
          {
            type: 'tool',
            tool: 'write',
            state: {
              status: 'completed',
              input: { file_path: '/tmp/b.ts', content: 'a\nb\nc\n' },
            },
          },
        ],
      },
    ] as any;
    const d = calculateEditDiffsFromGrokMessages(messages);
    expect(d.filesChanged).toBe(2);
    expect(d.files).toContain('/tmp/a.ts');
    expect(d.files).toContain('/tmp/b.ts');
    expect(d.additions).toBeGreaterThan(0);
    expect(d.deletions).toBeGreaterThanOrEqual(0);
    // write: 3 lines
    expect(d.additions).toBeGreaterThanOrEqual(3);
  });
});
