/**
 * failure-stats: 窗口解析 + grok API 异常 / Tool Fail 采集
 */
import { describe, it, expect, afterAll, beforeEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dayjs from 'dayjs';
import {
  collectSessionFailures,
  resolveFailureWindow,
  collectClaudeSessionEvents,
  collectCodexSessionEvents,
  collectZcodeSessionEvents,
  collectWorkbuddySessionEvents,
  extractToolPartInfo,
  normalizeToolName,
  type FailureEvent,
} from './failure-stats';

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

// ==================== P1: 4 source collectors ====================

describe('extractToolPartInfo', () => {
  it('claude tool_use → name + input.command', () => {
    const info = extractToolPartInfo({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'bun test foo' },
    });
    expect(info).toEqual({ name: 'Bash', command: 'bun test foo' });
  });

  it('codex/zcode tool part → tool + state.input.command', () => {
    const info = extractToolPartInfo({
      type: 'tool',
      tool: 'shell',
      state: { status: 'failed', input: { command: 'git status' }, error: 'fail' },
    });
    expect(info).toEqual({ name: 'shell', command: 'git status' });
  });

  it('workbuddy function_call → name + input.command', () => {
    const info = extractToolPartInfo({
      type: 'function_call',
      name: 'read_file',
      input: { path: '/tmp/x' },
    });
    expect(info).toEqual({ name: 'read_file', command: undefined });
  });

  it('tool_result block → null', () => {
    expect(extractToolPartInfo({ type: 'tool_result', content: 'oops' })).toBeNull();
  });

  it('非法结构 / null → null', () => {
    expect(extractToolPartInfo(null)).toBeNull();
    expect(extractToolPartInfo(undefined)).toBeNull();
    expect(extractToolPartInfo({})).toBeNull();
    expect(extractToolPartInfo({ type: 'text', text: 'hi' })).toBeNull();
  });

  it('缺 name → null', () => {
    expect(extractToolPartInfo({ type: 'tool_use', input: {} })).toBeNull();
  });
});

describe('normalizeToolName', () => {
  it('bash 类归一', () => {
    expect(normalizeToolName('Bash')).toBe('bash');
    expect(normalizeToolName('shell')).toBe('bash');
    expect(normalizeToolName('exec_command')).toBe('bash');
  });
  it('File 类归一 file edit', () => {
    expect(normalizeToolName('Read')).toBe('file edit');
    expect(normalizeToolName('Write')).toBe('file edit');
    expect(normalizeToolName('Edit')).toBe('file edit');
    expect(normalizeToolName('MultiEdit')).toBe('file edit');
  });
  it('其余保名 lowercase', () => {
    expect(normalizeToolName('Grep')).toBe('grep');
    expect(normalizeToolName('TodoWrite')).toBe('todowrite');
  });
  it('空串 → unknown', () => {
    expect(normalizeToolName('')).toBe('unknown');
    expect(normalizeToolName('   ')).toBe('unknown');
  });
});

