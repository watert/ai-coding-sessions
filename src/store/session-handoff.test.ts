import { describe, expect, test } from 'bun:test';
import { buildHandoff, formatHandoffMarkdown } from './session-handoff';
import {
  filterSessionsByCwd,
  matchesCwd,
  normalizeCwd,
  resolveSessionRef,
  sessionIdFromPath,
} from './session-resolve';
import type { UnifiedSessionInfo } from '../sources/types';

function sess(partial: Partial<UnifiedSessionInfo> & { id: string }): UnifiedSessionInfo {
  return {
    project_id: partial.project_id || '',
    slug: partial.slug || partial.id,
    directory: partial.directory || '',
    title: partial.title || '',
    version: 'test',
    time_created: partial.time_created || 1,
    time_updated: partial.time_updated || 2,
    source: (partial as any).source || 'kimi',
    ...partial,
  } as UnifiedSessionInfo;
}

describe('normalizeCwd / matchesCwd', () => {
  test('normalize strips trailing slash and resolves .', () => {
    const n = normalizeCwd('.', '/Users/me/proj');
    expect(n).toBe('/Users/me/proj');
    expect(normalizeCwd('/Users/me/proj/')).toBe('/Users/me/proj');
  });

  test('matches project_name exact and under monorepo', () => {
    const s = sess({
      id: 'a',
      project_name: '/Users/me/code/repo',
      directory: '/Users/me/.kimi/sessions/foo',
    });
    expect(matchesCwd(s, '/Users/me/code/repo')).toBe(true);
    expect(matchesCwd(s, '/Users/me/code')).toBe(true);
    expect(matchesCwd(s, '/Users/me/other')).toBe(false);
    // directory-only internal path should not prefix-match by default
    expect(matchesCwd(s, '/Users/me/.kimi')).toBe(false);
  });

  test('filterSessionsByCwd', () => {
    const list = [
      sess({ id: '1', project_name: '/a/repo' }),
      sess({ id: '2', project_name: '/b/repo' }),
      sess({ id: '3', project_name: '/a/repo/pkg' }),
    ];
    const hit = filterSessionsByCwd(list, '/a/repo');
    expect(hit.map((s) => s.id).sort()).toEqual(['1', '3']);
  });
});

describe('resolveSessionRef', () => {
  const id1 = '11111111-1111-1111-1111-111111111111';
  const id2 = '22222222-2222-2222-2222-222222222222';
  const sessions = [
    sess({
      id: id1,
      title: 'Fix auth flow',
      source: 'claude' as any,
      last_active_at_iso: '2026-08-03T12:00:00.000Z',
      parent_id: null,
    }),
    sess({
      id: id2,
      title: 'Fix auth tests',
      source: 'claude' as any,
      last_active_at_iso: '2026-08-03T11:00:00.000Z',
      parent_id: null,
    }),
    sess({
      id: `${id1}__agent`,
      title: 'sub',
      source: 'claude' as any,
      last_active_at_iso: '2026-08-03T12:30:00.000Z',
      parent_id: id1,
    }),
  ];

  test('latest prefers roots when preferRoots', () => {
    const r = resolveSessionRef(sessions, 'latest', { preferRoots: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.match).toBe('latest');
      expect(r.session.id).toBe(id1);
    }
  });

  test('exact id', () => {
    const r = resolveSessionRef(sessions, id2);
    expect(r.ok && r.session.id).toBe(id2);
  });

  test('path extracts uuid', () => {
    expect(sessionIdFromPath(`/tmp/${id1}.jsonl`)).toBe(id1);
    const r = resolveSessionRef(sessions, `/home/.claude/projects/x/${id1}.jsonl`);
    expect(r.ok && r.match).toBe('path');
    if (r.ok) expect(r.session.id).toBe(id1);
  });

  test('title unique', () => {
    const r = resolveSessionRef(sessions, 'auth tests');
    expect(r.ok && r.session.id).toBe(id2);
  });

  test('title ambiguous', () => {
    const r = resolveSessionRef(sessions, 'Fix auth');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('ambiguous');
      // 收窄到 ambiguous 分支才能访问 matches（not_found 分支无此字段）
      if (r.error === 'ambiguous') expect(r.matches.length).toBe(2);
    }
  });

  test('not found', () => {
    const r = resolveSessionRef(sessions, 'zzz-nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_found');
  });
});

