/**
 * grok tool calling 过期：web_search 等 timeout 后进程死掉，不应再标 in-progress
 */
import { describe, it, expect, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listGrokCodeMessages, GROK_CALLING_STALE_MS } from './grok-code';
import { convertGrokSession } from './grok-source';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-tool-timeout-'));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSession(name: string, opts: {
  lastActiveMs: number;
  toolStatus?: string;
  toolName?: string;
  title?: string;
}): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const iso = new Date(opts.lastActiveMs).toISOString();
  const callId = `call-${name}`;
  const toolName = opts.toolName || 'web_search';
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    info: { id: name },
    current_model_id: 'grok-4.6',
    created_at: iso,
    updated_at: iso,
    last_active_at: iso,
  }));
  fs.writeFileSync(
    path.join(dir, 'chat_history.jsonl'),
    [
      { type: 'user', content: '<user_query>search acp</user_query>' },
      {
        type: 'assistant',
        content: '',
        model_id: 'grok-4.6',
        tool_calls: [{ id: callId, name: toolName, arguments: '{"query":"Cline ACP"}' }],
      },
    ].map((x) => JSON.stringify(x)).join('\n') + '\n',
  );
  const update: Record<string, unknown> = {
    sessionUpdate: 'tool_call_update',
    toolCallId: callId,
    title: opts.title || `Web search: Cline ACP`,
    kind: 'search',
  };
  if (opts.toolStatus) update.status = opts.toolStatus;
  fs.writeFileSync(
    path.join(dir, 'updates.jsonl'),
    JSON.stringify({
      timestamp: Math.floor(opts.lastActiveMs / 1000),
      method: 'session/update',
      params: {
        update,
        _meta: { agentTimestampMs: opts.lastActiveMs },
      },
    }) + '\n',
  );
  return dir;
}

async function statusOf(name: string, dir: string) {
  return (await convertGrokSession({
    sessionId: name,
    sessionDir: dir,
    workDir: '/tmp',
    title: name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })).session_status;
}

describe('grok stale calling tool timeout', () => {
  it('calling 已过期 → tool failed timeout，session error', async () => {
    const dir = writeSession('search-stale', { lastActiveMs: Date.now() - 2 * 60 * 60_000 });
    const msgs = await listGrokCodeMessages({ sessionId: 'search-stale', sessionDir: dir });
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.toolCalls[0].status).toBe('failed');
    expect(last.toolCalls[0].errorKind).toBe('timeout');
    expect(last.error?.name).toBe('ToolTimeoutError');
    expect(await statusOf('search-stale', dir)).toBe('error');
  });

  it('calling 仍在窗口内 → 保持 in-progress', async () => {
    const dir = writeSession('search-live', { lastActiveMs: Date.now() - 10_000 });
    const last = (await listGrokCodeMessages({ sessionId: 'search-live', sessionDir: dir })).at(-1);
    expect(last?.toolCalls[0].status).not.toBe('failed');
    expect(last?.error).toBeUndefined();
    expect(await statusOf('search-live', dir)).toBe('in-progress');
  });

  it('running 后台任务不因 5min 窗口被杀掉', async () => {
    const stale = Date.now() - GROK_CALLING_STALE_MS - 30_000;
    const dir = writeSession('bg-running-stale', {
      lastActiveMs: stale,
      toolStatus: 'running',
      toolName: 'run_terminal_command',
      title: '[bg] sleep 999',
    });
    const last = (await listGrokCodeMessages({ sessionId: 'bg-running-stale', sessionDir: dir })).at(-1);
    expect(last?.toolCalls[0].status).toBe('running');
    expect(last?.error).toBeUndefined();
  });
});
