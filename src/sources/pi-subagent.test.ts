/**
 * pi-subagents sidecar 子会话：发现 / parent_id / spawn_group / 忽略 artifacts
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { listPiCodeSessions, listPiSessionRefs, getPiSession } from './pi-code';
import { convertPiSession, getPiSessionDetail } from './pi-source';
import { writeJsonl, mkFixtureDir } from './__fixtures__/tmp';

const T0 = Date.UTC(2026, 8, 12, 3, 1, 50);

async function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function writePiSession(
  filePath: string,
  opts: { id: string; cwd: string; ts: number; userText: string; tokens?: number },
) {
  const tokens = opts.tokens ?? 40;
  writeJsonl(filePath, [
    { type: 'session', version: 3, id: opts.id, timestamp: new Date(opts.ts).toISOString(), cwd: opts.cwd },
    {
      type: 'message',
      id: `${opts.id}-u1`,
      parentId: null,
      timestamp: new Date(opts.ts + 10).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: opts.userText }] },
    },
    {
      type: 'message',
      id: `${opts.id}-a1`,
      parentId: `${opts.id}-u1`,
      timestamp: new Date(opts.ts + 200).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        provider: 'opencode-go',
        model: 'kimi-k2.6',
        usage: {
          input: tokens, output: 8, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: tokens + 8,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 },
        },
        stopReason: 'stop',
      },
    },
  ]);
}

function makeTree() {
  const tmp = mkFixtureDir('acs-pi-sub-');
  const root = path.join(tmp, 'sessions');
  const cwdSlug = '--tmp-pi-sub--';
  const cwd = '/tmp/p';
  const parentId = '01a0938c-parent-0001';
  const stem = `2026-09-12T02-57-43-611Z_${parentId}`;
  const proj = path.join(root, cwdSlug);
  const parentFile = path.join(proj, `${stem}.jsonl`);
  writePiSession(parentFile, { id: parentId, cwd, ts: T0, userText: '请并行侦察 plugins 与 deps' });

  const childA = '01a09390-child-aaaa';
  const childB = '01a09390-child-bbbb';
  const childLate = '01a09390-child-late';
  const grand = '01a09391-grand-cccc';
  writePiSession(
    path.join(proj, stem, '14adc0b3-run-a', 'run-0', 'session.jsonl'),
    { id: childA, cwd: '/tmp/map', ts: T0 + 1000, userText: 'Task: 调查 plugins', tokens: 100 },
  );
  writePiSession(
    path.join(proj, stem, '69646639-run-b', 'run-0', 'session.jsonl'),
    { id: childB, cwd: '/tmp/map', ts: T0 + 1200, userText: 'Task: 调查 deps', tokens: 80 },
  );
  // 2 分钟后另一轮，应拆成新 spawn_group
  writePiSession(
    path.join(proj, stem, 'aaaaaaaa-run-late', 'run-0', 'session.jsonl'),
    { id: childLate, cwd: '/tmp/map', ts: T0 + 120_000, userText: 'Task: follow-up', tokens: 20 },
  );
  // 嵌套孙会话：挂在 childA sidecar
  writePiSession(
    path.join(proj, stem, '14adc0b3-run-a', 'run-0', 'session', 'nested-run', 'run-0', 'session.jsonl'),
    { id: grand, cwd: '/tmp/map', ts: T0 + 1500, userText: 'Task: nested scout', tokens: 30 },
  );
  // artifacts：即便带 session header 也不能进 list
  writePiSession(
    path.join(proj, 'subagent-artifacts', '14adc0b3-run-a_scout_transcript.jsonl'),
    { id: 'should-not-list', cwd, ts: T0, userText: 'artifact noise' },
  );
  return { root, parentId, childA, childB, childLate, grand };
}

describe('pi-subagents sidecar children', () => {
  test('discovers nested session.jsonl with parent_id; skips artifacts', async () => {
    const fx = makeTree();
    await withEnv({ PI_SESSIONS_DIR: fx.root }, async () => {
      const list = await listPiCodeSessions();
      const ids = list.map((s) => s.sessionId).sort();
      expect(ids).toEqual([fx.childA, fx.childB, fx.childLate, fx.grand, fx.parentId].sort());
      expect(list.find((s) => s.sessionId === 'should-not-list')).toBeUndefined();

      const parent = list.find((s) => s.sessionId === fx.parentId)!;
      expect(parent.parentId).toBeUndefined();

      const a = list.find((s) => s.sessionId === fx.childA)!;
      const b = list.find((s) => s.sessionId === fx.childB)!;
      const late = list.find((s) => s.sessionId === fx.childLate)!;
      const grand = list.find((s) => s.sessionId === fx.grand)!;
      expect(a.parentId).toBe(fx.parentId);
      expect(b.parentId).toBe(fx.parentId);
      expect(late.parentId).toBe(fx.parentId);
      expect(grand.parentId).toBe(fx.childA);

      // 并发簇：A/B 同组，late 另一组；孙挂 childA
      expect(a.spawnGroupId).toBe(b.spawnGroupId);
      expect(a.spawnGroupId).toBe(`${fx.parentId}:${a.createdAt}`);
      expect(late.spawnGroupId).not.toBe(a.spawnGroupId);
      expect(grand.spawnGroupId).toBe(`${fx.childA}:${grand.createdAt}`);

      const refs = await listPiSessionRefs();
      expect(refs).toHaveLength(5);
      expect(refs.find((s) => s.sessionId === fx.childA)?.firstUserText).toContain('plugins');
    });
  });

  test('convert + detail 带 parent_id / spawn_group_id 且计入子 session tokens', async () => {
    const fx = makeTree();
    await withEnv({ PI_SESSIONS_DIR: fx.root }, async () => {
      const item = await getPiSession(fx.childA);
      expect(item?.parentId).toBe(fx.parentId);
      const info = await convertPiSession(item!);
      expect(info.parent_id).toBe(fx.parentId);
      expect(info.spawn_group_id).toBe(item!.spawnGroupId);
      expect(info.source).toBe('pi');
      expect(info.total_input).toBe(100);
      expect(info.title).toContain('plugins');
      const infoB = await convertPiSession((await getPiSession(fx.childB))!);
      expect(infoB.title).toContain('deps');
      expect(info.title).not.toBe(infoB.title);

      const detail = await getPiSessionDetail(fx.childA);
      expect(detail).not.toBeNull();
      expect(detail!.info.parent_id).toBe(fx.parentId);
      expect(detail!.messages.some((m) => m.info.role === 'user')).toBe(true);

      const grand = await getPiSessionDetail(fx.grand);
      expect(grand!.info.parent_id).toBe(fx.childA);
    });
  });
});
