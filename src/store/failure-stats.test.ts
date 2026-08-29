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
  aggregateSourceModelTool,
  wrapBashBreakdown,
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

// ==================== P1: model field populated (MUST-FIX #3 from k3 review) ====================

describe('P1: model field populated', () => {
  it('claude collector 写入 msg.message.model → FailureEvent.model', () => {
    const ts = Date.now();
    const msg = {
      message: {
        model: 'claude-sonnet-4',
        content: [{ type: 'tool_use', name: 'Bash', id: 't1', is_error: true, input: { command: 'ls', error: 'oops' } }],
      },
      timestamp: ts,
    };
    const out: FailureEvent[] = [];
    collectClaudeSessionEvents('s1', 't', [msg], 0, ts + 1, out);
    expect(out).toHaveLength(1);
    expect(out[0].model).toBe('claude-sonnet-4');
  });

  it('codex collector 写入 msg.model → FailureEvent.model', () => {
    const ts = Date.now();
    const msg = {
      model: 'o3',
      timestamp: ts,
      parts: [{ type: 'tool', tool: 'Bash', callID: 'c1', state: { status: 'failed', input: { command: 'ls' }, error: 'boom' } }],
    };
    const out: FailureEvent[] = [];
    collectCodexSessionEvents('s1', 't', [msg], 0, ts + 1, out);
    expect(out).toHaveLength(1);
    expect(out[0].model).toBe('o3');
  });

  it('zcode collector 写入 msg.modelUsage.modelId → FailureEvent.model', () => {
    const ts = Date.now();
    const msg = {
      timeCreated: ts,
      timeUpdated: ts,
      modelUsage: { modelId: 'zcode-flash' },
      parts: [{ type: 'tool', tool: 'Bash', state: { status: 'failed', input: { command: 'ls' }, error: 'boom' } }],
    };
    const out: FailureEvent[] = [];
    collectZcodeSessionEvents('s1', 't', [msg], 0, ts + 1, out);
    expect(out).toHaveLength(1);
    expect(out[0].model).toBe('zcode-flash');
  });

  it('workbuddy collector 写入 ev.providerData.model → FailureEvent.model', () => {
    const ts = Date.now();
    const events = [
      { type: 'function_call', callId: 'c1', name: 'bash', arguments: { command: 'ls' }, timestamp: ts, providerData: { model: 'workbuddy-flash' } },
      { type: 'function_call_result', callId: 'c1', status: 'failed', output: { text: 'boom' }, timestamp: ts },
    ];
    const out: FailureEvent[] = [];
    collectWorkbuddySessionEvents('s1', 't', events, 0, ts + 1, out);
    expect(out).toHaveLength(1);
    expect(out[0].model).toBe('workbuddy-flash');
  });
});

// ==================== P1: bySourceModelTool aggregation ====================

