/**
 * custom_title overlay：sync 不覆盖、query/detail 展示、resolve 可匹配
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initStoreDb, closeStoreDb, getStoreDb } from './db';
import { upsertSession } from './upsert';
import { queryCached, getCachedSession } from './query';
import { resolveSessionRef } from './session-resolve';
import { SCHEMA_VERSION } from './schema';
import {
  isWeakTitle,
  normalizeCustomTitle,
  setSessionTitle,
  applyCustomTitle,
  overlaySessionDetail,
} from './session-title';
import type { UnifiedSessionInfo, UnifiedSessionDetail } from '../sources/types';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-title-'));
const dbPath = path.join(tmpDir, 'test.sqlite');
const metaPath = path.join(tmpDir, 'test.meta.json');

function makeSession(partial: Partial<UnifiedSessionInfo> & { id: string }): UnifiedSessionInfo {
  return {
    // id 由末尾 `...partial` 提供，此处重复声明会被覆盖（TS2783）
    project_id: 'proj',
    slug: partial.id,
    directory: '/tmp',
    title: partial.title || 'Untitled',
    version: '1',
    time_created: 1_700_000_000_000,
    time_updated: 1_700_000_100_000,
    source: partial.source || 'kimi',
    total_tokens: partial.total_tokens ?? 10,
    last_active_at_iso: new Date(1_700_000_100_000).toISOString(),
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

describe('isWeakTitle / normalize', () => {
  test('weak placeholders', () => {
    expect(isWeakTitle('')).toBe(true);
    expect(isWeakTitle(null)).toBe(true);
    expect(isWeakTitle('Untitled')).toBe(true);
    expect(isWeakTitle('untitled')).toBe(true);
    expect(isWeakTitle('New Session')).toBe(true);
    expect(isWeakTitle('New session - 2026-08-10T02:38:56.408Z')).toBe(true);
    expect(isWeakTitle('知乎爬虫评审')).toBe(false);
  });

  test('normalize trims and caps', () => {
    expect(normalizeCustomTitle('  a   b  ')).toBe('a b');
    expect(normalizeCustomTitle('   ')).toBe(null);
    expect(normalizeCustomTitle('x'.repeat(250))?.length).toBe(200);
  });
});

describe('set + overlay + sync', () => {
  test('schema v2 columns exist', () => {
    const db = getStoreDb();
    const ver = db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get('schema_version') as {
      value: string;
    };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('custom_title');
    expect(cols).toContain('custom_title_at');
  });

  test('set-title overlays query; upsert does not wipe', () => {
    upsertSession(makeSession({ id: 'sess-title-1', title: 'Untitled' }));
    const r1 = setSessionTitle('kimi', 'sess-title-1', '知乎爬虫评审');
    expect(r1.ok).toBe(true);
    expect(r1.action).toBe('set');
    expect(r1.title).toBe('知乎爬虫评审');

    const cached = getCachedSession('kimi', 'sess-title-1');
    expect(cached?.title).toBe('知乎爬虫评审');
    expect(cached?.source_title).toBe('Untitled');
    expect(cached?.title_is_custom).toBe(true);

    upsertSession(makeSession({ id: 'sess-title-1', title: 'Untitled', total_tokens: 99 }));
    const after = getCachedSession('kimi', 'sess-title-1');
    expect(after?.title).toBe('知乎爬虫评审');
    expect(after?.source_title).toBe('Untitled');
    expect(after?.total_tokens).toBe(99);
  });

  test('untitledOnly hides custom and real titles', () => {
    upsertSession(makeSession({ id: 'sess-weak', title: 'New Session' }));
    upsertSession(makeSession({ id: 'sess-real', title: '实标题' }));
    setSessionTitle('kimi', 'sess-title-1', '知乎爬虫评审');

    const weak = queryCached({ source: 'kimi', untitledOnly: true });
    const ids = weak.sessions.map((s) => s.id);
    expect(ids).toContain('sess-weak');
    expect(ids).not.toContain('sess-title-1');
    expect(ids).not.toContain('sess-real');
  });

  test('clear restores source title', () => {
    const r = setSessionTitle('kimi', 'sess-title-1', null);
    expect(r.action).toBe('clear');
    const cached = getCachedSession('kimi', 'sess-title-1');
    expect(cached?.title).toBe('Untitled');
    expect(cached?.title_is_custom).toBe(false);
  });

  test('not_found', () => {
    const r = setSessionTitle('kimi', 'no-such-id', 'x');
    expect(r.ok).toBe(false);
    expect(r.action).toBe('not_found');
  });

  test('resolve matches custom title', () => {
    upsertSession(makeSession({ id: 'sess-res', title: 'Untitled' }));
    setSessionTitle('kimi', 'sess-res', 'handoff overlay title');
    const listed = queryCached({ source: 'kimi' }).sessions;
    const hit = resolveSessionRef(listed, 'overlay title');
    expect(hit.ok && hit.session.id).toBe('sess-res');
  });

  test('resolve strips URL query string', () => {
    upsertSession(makeSession({ id: 'sess-res', title: 'Untitled' }));
    const listed = queryCached({ source: 'kimi' }).sessions;
    const hit = resolveSessionRef(listed, 'sess-res?source=kimi');
    expect(hit.ok && hit.session.id).toBe('sess-res');
  });

  test('overlaySessionDetail', async () => {
    upsertSession(makeSession({ id: 'sess-detail', title: 'Untitled' }));
    setSessionTitle('kimi', 'sess-detail', '详情标题');
    const detail = await overlaySessionDetail({
      info: makeSession({ id: 'sess-detail', title: 'Untitled' }),
      messages: [],
      editDiffs: { additions: 0, deletions: 0, filesChanged: 0 },
    } as UnifiedSessionDetail);
    expect(detail.info.title).toBe('详情标题');
    expect(detail.info.source_title).toBe('Untitled');
  });

  test('applyCustomTitle without row is no-op overlay', () => {
    const s = applyCustomTitle(makeSession({ id: 'never-synced', title: 'Untitled' }));
    expect(s.title).toBe('Untitled');
    expect(s.title_is_custom).toBe(false);
  });
});