describe('P1: 4-source collectors', () => {
  const sinceMs = dayjs('2026-08-01').valueOf();
  const endMs = dayjs('2026-08-31').endOf('day').valueOf();

  it('claude: tool_use is_error + error 文本 → tool fail', () => {
    const msgs = [{
      timestamp: dayjs('2026-08-15T10:00:00Z').valueOf(),
      message: {
        role: 'assistant',
        model: 'claude-opus-4',
        content: [
          { type: 'tool_use', name: 'Bash', id: 't1', is_error: true, input: { command: 'bun test', error: 'Test failed' } },
          { type: 'tool_use', name: 'Read', id: 't2', input: { file_path: '/tmp/x' } },
        ],
      },
    }];
    const out: FailureEvent[] = [];
    collectClaudeSessionEvents('sess-c1', 'claude title', msgs, sinceMs, endMs, out);
    // 只 is_error=true 的会被记录；第二个 tool_use 无 is_error → 跳过
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('claude');
    expect(out[0].toolName).toBe('bash');
    expect(out[0].model).toBe('claude-opus-4');
    expect(out[0].error).toContain('Test failed');
  });

  it('claude: 窗口外时间戳 → 不入 out', () => {
    const msgs = [{
      timestamp: dayjs('2025-01-01T00:00:00Z').valueOf(),
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls', is_error: true, error: 'fail' } }] },
    }];
    const out: FailureEvent[] = [];
    collectClaudeSessionEvents('s', undefined, msgs, sinceMs, endMs, out);
    expect(out).toHaveLength(0);
  });

  it('codex: tool part failed + state.error → tool fail', () => {
    const msgs = [{
      timestamp: dayjs('2026-08-10T12:00:00Z').valueOf(),
      model: 'gpt-5-codex',
      parts: [{
        type: 'tool',
        tool: 'shell',
        callID: 'c1',
        state: { status: 'failed', input: { command: 'git push' }, error: 'auth failed' },
      }],
    }];
    const out: FailureEvent[] = [];
    collectCodexSessionEvents('sess-cx1', 'codex title', msgs, sinceMs, endMs, out);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('codex');
    expect(out[0].toolName).toBe('bash');
    expect(out[0].model).toBe('gpt-5-codex');
    expect(out[0].error).toContain('auth failed');
  });

  it('codex: tool_result/非法 part → 跳过', () => {
    const msgs = [{
      timestamp: dayjs('2026-08-10T12:00:00Z').valueOf(),
      parts: [
        { type: 'tool_result', content: 'ok' },
        { type: 'text', text: 'hi' },
        { type: 'tool', tool: 'shell', state: { status: 'completed' } }, // 状态非 failed → 跳过
      ],
    }];
    const out: FailureEvent[] = [];
    collectCodexSessionEvents('s', undefined, msgs, sinceMs, endMs, out);
    expect(out).toHaveLength(0);
  });

  it('zcode: tool part failed → tool fail', () => {
    const msgs = [{
      timeCreated: dayjs('2026-08-12T05:00:00Z').valueOf(),
      timeUpdated: dayjs('2026-08-12T05:00:00Z').valueOf(),
      modelUsage: { modelId: 'minimax-m3' },
      parts: [{
        type: 'tool',
        tool: 'Bash',
        state: { status: 'failed', input: { command: 'bun test' }, error: 'failed test' },
      }],
    }];
    const out: FailureEvent[] = [];
    collectZcodeSessionEvents('sess-z1', 'zcode title', msgs, sinceMs, endMs, out);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('zcode');
    expect(out[0].toolName).toBe('bash');
    expect(out[0].model).toBe('minimax-m3');
  });

  it('zcode: 窗口外 timeCreated → 跳过', () => {
    const msgs = [{
      timeCreated: dayjs('2024-01-01').valueOf(),
      parts: [{ type: 'tool', tool: 'Bash', state: { status: 'failed', error: 'x' } }],
    }];
    const out: FailureEvent[] = [];
    collectZcodeSessionEvents('s', undefined, msgs, sinceMs, endMs, out);
    expect(out).toHaveLength(0);
  });

  it('workbuddy: function_call_result status=failed → tool fail', () => {
    const events = [
      { type: 'function_call', callId: 'c1', name: 'bash', arguments: { command: 'ls /nope' }, timestamp: dayjs('2026-08-10T03:00:00Z').valueOf() },
      { type: 'function_call_result', callId: 'c1', status: 'failed', output: { text: 'No such file or directory' }, timestamp: dayjs('2026-08-10T03:00:00Z').valueOf() },
    ];
    const out: FailureEvent[] = [];
    collectWorkbuddySessionEvents('sess-w1', 'wb title', events, sinceMs, endMs, out);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('workbuddy');
    expect(out[0].toolName).toBe('bash');
    expect(out[0].error).toContain('No such file');
  });

  it('workbuddy: 窗口外 timestamp → 跳过', () => {
    const events = [
      { type: 'function_call', callId: 'c1', name: 'bash', arguments: { command: 'ls' }, timestamp: 0 },
      { type: 'function_call_result', callId: 'c1', status: 'failed', output: 'oops', timestamp: dayjs('2024-01-01').valueOf() },
    ];
    const out: FailureEvent[] = [];
    collectWorkbuddySessionEvents('s', undefined, events, sinceMs, endMs, out);
    expect(out).toHaveLength(0);
  });

  it('workbuddy: 软失败（aborted_user）→ soft=true 不进硬失败', () => {
    const events = [
      { type: 'function_call', callId: 'c1', name: 'bash', arguments: { command: 'sleep 99' }, timestamp: dayjs('2026-08-10T03:00:00Z').valueOf() },
      { type: 'function_call_result', callId: 'c1', status: 'failed', errorSeverity: 'soft', output: 'Tool execution aborted', timestamp: dayjs('2026-08-10T03:00:00Z').valueOf() },
    ];
    const out: FailureEvent[] = [];
    collectWorkbuddySessionEvents('s', undefined, events, sinceMs, endMs, out);
    expect(out).toHaveLength(1);
    expect(out[0].soft).toBe(true);
    expect(out[0].errorKind).toBe('aborted_user');
  });
});