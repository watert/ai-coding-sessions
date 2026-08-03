/**
 * Grok compact：compaction_requests 合成消息 + compact_count / time_compacting
 */
import { describe, it, expect, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  listGrokCodeMessages,
  getGrokCompactionMeta,
  deriveGrokCompactionStats,
  isGrokCompactionText,
} from './grok-code';
import { getGrokSessionDetail } from './grok-source';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-compact-'));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeCompactSession(name: string, opts: {
  preChat: unknown[];
  postChat: unknown[];
  request: Record<string, unknown>;
  signals?: Record<string, unknown>;
}): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, 'compaction_requests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    info: { id: name },
    current_model_id: 'grok-4.5',
    created_at: '2026-08-03T07:00:00.000Z',
    last_active_at: '2026-08-03T09:00:00.000Z',
    updated_at: '2026-08-03T09:00:00.000Z',
  }));
  // chat_history：compact 后 = continuation + post
  const cont = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.';
  fs.writeFileSync(
    path.join(dir, 'chat_history.jsonl'),
    [
      { type: 'user', content: cont },
      ...opts.postChat,
    ].map((x) => JSON.stringify(x)).join('\n') + '\n',
  );
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), '');
  const req = {
    schema_version: 2,
    request_id: 'req-1',
    created_at: '2026-08-03T08:03:08.663Z',
    trigger: 'manual',
    model: 'grok-4.5',
    summary: 'Did stuff before compact.',
    error: null,
    chat_history: opts.preChat,
    ...opts.request,
  };
  fs.writeFileSync(
    path.join(dir, 'compaction_requests/req-1.json'),
    JSON.stringify(req),
  );
  if (opts.signals) {
    fs.writeFileSync(path.join(dir, 'signals.json'), JSON.stringify(opts.signals));
  }
  return dir;
}

describe('getGrokCompactionMeta', () => {
  it('reads compaction_requests + signals', () => {
    const dir = writeCompactSession('meta-1', {
      preChat: [
        { type: 'user', content: '<user_query>q1</user_query>' },
        { type: 'assistant', content: 'a1', model_id: 'grok-4.5', tool_calls: [] },
      ],
      postChat: [
        { type: 'user', content: '<user_query>q2</user_query>' },
        { type: 'assistant', content: 'a2', model_id: 'grok-4.5', tool_calls: [] },
      ],
      request: {},
      signals: { compactionCount: 1, totalTokensBeforeCompaction: 164697 },
    });
    const meta = getGrokCompactionMeta(dir);
    expect(meta.compact_count).toBe(1);
    expect(meta.tokensBefore).toBe(164697);
    expect(meta.time_compacting).toBe(Date.parse('2026-08-03T08:03:08.663Z'));
    expect(meta.records[0].trigger).toBe('manual');
    expect(meta.records[0].summary).toContain('Did stuff');
  });
});

describe('listGrokCodeMessages compact inject', () => {
  it('merges pre-history and inserts [Context Compacted] assistant', async () => {
    const dir = writeCompactSession('inject-1', {
      preChat: [
        { type: 'system', content: 'You are Grok' },
        { type: 'user', content: '<user_query>first</user_query>' },
        { type: 'assistant', content: 'before compact', model_id: 'grok-4.5', tool_calls: [] },
        {
          type: 'user',
          content: 'Your task is to produce a faithful, concise summary of the conversation.',
        },
      ],
      postChat: [
        { type: 'user', content: '<user_query>after</user_query>' },
        { type: 'assistant', content: 'after compact', model_id: 'grok-4.5', tool_calls: [] },
      ],
      request: {},
      signals: { compactionCount: 1, totalTokensBeforeCompaction: 100000 },
    });

    const msgs = await listGrokCodeMessages({ sessionId: 'inject-1', sessionDir: dir });
    const compact = msgs.filter((m) => m.compaction || isGrokCompactionText(m.text));
    expect(compact.length).toBe(1);
    expect(compact[0].role).toBe('assistant');
    expect(compact[0].text).toContain('[Context Compacted] 手动压缩');
    expect(compact[0].text).toContain('100,000');
    expect(compact[0].text).toContain('Did stuff before compact');
    expect(compact[0].realUsage).toEqual({ input: 0, output: 0, cached: 0, reasoning: 0 });

    // continuation 被 merge 剥离；pre + compact + post
    const users = msgs.filter((m) => m.role === 'user');
    expect(users.map((u) => u.text)).toEqual([
      '<user_query>first</user_query>',
      '<user_query>after</user_query>',
    ]);
    expect(msgs.some((m) => /This session is being continued/i.test(m.text))).toBe(false);

    // 顺序：before → compact → after
    const texts = msgs.filter((m) => m.role === 'assistant').map((m) => m.text.slice(0, 40));
    expect(texts[0]).toContain('before compact');
    expect(texts[1]).toContain('[Context Compacted]');
    expect(texts[2]).toContain('after compact');

    // parent 挂 pre 最后 user
    expect(compact[0].parentID).toBe(users[0].uuid);

    const stats = deriveGrokCompactionStats(msgs, dir);
    expect(stats.compact_count).toBe(1);
    expect(stats.time_compacting).toBeTruthy();
  });
});

describe('live grok compact session', () => {
  const LIVE = '019fc67e-bf68-7862-b40e-d5c0ca43c46e';

  it('真实 session 有 compact 消息与 meta', async () => {
    const detail = await getGrokSessionDetail(LIVE);
    if (!detail) {
      console.log('live compact session 不存在，跳过');
      return;
    }
    expect(detail.info.compact_count).toBeGreaterThanOrEqual(1);
    expect(detail.info.time_compacting).toBeTruthy();
    const compactMsgs = detail.messages.filter((m) => m.info.compaction);
    expect(compactMsgs.length).toBeGreaterThanOrEqual(1);
    const text = (compactMsgs[0].parts || [])
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n');
    expect(text).toContain('[Context Compacted]');
  });
});
