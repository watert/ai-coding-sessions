/**
 * title-review: 标题审查候选 = 当前标题 + prompt count + truncated prompts
 * 非弱标题同样列为候选,交 Agent 依据 prompts 判断是否需重写
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initStoreDb, closeStoreDb } from './db';
import { upsertSession } from './upsert';
import { listTitleReview } from './query';
import { setSessionTitle } from './session-title';
import type { UnifiedSessionInfo } from '../sources/types';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-review-'));
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
    last_active_at_iso: new Date(1_700_000_100_000).toISOString(),
    userParts: partial.userParts ?? [],
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

describe('listTitleReview', () => {
  test('弱标题 + prompts 列为候选, is_weak=true, preview 截断', () => {
    upsertSession(
      makeSession({
        id: 'rev-weak',
        title: 'Untitled',
        userParts: [
          { text: '帮我评审一下这个 monkey script: monkey-scripts/zhihu.js', startTime: 1_700_000_000_000 },
          { text: '结论整理到 ~/docs/posts', startTime: 1_700_000_001_000 },
        ],
      }),
    );
    const { sessions } = listTitleReview({ source: 'kimi' });
    const hit = sessions.find((s) => s.id === 'rev-weak');
    expect(hit).toBeTruthy();
    expect(hit!.is_weak).toBe(true);
    expect(hit!.prompt_count).toBe(2);
    expect(hit!.prompts_preview.length).toBe(2);
    expect(hit!.prompts_preview[0]).toContain('monkey script');
  });

  test('非弱标题同样列为候选(交 Agent 判断), is_weak=false', () => {
    upsertSession(
      makeSession({
        id: 'rev-real',
        title: '知乎爬虫评审',
        userParts: [{ text: '看看知乎爬虫', startTime: 1_700_000_000_000 }],
      }),
    );
    const { sessions } = listTitleReview({ source: 'kimi' });
    const hit = sessions.find((s) => s.id === 'rev-real');
    expect(hit).toBeTruthy();
    expect(hit!.is_weak).toBe(false);
    expect(hit!.title).toBe('知乎爬虫评审');
  });

  test('已有 custom_title 不列为候选', () => {
    upsertSession(makeSession({ id: 'rev-custom', title: 'Untitled' }));
    setSessionTitle('kimi', 'rev-custom', '已处理标题');
    const { sessions } = listTitleReview({ source: 'kimi' });
    expect(sessions.some((s) => s.id === 'rev-custom')).toBe(false);
  });

  test('无 prompts 默认跳过; --include-empty 可列出', () => {
    upsertSession(makeSession({ id: 'rev-empty', title: 'Untitled', userParts: [] }));
    expect(listTitleReview({ source: 'kimi' }).sessions.some((s) => s.id === 'rev-empty')).toBe(false);
    const { sessions } = listTitleReview({ source: 'kimi', includeEmpty: true });
    const hit = sessions.find((s) => s.id === 'rev-empty');
    expect(hit).toBeTruthy();
    expect(hit!.prompt_count).toBe(0);
    expect(hit!.prompts_preview).toEqual([]);
  });

  test('promptPreviewCount / promptPreviewChars 控制预览量', () => {
    upsertSession(
      makeSession({
        id: 'rev-preview',
        title: 'Untitled',
        userParts: [
          { text: '第一条 prompt 内容一', startTime: 1_700_000_000_000 },
          { text: '第二条 prompt 内容二', startTime: 1_700_000_001_000 },
        ],
      }),
    );
    const one = listTitleReview({ source: 'kimi', promptPreviewCount: 1 }).sessions.find(
      (s) => s.id === 'rev-preview',
    );
    expect(one!.prompts_preview.length).toBe(1);
    const short = listTitleReview({ source: 'kimi', promptPreviewChars: 6 }).sessions.find(
      (s) => s.id === 'rev-preview',
    );
    expect(short!.prompts_preview[0].length).toBeLessThanOrEqual(7);
  });
});
