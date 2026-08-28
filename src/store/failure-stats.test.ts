/**
 * failure-stats: 窗口解析 + grok API 异常 / Tool Fail 采集
 */
import { describe, it, expect, afterAll, beforeEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dayjs from 'dayjs';
import { collectSessionFailures, resolveFailureWindow } from './failure-stats';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-stats-'));
// resolveGrokSessionsRoot: basename 非 sessions 时会拼 /sessions，须显式建同名目录
const sessionsRoot = path.join(tmpRoot, 'sessions');
fs.mkdirSync(sessionsRoot, { recursive: true });
const prevEnv = process.env.GROK_SESSIONS_DIR;

beforeEach(() => {
  process.env.GROK_SESSIONS_DIR = sessionsRoot;
  fs.rmSync(sessionsRoot, { recursive: true, force: true });
  fs.mkdirSync(sessionsRoot, { recursive: true });
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.GROK_SESSIONS_DIR;
  else process.env.GROK_SESSIONS_DIR = prevEnv;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function toolUpdate(callId: string, status: string, contentText?: string, rawOutput?: unknown) {
  const update: Record<string, unknown> = { sessionUpdate: 'tool_call_update', toolCallId: callId, status };
  if (contentText != null) update.content = [{ type: 'content', content: { type: 'text', text: contentText } }];
  if (rawOutput !== undefined) update.rawOutput = rawOutput;
  return { method: 'session/update', params: { update } };
}

function writeSession(name: string, sessionId: string, chat: unknown[], updates: unknown[]) {
  const dir = path.join(sessionsRoot, name, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    info: { id: sessionId },
    generated_title: name,
    current_model_id: 'grok-4.5',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    last_active_at: now.toISOString(),
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

describe('resolveFailureWindow', () => {
  it('startDate 优先；无则按 days 回看', () => {
    const w = resolveFailureWindow({ startDate: '2026-08-24', endDate: '2026-08-26' });
    expect(w.days).toBe(3);
    // 原断言 `w.startDate` 恒为 undefined（返回类型无此字段，属无效断言），
    // 改为校验 startDate 真正驱动的 sinceMs：startOf('day') 于 2026-08-24
    expect(w.sinceMs).toBe(dayjs('2026-08-24').startOf('day').valueOf());
    const w2 = resolveFailureWindow({ days: 5 });
    expect(w2.days).toBe(5);
    const w3 = resolveFailureWindow({});
    expect(w3.days).toBe(14);
  });
});

describe('collectSessionFailures grok', () => {
  it('采集 turn_completed API 异常 + failed tool call', async () => {
    const callId = 'call-fail-1';
    const err = 'Error: /tmp/missing.md does not exist.';
    const agentErr = 'API error (status 400 Bad Request): invalid_request_error: Error from provider (Console Go): Upstream request failed: [400] Model only supports text input; received unsupported content type \'image_url\'.';
    writeSession('fail-session', 'sess-1', [
      { type: 'user', content: '<user_query>do it</user_query>' },
      {
        type: 'assistant',
        content: '',
        model_id: 'grok-4.5',
        tool_calls: [{ id: callId, name: 'read_file', arguments: '{"target_file":"/tmp/missing.md"}' }],
      },
      { type: 'tool_result', tool_call_id: callId, content: err },
    ], [
      toolUpdate(callId, 'in_progress'),
      toolUpdate(callId, 'failed', err, { type: 'ReadFile', FileNotFound: err }),
      {
        timestamp: Date.now() / 1000,
        method: '_x.ai/session/update',
        params: {
          update: { sessionUpdate: 'turn_completed', stop_reason: 'error', agent_result: agentErr },
        },
      },
    ]);

    const result = await collectSessionFailures({ source: 'grok', days: 1 });
    expect(result.apiCount).toBe(1);
    expect(result.toolCount).toBe(1);
    expect(result.total).toBe(2);
    expect(result.sessions).toBe(1);

    const api = result.apiFailures[0];
    expect(api.stopReason).toBe('error');
    expect(api.statusCode).toBe(400);
    expect(api.error).toContain('Model only supports text input');

    const tool = result.samples.find((s) => s.kind === 'tool');
    expect(tool?.toolName).toBe('read_file');
    expect(tool?.error).toContain('does not exist');
    expect(tool?.soft).toBeFalsy();
  });

  it('end_turn 不算 API 异常', async () => {
    writeSession('ok-session', 'sess-2', [
      { type: 'user', content: '<user_query>hi</user_query>' },
      { type: 'assistant', content: 'ok', model_id: 'grok-4.5' },
    ], [
      {
        timestamp: Date.now() / 1000,
        method: '_x.ai/session/update',
        params: { update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' } },
      },
    ]);
    const result = await collectSessionFailures({ source: 'grok', days: 1 });
    expect(result.apiCount).toBe(0);
    expect(result.total).toBe(0);
  });
});