describe('P1: aggregateSourceModelTool', () => {
  it('2 条同 (source, model, tool) 事件 → 1 行 count=2，pct 与 topError 都对', () => {
    const events: FailureEvent[] = [
      { source: 'opencode', sessionId: 's1', ts: 1, kind: 'tool', model: 'gpt-x', toolName: 'bash', error: 'boom-a' },
      { source: 'opencode', sessionId: 's1', ts: 2, kind: 'tool', model: 'gpt-x', toolName: 'bash', error: 'boom-a' },
    ] as FailureEvent[];
    const rows = aggregateSourceModelTool(events);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('opencode');
    expect(rows[0].model).toBe('gpt-x');
    expect(rows[0].tool).toBe('bash');
    expect(rows[0].count).toBe(2);
    expect(rows[0].pct).toBe(100);
    expect(rows[0].topError).toBe('boom-a');
    expect(rows[0].topErrorCount).toBe(2);
  });

  it('api 事件不进交叉表；不同 (model, tool) 各占一行', () => {
    const events: FailureEvent[] = [
      { source: 'kimi', sessionId: 's1', ts: 1, kind: 'api', model: 'kimi-x', error: 'api-fail' },
      { source: 'opencode', sessionId: 's2', ts: 2, kind: 'tool', model: 'gpt-x', toolName: 'bash', error: 'a' },
      { source: 'opencode', sessionId: 's3', ts: 3, kind: 'tool', model: 'gpt-x', toolName: 'read', error: 'b' },
    ] as FailureEvent[];
    const rows = aggregateSourceModelTool(events);
    expect(rows).toHaveLength(2);
    const bashRow = rows.find((r) => r.tool === 'bash')!;
    expect(bashRow.count).toBe(1);
    // MUST-FIX #2：pct 分母改为 tool events 数（2 个 tool），bash / read 各占 50%
    expect(bashRow.pct).toBeCloseTo(50, 1);
    const readRow = rows.find((r) => r.tool === 'read')!;
    expect(readRow.count).toBe(1);
    expect(readRow.pct).toBeCloseTo(50, 1);
    // api 不计 count，也不进分母（MUST-FIX #2）
  });

  it('top 截断', () => {
    const events: FailureEvent[] = ['bash', 'read', 'edit'].map((t, i) => ({
      source: 'opencode', sessionId: `s${i}`, ts: i, kind: 'tool', model: 'gpt-x', toolName: t, error: 'x',
    } as FailureEvent));
    const rows = aggregateSourceModelTool(events, 2);
    expect(rows).toHaveLength(2);
  });

  // NICE-FIX #3：并列 topError 策略（首个最大，Map 插入序）
  it('同 (source, model, tool) 多 error：A=2 B=1 → topError=A, topErrorCount=2', () => {
    const events: FailureEvent[] = [
      { source: 'opencode', sessionId: 's1', ts: 1, kind: 'tool', model: 'gpt-x', toolName: 'bash', error: 'A' },
      { source: 'opencode', sessionId: 's1', ts: 2, kind: 'tool', model: 'gpt-x', toolName: 'bash', error: 'B' },
      { source: 'opencode', sessionId: 's1', ts: 3, kind: 'tool', model: 'gpt-x', toolName: 'bash', error: 'A' },
    ] as FailureEvent[];
    const rows = aggregateSourceModelTool(events);
    expect(rows).toHaveLength(1);
    expect(rows[0].topError).toBe('A');
    expect(rows[0].topErrorCount).toBe(2);
  });

  it('同 (source, model, tool) 多 error：A=1 B=1 → topError 取 Map 首位 A（不取 B）', () => {
    const events: FailureEvent[] = [
      { source: 'opencode', sessionId: 's1', ts: 1, kind: 'tool', model: 'gpt-x', toolName: 'bash', error: 'A' },
      { source: 'opencode', sessionId: 's1', ts: 2, kind: 'tool', model: 'gpt-x', toolName: 'bash', error: 'B' },
    ] as FailureEvent[];
    const rows = aggregateSourceModelTool(events);
    expect(rows).toHaveLength(1);
    expect(rows[0].topError).toBe('A');
    expect(rows[0].topErrorCount).toBe(1);
  });
});

// ==================== MUST-FIX #4: wrapBashBreakdown ====================

describe('P1: wrapBashBreakdown', () => {
  it('空 events → 返回 total=0 全空结构（NICE-FIX #1 bash 必填）', () => {
    const r = wrapBashBreakdown([]);
    expect(r).toEqual({
      total: 0,
      byExitCode: [],
      byCmdFamily: [],
      byCategory: [],
      byCommand: [],
      byModel: [],
      samples: [],
    });
  });

  it('多 exit code + 多 model：3 事件同 kind=tool/toolName=bash，exit 1/2/2 model a/b/a', () => {
    const t1 = dayjs('2026-08-15T10:00:00Z').valueOf();
    const t2 = t1 + 60_000;
    const t3 = t2 + 60_000;
    const events: FailureEvent[] = [
      { source: 'opencode', sessionId: 's1', ts: t1, kind: 'tool', model: 'a', toolName: 'bash', errorRaw: 'exit code 1', error: 'exit code 1' },
      { source: 'opencode', sessionId: 's1', ts: t2, kind: 'tool', model: 'b', toolName: 'bash', errorRaw: 'exit code 2', error: 'exit code 2' },
      { source: 'opencode', sessionId: 's1', ts: t3, kind: 'tool', model: 'a', toolName: 'bash', errorRaw: 'exit code 2', error: 'exit code 2' },
    ] as FailureEvent[];
    const r = wrapBashBreakdown(events);
    expect(r.total).toBe(3);
    // byExitCode 含 1:1, 2:2
    expect(r.byExitCode.find((x) => x.key === '1')?.count).toBe(1);
    expect(r.byExitCode.find((x) => x.key === '2')?.count).toBe(2);
    // byModel 含 a:2, b:1
    expect(r.byModel.find((x) => x.key === 'a')?.count).toBe(2);
    expect(r.byModel.find((x) => x.key === 'b')?.count).toBe(1);
    // samples.length = 3，按 ts 倒序（无 raw command → category/cmdFamily/command 全 null，MUST-FIX #3）
    expect(r.samples.length).toBe(3);
    expect(r.samples[0].time).toBe(dayjs(t3).format('MM-DD HH:mm'));
    expect(r.samples[1].time).toBe(dayjs(t2).format('MM-DD HH:mm'));
    expect(r.samples[2].time).toBe(dayjs(t1).format('MM-DD HH:mm'));
    expect(r.samples[0].category).toBeNull();
    expect(r.samples[0].cmdFamily).toBeNull();
    expect(r.samples[0].command).toBeNull();
  });
});