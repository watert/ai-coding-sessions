/**
 * 各 source list + convert 主路径（hermetic fixture，无真实 CLI 数据）
 */
import { describe, expect, test, afterEach } from 'bun:test';
import {
  createClaudeFixture,
  createCodexFixture,
  createKimiFixture,
  createGrokFixture,
  createZcodeFixture,
  createWorkbuddyFixture,
  createCursorFixture,
} from './__fixtures__/sources';
import { listClaudeCodeSessions } from './claude-code';
import { convertClaudeSession } from './claude-source';
import { listCodexSessions, closeCodexDb } from './codex-code';
import { convertCodexSession } from './codex-source';
import { listKimiCodeSessions } from './kimi-code';
import { convertKimiSession } from './kimi-source';
import { listGrokCodeSessions } from './grok-code';
import { convertGrokSession } from './grok-source';
import { listZcodeSessions, closeZcodeDb, initZcodeDb } from './zcode-code';
import { convertZcodeSession } from './zcode-source';
import { listWorkbuddySessions, closeWorkbuddyDb, initWorkbuddyDb } from './workbuddy-code';
import { convertWorkbuddySession } from './workbuddy-source';
import { listCursorSessions, closeCursorDb, initCursorDb } from './cursor-code';
import { convertCursorSession } from './cursor-source';

function withEnv(patch: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    prev[k] = process.env[k];
    const v = patch[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(patch)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

afterEach(() => {
  try { closeZcodeDb(); } catch { /* */ }
  try { closeCursorDb(); } catch { /* */ }
  try { closeCodexDb(); } catch { /* */ }
  try { closeWorkbuddyDb(); } catch { /* */ }
});

describe('source fixtures list+convert', () => {
  test('claude', async () => {
    const fx = createClaudeFixture();
    await withEnv({ CLAUDE_CONFIG_DIR: fx.root }, async () => {
      const list = await listClaudeCodeSessions();
      expect(list.length).toBe(1);
      expect(list[0].sessionId).toBe(fx.sessionId);
      const info = await convertClaudeSession(list[0]);
      expect(info.id).toBe(fx.sessionId);
      expect(info.total_messages).toBeGreaterThanOrEqual(1);
      expect(info.total_tokens).toBeGreaterThanOrEqual(15);
    });
  });

  test('codex', async () => {
    const fx = createCodexFixture();
    await withEnv({ CODEX_HOME: fx.root }, async () => {
      closeCodexDb();
      const list = await listCodexSessions();
      expect(list.some((s) => s.sessionId === fx.sessionId)).toBe(true);
      const sess = list.find((s) => s.sessionId === fx.sessionId)!;
      const info = await convertCodexSession(sess);
      expect(info.id).toBe(fx.sessionId);
      expect(info.total_messages).toBeGreaterThanOrEqual(1);
    });
  });

  test('kimi', async () => {
    const fx = createKimiFixture();
    await withEnv({ KIMI_DATA_DIR: fx.root }, async () => {
      const list = await listKimiCodeSessions();
      expect(list.some((s) => s.sessionId === fx.sessionId)).toBe(true);
      const sess = list.find((s) => s.sessionId === fx.sessionId)!;
      const info = await convertKimiSession(sess);
      expect(info.id).toBe(fx.sessionId);
      expect(info.title).toContain('Kimi');
    });
  });

  test('grok', async () => {
    const fx = createGrokFixture();
    await withEnv({ GROK_SESSIONS_DIR: fx.sessionsRoot }, async () => {
      const list = await listGrokCodeSessions();
      expect(list.some((s) => s.sessionId === fx.sessionId)).toBe(true);
      const sess = list.find((s) => s.sessionId === fx.sessionId)!;
      const info = await convertGrokSession(sess);
      expect(info.id).toBe(fx.sessionId);
    });
  });

  test('zcode', async () => {
    const fx = createZcodeFixture();
    await withEnv({ ZCODE_DB_PATH: fx.dbPath }, async () => {
      closeZcodeDb();
      const ok = await initZcodeDb();
      expect(ok).toBe(true);
      const list = await listZcodeSessions();
      expect(list.some((s) => s.sessionId === fx.sessionId)).toBe(true);
      const sess = list.find((s) => s.sessionId === fx.sessionId)!;
      const info = await convertZcodeSession(sess);
      expect(info.id).toBe(fx.sessionId);
      expect(info.total_messages).toBeGreaterThanOrEqual(1);
    });
  });

  test('workbuddy', async () => {
    const fx = createWorkbuddyFixture();
    await withEnv({ WORKBUDDY_HOME: fx.root }, async () => {
      closeWorkbuddyDb();
      const ok = await initWorkbuddyDb();
      expect(ok).toBe(true);
      const list = await listWorkbuddySessions();
      expect(list.some((s) => s.sessionId === fx.sessionId)).toBe(true);
      const sess = list.find((s) => s.sessionId === fx.sessionId)!;
      const info = await convertWorkbuddySession(sess);
      expect(info.id).toBe(fx.sessionId);
    });
  });

  test('cursor', async () => {
    const fx = createCursorFixture();
    await withEnv(
      {
        CURSOR_APP_DATA: fx.appData,
        CURSOR_HOME: fx.cursorHome,
        CURSOR_STATE_DB: fx.dbPath,
      },
      async () => {
        closeCursorDb();
        const ok = await initCursorDb();
        expect(ok).toBe(true);
        const list = await listCursorSessions();
        expect(list.some((s) => s.sessionId === fx.sessionId)).toBe(true);
        const sess = list.find((s) => s.sessionId === fx.sessionId)!;
        const info = await convertCursorSession(sess);
        expect(info.id).toBe(fx.sessionId);
        expect(info.total_messages).toBeGreaterThanOrEqual(1);
      },
    );
  });
});
