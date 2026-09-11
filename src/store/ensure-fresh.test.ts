/**
 * ensureFresh / listRefs 轻量路径（不依赖真实 session 文件也可跑的逻辑测）
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initStoreDb, closeStoreDb } from './db';
import { saveMeta, emptyMeta, type StoreMeta } from './meta';
import { upsertSession, getCachedDirtyMark } from './upsert';
import { ensureFresh, planEnsureFresh } from './sync';
import { ALL_SOURCES, type SourceId } from './schema';
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

/** agesMs: 距今多久；未列出的源默认 60s（超过默认 minInterval） */
function metaWithAges(now: number, agesMs: Partial<Record<SourceId, number>>): StoreMeta {
  const m = emptyMeta();
  let newest = 0;
  for (const s of ALL_SOURCES) {
    const age = agesMs[s] ?? 60_000;
    const t = now - age;
    m.sources[s] = { last_sync_at: t, session_count: 0 };
    if (t > newest) newest = t;
  }
  m.last_sync_at = newest;
  return m;
}

beforeAll(async () => {
  await initStoreDb({ dbPath, metaPath });
  upsertSession(makeSession('s1'), { dirty_mark: '100' });
});

afterAll(() => {
  closeStoreDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('planEnsureFresh', () => {
  const now = 1_800_000_000_000;
  const maxAgeMs = 6 * 3600_000;
  const minIntervalMs = 30_000;

  test('minInterval=0 即使刚 sync 也走 check（宿主 ?fresh=1）', () => {
    const ages = Object.fromEntries(ALL_SOURCES.map((s) => [s, 5_000])) as Partial<Record<SourceId, number>>;
    const plan = planEnsureFresh({
      sources: [...ALL_SOURCES],
      meta: metaWithAges(now, ages),
      now,
      maxAgeMs,
      minIntervalMs: 0,
    });
    expect(plan.reason).toBe('check');
    expect(plan.checkSources).toEqual([...ALL_SOURCES]);
    expect(plan.staleSources).toEqual([]);
  });

  test('全部源刚 sync → min_interval', () => {
    const ages = Object.fromEntries(ALL_SOURCES.map((s) => [s, 5_000])) as Partial<Record<SourceId, number>>;
    const plan = planEnsureFresh({
      sources: [...ALL_SOURCES],
      meta: metaWithAges(now, ages),
      now,
      maxAgeMs,
      minIntervalMs,
    });
    expect(plan.reason).toBe('min_interval');
    expect(plan.checkSources).toEqual([]);
    expect(plan.staleSources).toEqual([]);
  });

  test('grok 刚 sync、opencode 超过 minInterval → 仍检 opencode', () => {
    const plan = planEnsureFresh({
      sources: [...ALL_SOURCES],
      meta: metaWithAges(now, { grok: 5_000, kimi: 8_000, opencode: 60_000 }),
      now,
      maxAgeMs,
      minIntervalMs,
    });
    expect(plan.reason).toBe('check');
    expect(plan.checkSources).toContain('opencode');
    expect(plan.checkSources).not.toContain('grok');
    expect(plan.checkSources).not.toContain('kimi');
    expect(plan.staleSources).toEqual([]);
  });

  test('全部 TTL 过期 → ttl_all', () => {
    const ages = Object.fromEntries(ALL_SOURCES.map((s) => [s, maxAgeMs + 1])) as Partial<
      Record<SourceId, number>
    >;
    const plan = planEnsureFresh({
      sources: [...ALL_SOURCES],
      meta: metaWithAges(now, ages),
      now,
      maxAgeMs,
      minIntervalMs,
    });
    expect(plan.reason).toBe('ttl_all');
    expect(plan.staleSources).toEqual([...ALL_SOURCES]);
    expect(plan.checkSources).toEqual([]);
  });

  test('任一源从未 sync → never', () => {
    const meta = metaWithAges(now, { grok: 5_000 });
    delete meta.sources.opencode;
    const plan = planEnsureFresh({
      sources: [...ALL_SOURCES],
      meta,
      now,
      maxAgeMs,
      minIntervalMs,
    });
    expect(plan.reason).toBe('never');
  });
});

describe('ensureFresh minInterval', () => {
  test('最近 sync 过 → min_interval，不跑脏检', async () => {
    const now = Date.now();
    const ages = Object.fromEntries(ALL_SOURCES.map((s) => [s, 5_000])) as Partial<Record<SourceId, number>>;
    saveMeta(metaWithAges(now, ages), metaPath);
    const r = await ensureFresh({
      minIntervalMs: 30_000,
      maxAgeMs: 6 * 3600_000,
      checkDirty: false,
      sync: { source: 'all', dbPath, metaPath },
    });
    expect(r.synced).toBe(false);
    expect(r.reason).toBe('min_interval');
  });

  test('热 grok 刚 sync 不挡 opencode 脏检（checkDirty=false → clean 而非 min_interval）', async () => {
    const now = Date.now();
    saveMeta(metaWithAges(now, { grok: 5_000, kimi: 5_000, opencode: 60_000 }), metaPath);
    const r = await ensureFresh({
      minIntervalMs: 30_000,
      maxAgeMs: 6 * 3600_000,
      checkDirty: false,
      sync: { source: 'all', dbPath, metaPath },
    });
    expect(r.synced).toBe(false);
    expect(r.reason).toBe('clean');
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
