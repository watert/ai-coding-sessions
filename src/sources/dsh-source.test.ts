/**
 * DSH source: 事件转换 / inherited 剥离 / zstd 拼接帧
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertDshEventsToMessages } from './dsh-source';
import {
  decompressDshZstd,
  parseDshLogFilename,
  pickDshLogFile,
  resolveDshHome,
  resolveDshSessionsRoot,
  type DshEvent,
} from './dsh-code';

describe('dsh source', () => {
  test('parse generation filename', () => {
    expect(parseDshLogFilename('session.jsonl.zstd')).toEqual({ version: 0, compressed: true });
    expect(parseDshLogFilename('session.v3.jsonl.zstd')).toEqual({ version: 3, compressed: true });
    expect(parseDshLogFilename('session.v3.jsonl')).toEqual({ version: 3, compressed: false });
    expect(parseDshLogFilename('session.lock')).toBeNull();
  });

  test('pick highest generation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-dsh-gen-'));
    fs.writeFileSync(path.join(dir, 'session.v1.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), 'x');
    fs.writeFileSync(path.join(dir, 'session.lock'), '');
    const hit = pickDshLogFile(dir)!;
    expect(hit.version).toBe(3);
    expect(hit.logPath.endsWith('session.v3.jsonl.zstd')).toBe(true);
  });

  test('path resolve: DSH_SESSIONS_DIR / DSH_HOME', () => {
    expect(resolveDshHome({ HOME: '/tmp/h', DSH_HOME: '/tmp/custom-dsh' })).toBe('/tmp/custom-dsh');
    expect(resolveDshSessionsRoot({ HOME: '/tmp/h', DSH_HOME: '/tmp/custom-dsh' }))
      .toBe('/tmp/custom-dsh/sessions');
    expect(resolveDshSessionsRoot({ HOME: '/tmp/h', DSH_SESSIONS_DIR: '/tmp/sess' })).toBe('/tmp/sess');
    expect(resolveDshHome({ HOME: '/tmp/h' })).toBe('/tmp/h/.dsh');
  });

  test('skip synthetic user; pair tool result; title from session/title', () => {
    const events: DshEvent[] = [
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 1010, data: { turn: 1, step: 1 } },
      { type: 'user/message', seq: 3, time: 1011, data: {
        id: 'u1', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'hello' }],
      } },
      { type: 'user/message', seq: 4, time: 1012, data: {
        id: 'u-sys', role: 'user', source: { kind: 'plugin' },
        content: [{ type: 'text', text: 'runtime snapshot' }],
      } },
      { type: 'session/title', seq: 5, time: 1013, data: { title: 'Hello DSH' } },
      { type: 'assistant/message', seq: 6, time: 1300, data: {
        turn: 1, step: 1,
        message: {
          id: 'a1', role: 'assistant',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"pwd"}' },
          ],
          source: { kind: 'model', provider: 'minimax-cn', model: 'MiniMax-M3' },
        },
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, totalTokens: 16 },
        stream: [{ type: 'chunk', time: 1100 }, { type: 'text-chunks', time0: 1100, dt: [80] }],
      } },
      { type: 'tool/result', seq: 7, time: 1400, data: {
        message: {
          source: { callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '/tmp' }], isError: false }],
        },
      } },
      { type: 'turn/end', seq: 8, time: 1410, data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    const r = convertDshEventsToMessages('s1', events, { fallbackCwd: '/tmp' });
    expect(r.title).toBe('Hello DSH');
    expect(r.lastTurnReason).toBe('completed');
    expect(r.turnOpen).toBe(false);
    const users = r.messages.filter((m) => m.info.role === 'user');
    expect(users).toHaveLength(1);
    expect((users[0].parts[0] as any).text).toBe('hello');
    const asst = r.messages.find((m) => m.info.role === 'assistant')!;
    expect(asst.info.tokens?.input).toBe(10);
    expect(asst.info.tokens?.cache?.read).toBe(2);
    const tool = asst.parts.find((p: any) => p.type === 'tool') as any;
    expect(tool.tool).toBe('bash');
    expect(tool.state.output).toBe('/tmp');
    expect(tool.state.status).toBe('completed');
    expect(asst.info.time.decodeStart).toBe(1100);
  });

  test('inbox next-step while turn open → insert origin', () => {
    const events: DshEvent[] = [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'agent/inbox/spliced', seq: 2, time: 2, data: {
        target: 'next-step',
        inserted: [{ id: 'u-ins', content: [{ type: 'text', text: 'steer' }], source: { kind: 'user' } }],
      } },
      { type: 'user/message', seq: 3, time: 3, data: {
        id: 'u-ins', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'steer' }],
      } },
    ];
    const r = convertDshEventsToMessages('s1', events);
    expect((r.messages[0].info as any).user_origin).toBe('insert');
  });

  test('inherited end-seed 前缀不进入 messages', () => {
    const events: DshEvent[] = [
      { type: 'user/message', seq: 1, time: 1, data: {
        id: 'parent-u', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'parent prompt' }],
      } },
      { type: 'session/end-seed', seq: 2, time: 2, data: { inherited: true } },
      { type: 'user/message', seq: 3, time: 3, data: {
        id: 'child-u', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'child prompt' }],
      } },
    ];
    const r = convertDshEventsToMessages('child', events);
    expect(r.messages).toHaveLength(1);
    expect((r.messages[0].parts[0] as any).text).toBe('child prompt');
  });

  test('Bun 解开拼接 zstd 帧', () => {
    const a = Buffer.from(Bun.zstdCompressSync(Buffer.from('{"type":"session","id":"s"}\n')));
    const b = Buffer.from(Bun.zstdCompressSync(Buffer.from('{"type":"turn/start","seq":0}\n')));
    const text = decompressDshZstd(Buffer.concat([a, b]));
    expect(text).toContain('"type":"session"');
    expect(text).toContain('"type":"turn/start"');
  });
});
