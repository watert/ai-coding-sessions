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
} from './grok-code';

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
