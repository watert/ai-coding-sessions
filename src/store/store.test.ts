/**
 * store 单元测试（临时 DB，不依赖真实 coding session 数据）
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initStoreDb, closeStoreDb, getStoreDb } from './db';
import { upsertSession, markOrphans, countStats, getCachedFingerprint, getCachedDirtyMark } from './upsert';
import { queryCached, getSessionPrompts, queryUsageByDay } from './query';
import { loadMeta, saveMeta, emptyMeta } from './meta';
import { contentFingerprint, extractPrompts, extractUsageByModel } from './fingerprint';
import { SCHEMA_VERSION } from './schema';
import type { UnifiedSessionInfo } from '../sources/types';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-store-'));
const dbPath = path.join(tmpDir, 'test.sqlite');
const metaPath = path.join(tmpDir, 'test.meta.json');

function makeSession(partial: Partial<UnifiedSessionInfo> & { id: string }): UnifiedSessionInfo {
  return {
    // id 由末尾 `...partial` 提供，此处重复声明会被覆盖（TS2783）
    project_id: partial.project_id || 'proj',
    slug: partial.slug || partial.id,
    directory: partial.directory || '/tmp',
    title: partial.title || 't',
    version: '1',
    time_created: partial.time_created ?? 1_700_000_000_000,
    time_updated: partial.time_updated ?? 1_700_000_100_000,
    source: partial.source || 'claude',
    total_tokens: partial.total_tokens ?? 100,
    total_input: partial.total_input ?? 60,
    total_output: partial.total_output ?? 40,
    total_messages: partial.total_messages ?? 2,
    total_user_messages: partial.total_user_messages ?? 1,
    models_used: partial.models_used || 'claude-sonnet',
    last_active_at_iso: partial.last_active_at_iso || new Date(1_700_000_100_000).toISOString(),
    first_active_at_iso: partial.first_active_at_iso || new Date(1_700_000_000_000).toISOString(),
    userParts: partial.userParts || [
      { role: 'user', text: 'hello world', tool: '', duration: 0, startTime: 1_700_000_000_000, endTime: 1_700_000_000_100 },
    ],
    usage_by_day: partial.usage_by_day || [
      {
        date: '2023-11-14',
        tokens: 100,
        input: 60,
        output: 40,
        cacheRead: 0,
        cacheWrite: 0,
        usd: 0,
        cny: 0,
        byModel: [
          {
            modelKey: 'anthropic/claude-sonnet',
            tokens: 100,
            input: 60,
            output: 40,
            cacheRead: 0,
            cacheWrite: 0,
            usd: 0,
            cny: 0,
          },
        ],
      },
    ],
    pricing: partial.pricing || {
      usd: 0.01,
      cny: 0.07,
      details: [
        {
          modelKey: 'anthropic/claude-sonnet',
          input: 60,
          output: 40,
          cacheRead: 0,
          cacheWrite: 0,
          usd: 0.01,
          cny: 0.07,
        },
      ],
    },
    ...partial,
  } as UnifiedSessionInfo;
}

beforeAll(async () => {
  await initStoreDb({ dbPath, metaPath });
});

afterAll(() => {
  closeStoreDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('fingerprint', () => {
  test('extractUsageByModel from pricing.details', () => {
    const s = makeSession({ id: 'a' });
    const u = extractUsageByModel(s);
    expect(u.length).toBe(1);
    expect(u[0].model).toBe('claude-sonnet');
    expect(u[0].input).toBe(60);
  });

  test('extractPrompts keeps full text', () => {
    const s = makeSession({ id: 'b' });
    const p = extractPrompts(s);
    expect(p).toEqual([
      { idx: 0, created_at: 1_700_000_000_000, text: 'hello world' },
    ]);
  });

  test('contentFingerprint stable then changes on title', () => {
    const s1 = makeSession({ id: 'c', title: 'one' });
    const s2 = makeSession({ id: 'c', title: 'one' });
    const s3 = makeSession({ id: 'c', title: 'two' });
    expect(contentFingerprint(s1)).toBe(contentFingerprint(s2));
    expect(contentFingerprint(s1)).not.toBe(contentFingerprint(s3));
  });
});

describe('upsert + query', () => {
  test('schema_version written', () => {
    const db = getStoreDb();
    const row = db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get('schema_version') as {
      value: string;
    };
    expect(Number(row.value)).toBe(SCHEMA_VERSION);
  });

  test('upsert insert then skip then update', () => {
    const s = makeSession({ id: 'sess-1', title: 'v1' });
    const r1 = upsertSession(s, { dirty_mark: '100' });
    expect(r1.action).toBe('insert');
    const r2 = upsertSession(s, { dirty_mark: '100' });
    expect(r2.action).toBe('skip');
    const s2 = makeSession({ id: 'sess-1', title: 'v2', total_tokens: 200 });
    const r3 = upsertSession(s2, { dirty_mark: '200' });
    expect(r3.action).toBe('update');
    expect(getCachedFingerprint('claude', 'sess-1')).toBe(contentFingerprint(s2));
  });

  test('payload strips pricing', () => {
    const cached = queryCached({ source: 'claude' });
    const found = cached.sessions.find((x) => x.id === 'sess-1');
    expect(found).toBeTruthy();
    expect((found as any).pricing).toBeUndefined();
    expect((found as any).usage_by_model?.length).toBeGreaterThan(0);
  });

  test('meta column persists credits meta', () => {
    upsertSession(
      makeSession({
        id: 'meta-sess',
        title: 'm',
        total_credits: 1.5,
        meta: { workbuddy: { totalCredits: 1.5, creditsByModel: { 'hy3-x': 1.5 }, dbCredits: 0.53 } },
      }),
    );
    const db = getStoreDb();
    const row = db
      .prepare(`SELECT meta FROM sessions WHERE source = ? AND session_id = ?`)
      .get('claude', 'meta-sess') as { meta: string | null };
    expect(JSON.parse(row.meta!)).toEqual({
      workbuddy: { totalCredits: 1.5, creditsByModel: { 'hy3-x': 1.5 }, dbCredits: 0.53 },
    });
    // payload 透出（queryCached 从 payload 读）
    const cached = queryCached({ source: 'claude' });
    const found = cached.sessions.find((x) => x.id === 'meta-sess');
    expect((found as any).meta).toEqual({
      workbuddy: { totalCredits: 1.5, creditsByModel: { 'hy3-x': 1.5 }, dbCredits: 0.53 },
    });
    expect((found as any).total_credits).toBe(1.5);
  });

  test('prompts full text queryable', () => {
    const rows = getSessionPrompts('claude', 'sess-1');
    expect(rows.length).toBe(1);
    expect(rows[0].text).toBe('hello world');
  });

  test('usage_by_day has usage_by_model', () => {
    const days = queryUsageByDay({ source: 'claude' });
    const row = days.find((d) => d.session_id === 'sess-1');
    expect(row).toBeTruthy();
    expect(row!.usage_by_model.length).toBe(1);
    expect(row!.input_tokens).toBe(60);
  });

  test('orphan mark not delete', () => {
    upsertSession(makeSession({ id: 'orphan-me', title: 'x' }));
    const n = markOrphans('claude', new Set(['sess-1']));
    expect(n).toBeGreaterThanOrEqual(1);
    const withOrphan = queryCached({ source: 'claude', includeOrphan: true });
    const without = queryCached({ source: 'claude', includeOrphan: false });
    expect(withOrphan.sessions.some((s) => s.id === 'orphan-me')).toBe(true);
    expect(without.sessions.some((s) => s.id === 'orphan-me')).toBe(false);
    // 行仍在
    const db = getStoreDb();
    const row = db
      .prepare(`SELECT orphaned_at FROM sessions WHERE source=? AND session_id=?`)
      .get('claude', 'orphan-me') as { orphaned_at: number };
    expect(row.orphaned_at).toBeTruthy();
  });

  test('countStats', () => {
    const st = countStats();
    expect(st.session_count).toBeGreaterThanOrEqual(2);
    expect(st.prompt_count).toBeGreaterThanOrEqual(1);
  });
});

describe('meta json', () => {
  test('save/load', () => {
    const m = emptyMeta();
    m.last_sync_at = 123;
    m.sources.claude = { last_sync_at: 123, session_count: 2 };
    saveMeta(m, metaPath);
    const loaded = loadMeta(metaPath);
    expect(loaded.last_sync_at).toBe(123);
    expect(loaded.sources.claude?.session_count).toBe(2);
  });
});

describe('upsert dirty_mark on skip', () => {
  test('skip 仍刷新 dirty_mark（避免心跳反复脏）', () => {
    const s = makeSession({ id: 'dirty-skip-1', title: 'same' });
    const r1 = upsertSession(s, { dirty_mark: '100' });
    expect(r1.action).toBe('insert');
    expect(getCachedDirtyMark('claude', 'dirty-skip-1')).toBe('100');

    // 同内容不同 dirty_mark → skip，但 mark 应更新
    const r2 = upsertSession(s, { dirty_mark: '200' });
    expect(r2.action).toBe('skip');
    expect(getCachedDirtyMark('claude', 'dirty-skip-1')).toBe('200');
  });
});
