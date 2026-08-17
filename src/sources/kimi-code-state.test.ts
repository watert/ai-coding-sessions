/**
 * state.json 新旧格式兼容: epoch 数字 createdAt/updatedAt 不应导致 title 丢失
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listKimiCodeSessions, getKimiSessionItemsByIds } from './kimi-code';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-state-'));
const prevEnv = process.env.KIMI_DATA_DIR;
const EPOCH = 1_786_721_159_647;
const ISO = '2026-08-14T15:25:59.777Z';

function setupSession(sid: string, state: Record<string, unknown>): string {
  const dir = path.join(tmpRoot, 'sessions', 'wd_test_1234', sid);
  fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), '');
  return dir;
}

describe('kimi state.json epoch 数字格式', () => {
  beforeAll(() => {
    process.env.KIMI_DATA_DIR = tmpRoot;
    fs.mkdirSync(path.join(tmpRoot, 'sessions'), { recursive: true });
    const sessionDir = setupSession('session_epoch_num', {
      id: 'session_epoch_num',
      version: 2,
      cwd: '/tmp',
      createdAt: EPOCH,
      updatedAt: EPOCH + 1000,
      archived: false,
      title: '数字 epoch 标题',
      isCustomTitle: false,
      lastPrompt: 'last prompt',
    });
    setupSession('session_epoch_str', {
      id: 'session_epoch_str',
      version: 1,
      cwd: '/tmp',
      createdAt: ISO,
      updatedAt: ISO,
      archived: false,
      title: '字符串 epoch 标题',
      isCustomTitle: false,
    });
    const index = [
      { sessionId: 'session_epoch_num', sessionDir, workDir: '/tmp' },
      { sessionId: 'session_epoch_str', sessionDir: path.join(tmpRoot, 'sessions', 'wd_test_1234', 'session_epoch_str'), workDir: '/tmp' },
    ];
    fs.writeFileSync(path.join(tmpRoot, 'session_index.jsonl'), index.map((o) => JSON.stringify(o)).join('\n') + '\n');
  });

  afterAll(() => {
    if (prevEnv === undefined) delete process.env.KIMI_DATA_DIR;
    else process.env.KIMI_DATA_DIR = prevEnv;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('数字 epoch 不再丢 title', async () => {
    const items = await getKimiSessionItemsByIds(['session_epoch_num']);
    expect(items.length).toBe(1);
    expect(items[0].title).toBe('数字 epoch 标题');
    expect(items[0].createdAt).toBe(EPOCH);
  });

  test('ISO string 旧格式回归保护', async () => {
    const items = await getKimiSessionItemsByIds(['session_epoch_str']);
    expect(items.length).toBe(1);
    expect(items[0].title).toBe('字符串 epoch 标题');
    expect(items[0].createdAt).toBe(new Date(ISO).getTime());
  });

  test('list 视图同样解析 title', async () => {
    const all = await listKimiCodeSessions();
    const num = all.find((s) => s.sessionId === 'session_epoch_num');
    const str = all.find((s) => s.sessionId === 'session_epoch_str');
    expect(num?.title).toBe('数字 epoch 标题');
    expect(str?.title).toBe('字符串 epoch 标题');
  });
});
