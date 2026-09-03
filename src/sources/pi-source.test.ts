/**
 * Pi adapter 单元测试：convert 统计 / toolResult 配对 / status 映射 / usage_by_model 聚合
 * / reported-cost rescale / listRefs dirty mark
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listPiCodeSessions,
  listPiSessionRefs,
  getPiSession,
  readPiSessionEvents,
  resolvePiSessionsRoot,
  type PiEvent,
} from './pi-code';
import {
  convertPiSession,
  convertPiEventsToMessages,
  getPiSessionDetail,
  derivePiTitle,
} from './pi-source';
import { writeJsonl, mkFixtureDir } from './__fixtures__/tmp';

const T0 = Date.UTC(2026, 6, 15, 12, 0, 0);

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    prev[k] = process.env[k];
    const v = patch[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const k of Object.keys(patch)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
  try {
    const result = fn();
    if (result && typeof (result as any).then === 'function') {
      return (result as any).then(
        (v: T) => { restore(); return v; },
        (e: unknown) => { restore(); throw e; },
      );
    }
    restore();
    return result;
  } catch (e) {
    restore();
    throw e;
  }
}

/** 构造一个含完整 user/assistant+tool/toolResult/usage 的 pi jsonl */
function writePiSample(dir: string, opts: {
  sessionId?: string;
  cwd?: string;
  cwdSlug?: string;
  rows?: any[];
} = {}) {
  const root = path.join(dir, 'sessions');
  const cwdSlug = opts.cwdSlug || '--tmp-pi--';
  const sessDir = path.join(root, cwdSlug);
  fs.mkdirSync(sessDir, { recursive: true });
  const sessionId = opts.sessionId || 'pi-test-001';
  const cwd = opts.cwd || '/tmp/p';
  const jsonlPath = path.join(sessDir, `2026-09-03T02-02-57-168Z_${sessionId}.jsonl`);
  const baseRows: any[] = [
    { type: 'session', version: 3, id: sessionId, timestamp: new Date(T0).toISOString(), cwd },
    {
      type: 'model_change',
      id: 'mc1',
      parentId: null,
      timestamp: new Date(T0 + 50).toISOString(),
      provider: 'opencode-go',
      modelId: 'kimi-k2.6',
    },
    {
      type: 'message',
      id: 'u1',
      parentId: 'mc1',
      timestamp: new Date(T0 + 100).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: '请读下 README.md' }] },
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: new Date(T0 + 1000).toISOString(),
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '需要先看文件' },
          {
            type: 'toolCall',
            id: 'call_a1_1',
            name: 'read',
            arguments: { path: '/tmp/p/README.md' },
          },
          { type: 'text', text: '已读到 README' },
        ],
        provider: 'opencode-go',
        model: 'kimi-k2.6',
        usage: {
          input: 50, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 70,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.00021 },
        },
        stopReason: 'toolUse',
      },
    },
    {
      type: 'message',
      id: 'tr_a1_1',
      parentId: 'a1',
      timestamp: new Date(T0 + 1100).toISOString(),
      message: {
        role: 'toolResult',
        toolCallId: 'call_a1_1',
        toolName: 'read',
        content: [{ type: 'text', text: '# Sample\nhello' }],
        isError: false,
      },
    },
    {
      type: 'message',
      id: 'a2',
      parentId: 'tr_a1_1',
      timestamp: new Date(T0 + 2000).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        provider: 'opencode-go',
        model: 'kimi-k2.6',
        usage: {
          input: 80, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 85,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.00009 },
        },
        stopReason: 'stop',
      },
    },
  ];
  writeJsonl(jsonlPath, opts.rows || baseRows);
  return { root, cwdSlug, sessDir, jsonlPath, cwd, sessionId };
}

