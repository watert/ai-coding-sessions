/**
 * prompts 批量导出：显式 ids（顺序保持）与窗口过滤（queryCached）两种模式
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initStoreDb, closeStoreDb } from './db';
import { upsertSession } from './upsert';
import { listSessionPrompts } from './query';
import type { UnifiedSessionInfo } from '../sources/types';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-prompts-'));
const dbPath = path.join(tmpDir, 'test.sqlite');
const metaPath = path.join(tmpDir, 'test.meta.json');

function makeSession(
  partial: Partial<UnifiedSessionInfo> & { id: string },
): UnifiedSessionInfo {
  const { id, ...rest } = partial;
  return {
    id,
    project_id: 'proj',
    slug: partial.id,
    directory: '/tmp',
    title: partial.title || 'Untitled',
    version: '1',
    time_created: 1_700_000_000_000,
    time_updated: 1_700_000_100_000,
    source: partial.source || 'kimi',
    total_tokens: partial.total_tokens ?? 10,
    last_active_at_iso: partial.last_active_at_iso ?? '2024-01-15T00:00:00.000Z',
    userParts: partial.userParts ?? [],
    parent_id: partial.parent_id,
    ...rest,
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

describe('listSessionPrompts', () => {
  test('显式 ids: 按传入顺序返回, 含 title / 全量 prompts', () => {
    upsertSession(
      makeSession({
        id: 'p-batch-a',
        title: '批量 A',
        userParts: [
          { text: 'A 第一条 prompt', startTime: 1_700_000_000_000 },
          { text: 'A 第二条 prompt', startTime: 1_700_000_001_000 },
        ],
      }),
    );
    upsertSession(
      makeSession({
        id: 'p-batch-b',
        title: '批量 B',
        source: 'opencode',
        userParts: [{ text: 'B 唯一 prompt', startTime: 1_700_000_000_000 }],
      }),
    );

    const { sessions, skipped } = listSessionPrompts({
      ids: [
        { source: 'opencode', id: 'p-batch-b' },
        { source: 'kimi', id: 'p-batch-a' },
      ],
    });
    expect(skipped).toBe(0);
    expect(sessions.map((s) => s.sessionId)).toEqual(['p-batch-b', 'p-batch-a']);
    expect(sessions[1].title).toBe('批量 A');
    expect(sessions[1].count).toBe(2);
    expect(sessions[1].prompts.map((p) => p.text)).toEqual(['A 第一条 prompt', 'A 第二条 prompt']);
    expect(sessions[0].source).toBe('opencode');
  });

  test('显式 ids 无 session 且无 prompts → skipped 计数', () => {
    const { sessions, skipped } = listSessionPrompts({
      ids: [{ source: 'kimi', id: 'p-no-such' }],
    });
    expect(skipped).toBe(1);
    expect(sessions).toEqual([]);
  });

  test('窗口过滤: 按 last_active 窗口取 session, --roots 生效', () => {
    upsertSession(
      makeSession({
        id: 'p-win-in',
        title: '窗口内 root',
        userParts: [{ text: '窗口内 prompt', startTime: 1_700_000_000_000 }],
        parent_id: undefined,
        last_active_at_iso: '2024-01-20T00:00:00.000Z',
      }),
    );
    upsertSession(
      makeSession({
        id: 'p-win-out',
        title: '窗口外',
        userParts: [{ text: '窗口外 prompt', startTime: 1_700_000_000_000 }],
        parent_id: 'p-win-in', // 子 session
        // 活动区间完全落在窗口后 → 排除
        first_active_at_iso: '2024-02-10T00:00:00.000Z',
        last_active_at_iso: '2024-03-01T00:00:00.000Z',
      }),
    );

    const { sessions } = listSessionPrompts({
      source: 'kimi',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
      rootsOnly: true,
    });
    const ids = sessions.map((s) => s.sessionId);
    expect(ids).toContain('p-win-in');
    expect(ids).not.toContain('p-win-out'); // 活动区间在窗口后 → 排除
    const hit = sessions.find((s) => s.sessionId === 'p-win-in');
    expect(hit!.parent_id).toBeNull();
  });

  test('limit / offset 分页', () => {
    const all = listSessionPrompts({ source: 'kimi' }).sessions;
    const paged = listSessionPrompts({ source: 'kimi', limit: 1, offset: 0 });
    expect(paged.sessions.length).toBe(1);
    expect(paged.sessions[0].sessionId).toBe(all[0].sessionId);
  });
});