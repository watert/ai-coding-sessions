/**
 * grok retry_state 卡住：请求失败 / 重试中途死掉不应再标 in-progress
 */
import { describe, it, expect, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  listGrokCodeMessages,
  isGrokRetryStateTerminal,
  readGrokLastRetryState,
  type GrokRetryState,
} from './grok-code';
import { convertGrokSession } from './grok-source';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-retry-'));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function retryUpdate(opts: {
  type: string;
  attempt?: number;
  maxRetries?: number;
  reason?: string;
  tsMs: number;
}) {
  return {
    timestamp: Math.floor(opts.tsMs / 1000),
    method: '_x.ai/session/update',
    params: {
      update: {
        sessionUpdate: 'retry_state',
        type: opts.type,
        attempt: opts.attempt,
        max_retries: opts.maxRetries,
        reason: opts.reason || 'request error: error sending request for url (https://cli-chat-proxy.grok.com/v1/responses)',
      },
      _meta: { agentTimestampMs: opts.tsMs },
    },
  };
}

function writeSession(name: string, updates: unknown[]): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const nowIso = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    info: { id: name },
    current_model_id: 'grok-4.6',
    created_at: nowIso,
    updated_at: nowIso,
    last_active_at: nowIso,
  }));
  fs.writeFileSync(
    path.join(dir, 'chat_history.jsonl'),
    JSON.stringify({ type: 'user', content: '<user_query>fix vault-ops</user_query>' }) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'updates.jsonl'),
    updates.map((x) => JSON.stringify(x)).join('\n') + (updates.length ? '\n' : ''),
  );
  return dir;
}

async function sessionStatus(name: string, dir: string) {
  return (await convertGrokSession({
    sessionId: name,
    sessionDir: dir,
    workDir: '/tmp',
    title: name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })).session_status;
}

describe('grok retry_state 终态', () => {
  it('isGrokRetryStateTerminal: failed 立即终态', () => {
    const st: GrokRetryState = { type: 'failed', reason: 'api', tsMs: Date.now() };
    expect(isGrokRetryStateTerminal(st)).toBe(true);
  });

  it('isGrokRetryStateTerminal: 刚 retrying 不算终态', () => {
    const st: GrokRetryState = {
      type: 'retrying',
      reason: 'request error',
      tsMs: Date.now() - 10_000,
      lastDeltaMs: 30_000,
    };
    expect(isGrokRetryStateTerminal(st)).toBe(false);
  });

  it('isGrokRetryStateTerminal: retrying 错过 backoff → 终态', () => {
    const st: GrokRetryState = {
      type: 'retrying',
      reason: 'request error',
      tsMs: Date.now() - 3 * 60_000,
      lastDeltaMs: 37_000,
    };
    expect(isGrokRetryStateTerminal(st)).toBe(true);
  });

  it('末尾 retrying 已过期 → error assistant，session error', async () => {
    const stale = Date.now() - 2 * 60 * 60_000;
    const dir = writeSession('retry-stale', [
      retryUpdate({ type: 'retrying', attempt: 6, maxRetries: 15, tsMs: stale - 37_000 }),
      retryUpdate({ type: 'retrying', attempt: 6, maxRetries: 15, tsMs: stale }),
    ]);
    const st = readGrokLastRetryState(dir);
    expect(st?.type).toBe('retrying');
    expect(isGrokRetryStateTerminal(st!)).toBe(true);

    const msgs = await listGrokCodeMessages({ sessionId: 'retry-stale', sessionDir: dir });
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.error?.name).toBe('RequestError');
    expect(last.error?.message).toContain('cli-chat-proxy');
    expect(await sessionStatus('retry-stale', dir)).toBe('error');
  });

  it('末尾 retrying 仍在 backoff 窗口 → 保持 in-progress，不合成 error', async () => {
    const dir = writeSession('retry-live', [
      retryUpdate({ type: 'retrying', attempt: 2, maxRetries: 15, tsMs: Date.now() - 8_000 }),
    ]);
    const msgs = await listGrokCodeMessages({ sessionId: 'retry-live', sessionDir: dir });
    expect(msgs[msgs.length - 1].role).toBe('user');
    expect(msgs.some((m) => m.error)).toBe(false);
    expect(await sessionStatus('retry-live', dir)).toBe('in-progress');
  });

  it('末尾 retry_state failed → 立即 error', async () => {
    const dir = writeSession('retry-failed', [
      retryUpdate({
        type: 'failed',
        tsMs: Date.now() - 1_000,
        reason: 'API error (status 400 Bad Request): invalid reasoning effort.',
      }),
    ]);
    const last = (await listGrokCodeMessages({ sessionId: 'retry-failed', sessionDir: dir })).at(-1);
    expect(last?.error?.name).toBe('RequestError');
    expect(await sessionStatus('retry-failed', dir)).toBe('error');
  });

  it('retry_state failed 之后已 turn_completed → 不合成 error', async () => {
    const dir = writeSession('retry-recovered', [
      retryUpdate({ type: 'failed', tsMs: Date.now() - 60_000, reason: 'API error' }),
      {
        timestamp: Math.floor(Date.now() / 1000),
        method: 'session/update',
        params: { update: { sessionUpdate: 'turn_completed' } },
      },
    ]);
    expect(readGrokLastRetryState(dir)).toBeNull();
    const msgs = await listGrokCodeMessages({ sessionId: 'retry-recovered', sessionDir: dir });
    expect(msgs.some((m) => m.error)).toBe(false);
  });
});
