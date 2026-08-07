/**
 * ensureFresh / listRefs 轻量路径（不依赖真实 session 文件也可跑的逻辑测）
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initStoreDb, closeStoreDb } from './db';
import { loadMeta, saveMeta, emptyMeta } from './meta';
import { upsertSession, getCachedDirtyMark } from './upsert';
import { ensureFresh } from './sync';
import type { UnifiedSessionInfo } from '../sources/types';
import { grokActivityDirtyMark } from '../sources/grok-code';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-ef-'));
const dbPath = path.join(tmpDir, 'test.sqlite');
const metaPath = path.join(tmpDir, 'test.meta.json');

function makeSession(id: string): UnifiedSessionInfo {
  return {
    id,
    project_id: 'p',
    slug: id,
    directory: '/tmp',
    title: 't',
    version: '1',
    time_created: 1_700_000_000_000,
    time_updated: 1_700_000_100_000,
    source: 'claude',
    total_tokens: 10,
    total_input: 5,
    total_output: 5,
    total_messages: 1,
    total_user_messages: 1,
    models_used: 'x',
    last_active_at_iso: new Date(1_700_000_100_000).toISOString(),
    first_active_at_iso: new Date(1_700_000_000_000).toISOString(),
  };
}

beforeAll(async () => {
  await initStoreDb({ dbPath, metaPath });
  upsertSession(makeSession('s1'), { dirty_mark: '100' });
  const m = emptyMeta();
  const now = Date.now();
  // 全部源刚 sync 过
  for (const s of ['claude', 'opencode', 'kimi', 'grok', 'codex', 'zcode', 'workbuddy', 'cursor'] as const) {
    m.sources[s] = { last_sync_at: now - 5_000, session_count: 0 };
  }
  m.last_sync_at = now - 5_000;
  saveMeta(m, metaPath);
});

afterAll(() => {
  closeStoreDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('ensureFresh minInterval', () => {
  test('最近 sync 过 → min_interval，不跑脏检', async () => {
    const r = await ensureFresh({
      minIntervalMs: 30_000,
      maxAgeMs: 6 * 3600_000,
      sync: { source: 'all', dbPath, metaPath },
    });
    expect(r.synced).toBe(false);
    expect(r.reason).toBe('min_interval');
  });

  test('upsert skip 刷新 dirty_mark', () => {
    expect(getCachedDirtyMark('claude', 's1')).toBe('100');
    upsertSession(makeSession('s1'), { dirty_mark: '200' });
    expect(getCachedDirtyMark('claude', 's1')).toBe('200');
  });
});

describe('grokActivityDirtyMark', () => {
  test('优先 updates.jsonl mtime:size', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-ref-'));
    fs.writeFileSync(path.join(dir, 'summary.json'), '{}');
    fs.writeFileSync(path.join(dir, 'updates.jsonl'), 'line1\n');
    const a = grokActivityDirtyMark(dir);
    expect(a.mark).toMatch(/^\d+:\d+$/);
    // 改 summary 不应改变 mark（仍有 updates）
    fs.writeFileSync(path.join(dir, 'summary.json'), '{"last_active_at":"2099-01-01"}');
    const b = grokActivityDirtyMark(dir);
    expect(b.mark).toBe(a.mark);
    // 改 updates 应变
    fs.writeFileSync(path.join(dir, 'updates.jsonl'), 'line1\nline2\n');
    const c = grokActivityDirtyMark(dir);
    expect(c.mark).not.toBe(a.mark);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