describe('resolvePiSessionsRoot', () => {
  test('env override / normalize', () => {
    const tmp = mkFixtureDir('acs-pi-root-');
    const sessions = path.join(tmp, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    expect(resolvePiSessionsRoot({ PI_SESSIONS_DIR: sessions } as any)).toBe(sessions);

    const piHome = path.join(tmp, 'pi-home');
    fs.mkdirSync(path.join(piHome, 'agent', 'sessions'), { recursive: true });
    expect(resolvePiSessionsRoot({ PI_HOME: piHome } as any)).toBe(
      path.join(piHome, 'agent', 'sessions'),
    );
  });
});

describe('listPiCodeSessions / listPiSessionRefs', () => {
  test('reads header + dirty mark', () => {
    const tmp = mkFixtureDir('acs-pi-list-');
    const fx = writePiSample(tmp);
    withEnv({ PI_SESSIONS_DIR: fx.root }, async () => {
      const list = await listPiCodeSessions();
      expect(list).toHaveLength(1);
      const item = list[0];
      expect(item.sessionId).toBe(fx.sessionId);
      expect(item.cwd).toBe(fx.cwd);
      expect(item.cwdSlug).toBe(fx.cwdSlug);
      expect(item.dirtyMark).toMatch(/^\d+:\d+$/);
      expect(item.updatedAt).toBeGreaterThan(0);

      const refs = await listPiSessionRefs();
      expect(refs).toHaveLength(1);
      expect(refs[0].firstUserText).toContain('README');
    });
  });

  test('skips malformed / non-session files', () => {
    const tmp = mkFixtureDir('acs-pi-bad-');
    fs.mkdirSync(path.join(tmp, 'sessions', '--bad--'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'sessions', '--bad--', 'garbage.jsonl'), 'not json\n', 'utf-8');
    withEnv({ PI_SESSIONS_DIR: path.join(tmp, 'sessions') }, async () => {
      const list = await listPiCodeSessions();
      expect(list).toHaveLength(0);
    });
  });

  test('cwd-slug with spaces (iCloud Mobile Documents)', () => {
    // 模拟本机真实路径: --Users-waterwu-Library-Mobile Documents-...--
    const tmp = mkFixtureDir('acs-pi-spaces-');
    const fx = writePiSample(tmp, {
      cwdSlug: '--Users-foo-Library-Mobile Documents-iCloud--',
      cwd: '/Users/foo/Library/Mobile Documents/iCloud',
    });
    withEnv({ PI_SESSIONS_DIR: fx.root }, async () => {
      const list = await listPiCodeSessions();
      expect(list).toHaveLength(1);
      expect(list[0].cwdSlug).toContain('Mobile Documents');
      expect(list[0].cwd).toContain('Mobile Documents');
    });
  });
});

describe('convertPiEventsToMessages', () => {
  test('pairs toolCall → toolResult into state.output', () => {
    const tmp = mkFixtureDir('acs-pi-conv-');
    const fx = writePiSample(tmp);
    const events = readPiSessionEvents(fx.jsonlPath);
    const { messages, lastStopReason } = convertPiEventsToMessages(fx.sessionId, events, {
      fallbackCwd: fx.cwd,
    });
    expect(lastStopReason).toBe('stop');
    // 1 user + 2 assistant (a1/a2) — toolResult 不产出独立 message
    expect(messages).toHaveLength(3);
    expect(messages[0].info.role).toBe('user');
    expect(messages[1].info.role).toBe('assistant');
    expect(messages[2].info.role).toBe('assistant');

    const a1 = messages[1];
    const tools = a1.parts.filter((p: any) => p.type === 'tool');
    expect(tools).toHaveLength(1);
    const tool = tools[0] as any;
    expect(tool.tool).toBe('read');
    expect(tool.state.status).toBe('completed');
    expect(tool.state.output).toContain('Sample');
    expect(tool.state.input).toEqual({ path: '/tmp/p/README.md' });
  });

  test('unknown event types are skipped', () => {
    const tmp = mkFixtureDir('acs-pi-unknown-');
    const fx = writePiSample(tmp, {
      sessionId: 'pi-test-unknown',
      rows: [
        { type: 'session', version: 3, id: 'pi-test-unknown', timestamp: new Date(T0).toISOString(), cwd: '/tmp/p' },
        { type: 'future_event_v4', whatever: true },
        { type: 'model_change', id: 'mc', parentId: null, timestamp: new Date(T0).toISOString(), provider: 'p', modelId: 'm' },
        {
          type: 'message',
          id: 'u1',
          parentId: 'mc',
          timestamp: new Date(T0 + 100).toISOString(),
          message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        },
      ],
    });
    const events = readPiSessionEvents(fx.jsonlPath);
    const { messages } = convertPiEventsToMessages(fx.sessionId, events);
    expect(messages).toHaveLength(1);
    expect(messages[0].info.role).toBe('user');
  });

  test('isError=true flips tool state.status', () => {
    const tmp = mkFixtureDir('acs-pi-err-');
    const base = writePiSample(tmp);
    // 改 tr_a1_1 → isError=true
    fs.writeFileSync(
      base.jsonlPath,
      fs.readFileSync(base.jsonlPath, 'utf-8').replace('"isError":false', '"isError":true'),
      'utf-8',
    );
    const events = readPiSessionEvents(base.jsonlPath);
    const { messages } = convertPiEventsToMessages(base.sessionId, events);
    const a1 = messages[1];
    const tool = a1.parts.find((p: any) => p.type === 'tool') as any;
    expect(tool.state.status).toBe('error');
  });
});

describe('convertPiSession / getPiSessionDetail', () => {
  test('stats + usage_by_model + status mapping', () => {
    const tmp = mkFixtureDir('acs-pi-stats-');
    const fx = writePiSample(tmp);
    withEnv({ PI_SESSIONS_DIR: fx.root }, async () => {
      const list = await listPiCodeSessions();
      const sess = list[0];
      const info = await convertPiSession(sess);

      expect(info.id).toBe(fx.sessionId);
      expect(info.source).toBe('pi');
      expect(info.title).toContain('README');
      expect(info.total_messages).toBe(3);
      expect(info.total_user_messages).toBe(1);
      expect(info.total_tool_calls).toBe(1);
      expect(info.total_tool_calls_success).toBe(1);
      expect(info.total_tool_calls_failed).toBe(0);
      expect(info.total_input).toBe(130);
      expect(info.total_output).toBe(25);
      expect(info.total_tokens).toBe(155);

      expect(info.session_status).toBe('done');
      expect(info.usage_source).toBe('real');
      expect(info.models_used).toBe('kimi-k2.6');

      // usage_by_model 应包含 kimi-k2.6 的累加
      expect(info.usage_by_model).toBeDefined();
      const m = info.usage_by_model!.find((u) => u.model === 'kimi-k2.6');
      expect(m).toBeDefined();
      expect(m!.input).toBe(130);
      expect(m!.output).toBe(25);
    });
  });

  test('toolUse stopReason → in-progress', () => {
    const tmp = mkFixtureDir('acs-pi-inprog-');
    // 改成只剩 toolUse 不带后续 a2
    const fx = writePiSample(tmp, {
      rows: [
        { type: 'session', version: 3, id: 'pi-ip', timestamp: new Date(T0).toISOString(), cwd: '/tmp/p' },
        {
          type: 'message',
          id: 'u1',
          parentId: null,
          timestamp: new Date(T0 + 100).toISOString(),
          message: { role: 'user', content: [{ type: 'text', text: 'do it' }] },
        },
        {
          type: 'message',
          id: 'a1',
          parentId: 'u1',
          timestamp: new Date(T0 + 1000).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } }],
            provider: 'opencode-go',
            model: 'kimi-k2.6',
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15 },
            stopReason: 'toolUse',
          },
        },
      ],
    });
    withEnv({ PI_SESSIONS_DIR: fx.root }, async () => {
      const list = await listPiCodeSessions();
      const info = await convertPiSession(list[0]);
      expect(info.session_status).toBe('in-progress');
    });
  });

  test('reported-cost rescale overrides table price', () => {
    const tmp = mkFixtureDir('acs-pi-cost-');
    const fx = writePiSample(tmp, {
      rows: [
        { type: 'session', version: 3, id: 'pi-cost', timestamp: new Date(T0).toISOString(), cwd: '/tmp/p' },
        {
          type: 'message',
          id: 'u1',
          parentId: null,
          timestamp: new Date(T0 + 100).toISOString(),
          message: { role: 'user', content: [{ type: 'text', text: 'q' }] },
        },
        {
          type: 'message',
          id: 'a1',
          parentId: 'u1',
          timestamp: new Date(T0 + 1000).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'a' }],
            provider: 'opencode-go',
            model: 'kimi-k2.6',
            usage: {
              input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 1100,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.005678 },
            },
            stopReason: 'stop',
          },
        },
      ],
    });
    withEnv({ PI_SESSIONS_DIR: fx.root }, async () => {
      const list = await listPiCodeSessions();
      const info = await convertPiSession(list[0]);
      // reported cost 兜底后 pricing.usd 应为 reported total
      expect(info.pricing?.usd).toBeCloseTo(0.005678, 5);
      expect(info.cost_is_partial).toBe(false);
    });
  });

  test('reported-cost for unknown model (mimo-v2.5) → details from reported only', () => {
    const tmp = mkFixtureDir('acs-pi-mimo-');
    const fx = writePiSample(tmp, {
      rows: [
        { type: 'session', version: 3, id: 'pi-mimo', timestamp: new Date(T0).toISOString(), cwd: '/tmp/p' },
        {
          type: 'message',
          id: 'u1',
          parentId: null,
          timestamp: new Date(T0 + 100).toISOString(),
          message: { role: 'user', content: [{ type: 'text', text: 'q' }] },
        },
        {
          type: 'message',
          id: 'a1',
          parentId: 'u1',
          timestamp: new Date(T0 + 1000).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'a' }],
            provider: 'opencode-go',
            model: 'mimo-v2.5',
            usage: {
              input: 200, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 250,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000123 },
            },
            stopReason: 'stop',
          },
        },
      ],
    });
    withEnv({ PI_SESSIONS_DIR: fx.root }, async () => {
      const list = await listPiCodeSessions();
      const info = await convertPiSession(list[0]);
      expect(info.pricing?.usd).toBeCloseTo(0.000123, 5);
      expect(info.cost_is_partial).toBe(false);
    });
  });

  test('getPiSessionDetail returns null for missing session', async () => {
    const tmp = mkFixtureDir('acs-pi-empty-');
    withEnv({ PI_SESSIONS_DIR: path.join(tmp, 'sessions') }, async () => {
      const detail = await getPiSessionDetail('nope');
      expect(detail).toBeNull();
    });
  });

  test('getPiSessionDetail returns full messages with tool merged', async () => {
    const tmp = mkFixtureDir('acs-pi-detail-');
    const fx = writePiSample(tmp);
    withEnv({ PI_SESSIONS_DIR: fx.root }, async () => {
      const detail = await getPiSessionDetail(fx.sessionId);
      expect(detail).not.toBeNull();
      expect(detail!.info.id).toBe(fx.sessionId);
      expect(detail!.messages).toHaveLength(3);
      const tool = detail!.messages[1].parts.find((p: any) => p.type === 'tool') as any;
      expect(tool.state.output).toContain('Sample');
    });
  });
});

describe('derivePiTitle', () => {
  test('truncates long user text', () => {
    const t = derivePiTitle('a'.repeat(200), 'sid-xyz');
    // slice(0, TITLE_MAX - 1) + '…' = 49 + 1 = 50 字符
    expect(t.length).toBe(50);
    expect(t.endsWith('…')).toBe(true);
  });
  test('returns full text when short', () => {
    expect(derivePiTitle('short prompt', 'sid-xyz')).toBe('short prompt');
  });
  test('falls back to sessionId prefix when no text', () => {
    expect(derivePiTitle(undefined, 'abcdef-1234')).toBe('abcdef-1');
  });
});