import { describe, expect, test } from 'bun:test';
import { buildDigest, formatDigestMarkdown } from './session-digest';
import type { UnifiedSessionInfo } from '../sources/types';

function sess(partial: Partial<UnifiedSessionInfo> & { id: string }): UnifiedSessionInfo {
  return {
    project_id: '',
    slug: partial.id,
    directory: '',
    title: '',
    version: 'test',
    time_created: 1,
    time_updated: 2,
    source: 'kimi',
    ...partial,
  } as UnifiedSessionInfo;
}

/** user + assistant 各一条的最小 detail */
function detailOf(info: UnifiedSessionInfo, userText: string, assistantText: string) {
  return {
    info,
    messages: [
      { info: { id: 'u1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: userText }] },
      {
        info: { id: 'a1', role: 'assistant', parentID: 'u1', time: { created: 2, completed: 3 } },
        parts: [{ type: 'text', text: assistantText }],
      },
    ],
  };
}

describe('session-digest', () => {
  test('聚合 entries 并按 project 分组', async () => {
    const s1 = sess({
      id: 's1',
      title: 'digest 功能实现',
      project_name: '/code/fetch-av-cover',
      session_status: 'done',
      total_tokens: 45210,
      total_input: 30000,
      total_output: 15210,
    });
    const s2 = sess({
      id: 's2',
      title: 'obsidian 整理',
      project_name: '/code/docs',
      session_status: 'done',
      total_tokens: 1200,
    });
    const s3 = sess({
      id: 's3',
      title: 'digest 测试补齐',
      project_name: '/code/fetch-av-cover',
      session_status: 'in-progress',
    });

    const result = await buildDigest([s1, s2, s3], async (s) =>
      detailOf(s, `请完成 ${s.title}`, '已完成，status=done。'),
    );

    expect(result.ok).toBe(true);
    expect(result.digested).toBe(3);
    expect(result.skipped).toEqual([]);
    expect(result.groups.map((g) => g.project_label)).toEqual(['fetch-av-cover', 'docs']);
    expect(result.groups[0].sessions.map((e) => e.id)).toEqual(['s1', 's3']);

    const e1 = result.groups[0].sessions[0];
    expect(e1.title).toBe('digest 功能实现');
    expect(e1.total_tokens).toBe(45210);
    expect(e1.goal).toContain('digest 功能实现');
    expect(e1.turn_count).toBe(1);
  });

  test('skip: detail 缺失 / 空 session / fetch 异常', async () => {
    const s1 = sess({ id: 'gone', title: 'x' });
    const s2 = sess({ id: 'empty', title: 'y' });
    const s3 = sess({ id: 'boom', title: 'z' });

    const result = await buildDigest([s1, s2, s3], async (s) => {
      if (s.id === 'gone') return null;
      if (s.id === 'boom') throw new Error('io');
      return { info: s, messages: [] };
    });

    expect(result.digested).toBe(0);
    expect(result.skipped.map((k) => k.reason)).toEqual(['detail_not_found', 'empty', 'fetch_error']);
  });

  test('md 渲染：header 汇总 + 分组 + goal/stop 行', async () => {
    const s1 = sess({
      id: 's1',
      title: 'digest 功能实现',
      project_name: '/code/fetch-av-cover',
      session_status: 'done',
      total_tokens: 45210,
    });
    const result = await buildDigest(
      [s1],
      async (s) => detailOf(s, '请完成 digest 功能', '已完成，status=done。'),
      { startDate: '2026-08-28', endDate: '2026-08-28' },
    );
    const md = formatDigestMarkdown(result);

    expect(md).toContain('# AI Coding Sessions Digest');
    expect(md).toContain('window 2026-08-28 ~ 2026-08-28');
    expect(md).toContain('digested 1/1');
    expect(md).toContain('kimi×1');
    expect(md).toContain('## fetch-av-cover — `/code/fetch-av-cover`');
    expect(md).toContain('**digest 功能实现** `kimi` · done');
    expect(md).toContain('45.2k tok');
    expect(md).toContain('- goal: 请完成 digest 功能');
    expect(md).toContain('- stop:');
  });

  test('textPreview 覆盖截断 cap', async () => {
    const longGoal = '请评估'.padEnd(600, '乙');
    const s1 = sess({ id: 's1', title: 't', project_name: '/p' });
    const result = await buildDigest([s1], async (s) => detailOf(s, longGoal, 'ok'), {
      textPreview: 100,
    });
    const goal = result.groups[0].sessions[0].goal!;
    expect(goal.length).toBeLessThanOrEqual(101); // 100 + '…'
  });
});
