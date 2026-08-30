/**
 * session-tool-calls 单元测试（临时 DB, 不依赖真实 session 数据）
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initStoreDb, closeStoreDb } from './db';
import { extractToolCalls, queryToolCallsBySession, replaceToolCalls, getToolCallsBuiltAt } from './session-tool-calls';
import type { UnifiedSessionDetail } from '../sources/types';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-toolcalls-'));

function msg(info: any, parts: any[]) {
  return { info, parts };
}

function detailOf(messages: any[]): UnifiedSessionDetail {
  return { messages } as unknown as UnifiedSessionDetail;
}

const fixtureDetail = detailOf([
  msg({ role: 'user', id: 'u1' }, [{ type: 'text', text: '跑一下' }]),
  msg(
    { role: 'assistant', id: 'a1', parentID: 'u1' },
    [
      { type: 'tool', tool: 'Bash', state: { status: 'completed', input: { command: 'kimi -p hi' }, output: 'ok' } },
      { type: 'tool', tool: 'read_file', state: { status: 'completed', input: { path: '/tmp/a.md' }, output: 'x'.repeat(5000) } },
    ],
  ),
  msg({ role: 'user', id: 'u2' }, [{ type: 'text', text: '再来' }]),
  msg(
    { role: 'assistant', id: 'a2', parentID: 'u2' },
    [
      { type: 'tool', tool: 'Bash', state: { status: 'error', input: 'bad-cmd', error: 'user aborted the operation' } },
    ],
  ),
]);

beforeAll(() => {
  initStoreDb({ dbPath: path.join(tmpDir, 'test.sqlite'), metaPath: path.join(tmpDir, 'test.meta.json') });
});

afterAll(() => {
  closeStoreDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('session-tool-calls', () => {
  test('extractToolCalls: user turn 递增 + input 全文不截断 + output_len', () => {
    const rows = extractToolCalls(fixtureDetail.messages);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ idx: 0, msg_idx: 1, turn: 0, tool: 'Bash', status: 'completed', soft: false });
    expect(rows[0].input).toEqual({ command: 'kimi -p hi' });
    expect(rows[1]).toMatchObject({ idx: 1, tool: 'read_file', output_len: 5000 });
    // turn 随第二个 user 递增 + soft 识别 (user abort)
    expect(rows[2]).toMatchObject({ idx: 2, turn: 1, status: 'error', soft: true });
    expect(rows[2].error).toContain('aborted');
  });

  test('extractToolCalls: tool 名过滤 + output_preview 截断', () => {
    const bashOnly = extractToolCalls(fixtureDetail.messages, { tool: 'bash' });
    expect(bashOnly).toHaveLength(2);
    expect(bashOnly.every((r) => r.tool === 'Bash')).toBe(true);

    const withPreview = extractToolCalls(fixtureDetail.messages, { maxOutputChars: 10 });
    expect((withPreview[1] as any).output_preview).toBe(`${'x'.repeat(10)}…`);
    expect(withPreview[1].output_len).toBe(5000);
  });

  test('物化表 roundtrip: replace → query, JSON input 还原为对象 + built_at 增量判断', () => {
    const rows = extractToolCalls(fixtureDetail.messages);
    const n = replaceToolCalls('grok', 's-roundtrip', rows, 1_700_000_200_000);
    expect(n).toBe(3);

    const all = queryToolCallsBySession('grok', 's-roundtrip');
    expect(all).toHaveLength(3);
    expect(all[0].source).toBe('grok');
    expect(all[0].session_id).toBe('s-roundtrip');
    // input 存 JSON 文本, 读回还原对象
    expect(all[0].input).toEqual({ command: 'kimi -p hi' });
    expect(all[2].soft).toBe(true);

    // 过滤
    expect(queryToolCallsBySession('grok', 's-roundtrip', { tool: 'bash' })).toHaveLength(2);
    expect(queryToolCallsBySession('grok', 's-roundtrip', { noSoft: true })).toHaveLength(2);

    // built_at: 增量判断依据
    expect(getToolCallsBuiltAt('grok', 's-roundtrip')).toBe(1_700_000_200_000);
    expect(getToolCallsBuiltAt('grok', 's-missing')).toBeNull();

    // 全量替换: 二次 replace 覆盖旧行
    replaceToolCalls('grok', 's-roundtrip', rows.slice(0, 1), 1_700_000_300_000);
    expect(queryToolCallsBySession('grok', 's-roundtrip')).toHaveLength(1);
    expect(getToolCallsBuiltAt('grok', 's-roundtrip')).toBe(1_700_000_300_000);
  });
});