describe('buildHandoff', () => {
  test('builds inert summary from messages', () => {
    const info = sess({
      id: 's1',
      source: 'grok' as any,
      title: 'Implement handoff',
      project_name: '/repo',
      session_status: 'done',
      models_used: 'grok-4.5',
      last_active_at_iso: '2026-08-03T10:00:00.000Z',
    });
    const messages = [
      {
        info: { id: 'u1', role: 'user', time: { created: 1 } },
        parts: [{ type: 'text', text: 'Add handoff CLI for resume' }],
      },
      {
        info: { id: 'a1', role: 'assistant', parentID: 'u1', time: { created: 2, completed: 3 } },
        parts: [
          { type: 'text', text: 'Working on it' },
          {
            type: 'tool',
            tool: 'Read',
            callID: 'c1',
            state: {
              status: 'completed',
              input: { path: '/repo/src/store/cli.ts' },
              output: 'ok',
            },
          },
        ],
      },
      {
        info: { id: 'u2', role: 'user', time: { created: 4 } },
        parts: [{ type: 'text', text: 'Also add --cwd filter' }],
      },
      {
        info: { id: 'a2', role: 'assistant', parentID: 'u2', time: { created: 5, completed: 6 } },
        parts: [
          {
            type: 'tool',
            tool: 'Edit',
            callID: 'c2',
            state: {
              status: 'error',
              input: { path: '/repo/src/store/query.ts' },
              error: 'permission denied hard fail xyz',
            },
          },
        ],
      },
    ];

    const h = buildHandoff({
      info,
      messages,
      editDiffs: {
        additions: 10,
        deletions: 2,
        filesChanged: 2,
        files: ['src/store/cli.ts', 'src/store/query.ts'],
      },
    });

    expect(h).not.toBeNull();
    expect(h!.inert).toBe(true);
    expect(h!.mode).toBe('handoff');
    expect(h!.id).toBe('s1');
    expect(h!.goal).toContain('handoff CLI');
    expect(h!.last_user_request).toContain('--cwd');
    expect(h!.files_touched).toContain('src/store/cli.ts');
    expect(h!.tools_used.Read).toBe(1);
    expect(h!.tools_used.Edit).toBe(1);
    expect(h!.tool_error_hard).toBeGreaterThanOrEqual(1);
    expect(h!.warnings.some((w) => w.code === 'inert_history')).toBe(true);
    expect(h!.next_action).toBeTruthy();
    expect(h!.stop_point).toContain('status=done');

    const md = formatHandoffMarkdown(h!);
    expect(md).toContain('INERT FOREIGN HISTORY');
    expect(md).toContain('Last user request');
  });

  test('null without info', () => {
    expect(buildHandoff({ messages: [] })).toBeNull();
  });

  test('default caps: assistant 3000, user/goal 500', () => {
    const longAssistant = '结论：'.padEnd(2500, '甲') + '【结尾标记】';
    const longUser = '请评估'.padEnd(600, '乙') + '【用户尾】';
    const h = buildHandoff({
      info: sess({
        id: 's-long',
        source: 'kimi' as any,
        title: 'long conclusion',
        session_status: 'done',
      }),
      messages: [
        {
          info: { id: 'u1', role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: longUser }],
        },
        {
          info: { id: 'a1', role: 'assistant', parentID: 'u1', time: { created: 2, completed: 3 } },
          parts: [{ type: 'text', text: longAssistant }],
        },
      ],
    });
    expect(h!.last_assistant_action).toContain('【结尾标记】');
    expect(h!.last_assistant_action!.endsWith('…')).toBe(false);
    // user/goal 默认 500，长 prompt 应截断
    expect(h!.goal!.length).toBeLessThanOrEqual(501);
    expect(h!.goal!.endsWith('…')).toBe(true);
    expect(h!.last_user_request!.endsWith('…')).toBe(true);
    expect(h!.goal).not.toContain('【用户尾】');
  });

  test('textPreview overrides both user and assistant caps', () => {
    const longUser = '请评估'.padEnd(600, '乙') + '【用户尾】';
    const h = buildHandoff(
      {
        info: sess({
          id: 's-ov',
          source: 'kimi' as any,
          title: 'override',
          session_status: 'done',
        }),
        messages: [
          {
            info: { id: 'u1', role: 'user', time: { created: 1 } },
            parts: [{ type: 'text', text: longUser }],
          },
          {
            info: { id: 'a1', role: 'assistant', parentID: 'u1', time: { created: 2, completed: 3 } },
            parts: [{ type: 'text', text: '短结论' }],
          },
        ],
      },
      { textPreview: 800 },
    );
    expect(h!.goal).toContain('【用户尾】');
    expect(h!.goal!.endsWith('…')).toBe(false);
  });
});
