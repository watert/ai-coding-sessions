/**
 * session-skill-reads 单元测试（临时 DB, 不依赖真实 session 数据）
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initStoreDb, closeStoreDb } from './db';
import { extractSkillReads, querySkillReads, replaceSkillReads, getSkillReads, getSkillReadsBuiltAt } from './session-skill-reads';
import type { UnifiedSessionDetail } from '../sources/types';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-skillreads-'));

function msg(info: any, parts: any[]) {
  return { info, parts };
}

function detailOf(messages: any[]): UnifiedSessionDetail {
  return { messages } as unknown as UnifiedSessionDetail;
}

const fixtureDetail = detailOf([
  msg({ role: 'user', id: 'u1' }, [{ type: 'text', text: '用 skill 干活' }]),
  msg(
    { role: 'assistant', id: 'a1' },
    [
      // zcode 形态: Skill tool {skill, args}
      { type: 'tool', tool: 'Skill', state: { status: 'completed', input: { skill: 'vault-ops', args: '例行检查' } } },
      // opencode 形态: read filePath 命中 SKILL.md
      { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/home/u/docs/.agents/skills/vault-ops/SKILL.md' } } },
      // read 命中 skill 子文件
      { type: 'tool', tool: 'Read', state: { status: 'completed', input: { file_path: '/home/u/docs/.agents/skills/ai-coding-sessions/scripts/append.ts' } } },
      // read 未命中 skills/ 路径 → 忽略
      { type: 'tool', tool: 'Read', state: { status: 'completed', input: { file_path: '/tmp/other.md' } } },
    ],
  ),
  msg({ role: 'user', id: 'u2' }, [{ type: 'text', text: '再来' }]),
  msg(
    { role: 'assistant', id: 'a2' },
    [
      // opencode 形态: skill tool {name}
      { type: 'tool', tool: 'skill', state: { status: 'completed', input: { name: 'content-search' } } },
      // claude 兼容形态: {command: "name args..."}
      { type: 'tool', tool: 'Skill', state: { status: 'error', input: { command: 'token-stats 按天汇总' } } },
      // 非 tool part / 无 input skill tool → 忽略
      { type: 'text', text: 'done' },
      { type: 'tool', tool: 'skill', state: { status: 'completed' } },
    ],
  ),
]);

beforeAll(() => {
  initStoreDb({ dbPath: path.join(tmpDir, 'test.sqlite'), metaPath: path.join(tmpDir, 'test.meta.json') });
});

afterAll(() => {
  closeStoreDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('session-skill-reads', () => {
  test('extractSkillReads: Skill tool 三种 input 形态 + SKILL.md/子文件命中 + 无关路径忽略', () => {
    const rows = extractSkillReads(fixtureDetail.messages);
    expect(rows).toHaveLength(5);

    // turn: 前 5 条在 turn 0, 后 2 条在 turn 1
    expect(rows.slice(0, 3).map((r) => r.turn)).toEqual([0, 0, 0]);
    expect(rows.slice(3).map((r) => r.turn)).toEqual([1, 1]);

    // skill-tool (zcode {skill,args})
    expect(rows[0]).toMatchObject({ kind: 'skill-tool', skill: 'vault-ops', args: '例行检查', tool: 'Skill', status: 'completed' });
    // skill-file: SKILL.md 主文件
    expect(rows[1]).toMatchObject({ kind: 'skill-file', skill: 'vault-ops', file: '/home/u/docs/.agents/skills/vault-ops/SKILL.md' });
    // skill-file: skill 子文件
    expect(rows[2]).toMatchObject({ kind: 'skill-file', skill: 'ai-coding-sessions' });
    // skill-tool (opencode {name})
    expect(rows[3]).toMatchObject({ kind: 'skill-tool', skill: 'content-search' });
    // skill-tool (claude {command}) → skill=首词, args=余下
    expect(rows[4]).toMatchObject({ kind: 'skill-tool', skill: 'token-stats', args: '按天汇总', status: 'error' });
  });

  test('extractSkillReads: 空消息 / 无 skill 数据返回空数组', () => {
    expect(extractSkillReads(null)).toEqual([]);
    expect(extractSkillReads([msg({ role: 'user' }, [{ type: 'text', text: 'hi' }])])).toEqual([]);
  });

  test('物化表 roundtrip: replace → getSkillReads JSON 还原 + built_at 增量判断', () => {
    const rows = extractSkillReads(fixtureDetail.messages);
    expect(replaceSkillReads('zcode', 's-skill', rows, 1_700_000_100_000)).toBe(5);

    const rec = getSkillReads('zcode', 's-skill');
    expect(rec).not.toBeNull();
    expect(rec!.read_count).toBe(5);
    expect(rec!.reads[0]).toMatchObject({ kind: 'skill-tool', skill: 'vault-ops' });

    expect(getSkillReadsBuiltAt('zcode', 's-skill')).toBe(1_700_000_100_000);
    expect(getSkillReadsBuiltAt('zcode', 's-missing')).toBeNull();

    // 二次 replace 覆盖
    replaceSkillReads('zcode', 's-skill', rows.slice(0, 2), 1_700_000_200_000);
    expect(getSkillReads('zcode', 's-skill')!.read_count).toBe(2);
    expect(getSkillReadsBuiltAt('zcode', 's-skill')).toBe(1_700_000_200_000);
  });

  test('querySkillReads: 跨 session 打平 + skill 名等值/模糊过滤 + created_at 排序', () => {
    // 清掉 roundtrip 测试残留, 保证全量计数可控
    replaceSkillReads('zcode', 's-skill', []);
    replaceSkillReads('zcode', 's-a', [
      { idx: 0, kind: 'skill-tool', skill: 'vault-ops', tool: 'Skill', status: 'completed', msg_idx: 1, turn: 0, created_at: 200 },
    ]);
    replaceSkillReads('opencode', 's-b', [
      { idx: 0, kind: 'skill-file', skill: 'vault-ops', tool: 'read', status: 'completed', file: '/x/skills/vault-ops/SKILL.md', msg_idx: 2, turn: 0, created_at: 100 },
      { idx: 1, kind: 'skill-tool', skill: 'token-stats', tool: 'Skill', status: 'completed', msg_idx: 3, turn: 0, created_at: 300 },
    ]);

    expect(querySkillReads()).toHaveLength(3);
    // 等值过滤
    const vault = querySkillReads({ skill: 'vault-ops' });
    expect(vault).toHaveLength(2);
    // created_at 升序
    expect(vault.map((e) => e.created_at)).toEqual([100, 200]);
    // kind 过滤
    expect(querySkillReads({ kind: 'skill-file' })).toHaveLength(1);
    // 前缀模糊
    expect(querySkillReads({ skill: 'token-%' })).toHaveLength(1);
    expect(querySkillReads({ skill: 'token-%' })[0].session_id).toBe('s-b');
  });
});

/**
 * ①A 修复验证：空 events 在「表里无旧行」时不写 built_at，避免增量死循环跳过；
 * 其它情况（有旧行 / events 非空）仍正常写 built_at。
 */
describe('replaceSkillReads 空 events 死循环', () => {
  const SRC = 'zcode';
  const S_EMPTY = 's-empty';
  const S_RICH = 's-rich';
  const T1 = 1_700_000_100_000;
  const T2 = 1_700_000_200_000;
  const T3 = 1_700_000_300_000;

  const richEvents: import('./session-skill-reads').SkillReadEvent[] = [
    { idx: 0, kind: 'skill-tool', skill: 'vault-ops', tool: 'Skill', status: 'completed', msg_idx: 1, turn: 0, created_at: T1 },
  ];

  test('(a) 首次 build 空 events → 表里无行, built_at 不写', () => {
    // 确认前置无残留
    expect(getSkillReadsBuiltAt(SRC, S_EMPTY)).toBeNull();

    replaceSkillReads(SRC, S_EMPTY, [], T1);

    expect(getSkillReads(SRC, S_EMPTY)).toBeNull();
    expect(getSkillReadsBuiltAt(SRC, S_EMPTY)).toBeNull();
  });

  test('(b) 首次 build 非空 events → 表里有行 + built_at', () => {
    expect(getSkillReadsBuiltAt(SRC, S_RICH)).toBeNull();

    replaceSkillReads(SRC, S_RICH, richEvents, T1);

    const rec = getSkillReads(SRC, S_RICH);
    expect(rec).not.toBeNull();
    expect(rec!.read_count).toBe(1);
    expect(rec!.reads).toHaveLength(1);
    expect(getSkillReadsBuiltAt(SRC, S_RICH)).toBe(T1);
  });

  test('(c) 重 build 空 events → 旧行 reads 清空 + built_at 仍刷新', () => {
    // 上一 case 已在 S_RICH 写入 richEvents@T1
    expect(getSkillReadsBuiltAt(SRC, S_RICH)).toBe(T1);

    replaceSkillReads(SRC, S_RICH, [], T2);

    const rec = getSkillReads(SRC, S_RICH);
    expect(rec).not.toBeNull();
    expect(rec!.read_count).toBe(0);
    expect(rec!.reads).toEqual([]);
    expect(getSkillReadsBuiltAt(SRC, S_RICH)).toBe(T2);
  });

  test('(d) 重 build 非空 events → 表里正常更新 reads + built_at', () => {
    // 上一 case S_RICH 现在是 read_count=0, built_at=T2
    expect(getSkillReadsBuiltAt(SRC, S_RICH)).toBe(T2);

    replaceSkillReads(SRC, S_RICH, richEvents, T3);

    const rec = getSkillReads(SRC, S_RICH);
    expect(rec).not.toBeNull();
    expect(rec!.read_count).toBe(1);
    expect(rec!.reads).toHaveLength(1);
    expect(rec!.reads[0]).toMatchObject({ skill: 'vault-ops' });
    expect(getSkillReadsBuiltAt(SRC, S_RICH)).toBe(T3);
  });

  test('(a+c 组合) 多次「首次空」+「重 build 仍空」最终仍然不写 built_at', () => {
    const S = 's-retry-empty';
    expect(getSkillReadsBuiltAt(SRC, S)).toBeNull();

    replaceSkillReads(SRC, S, [], T1);
    expect(getSkillReadsBuiltAt(SRC, S)).toBeNull();

    // 第二次还是空: 依然「无旧行」语义 → 仍不写
    replaceSkillReads(SRC, S, [], T2);
    expect(getSkillReadsBuiltAt(SRC, S)).toBeNull();

    // 第三次非空: 走正常 INSERT
    replaceSkillReads(SRC, S, richEvents, T3);
    expect(getSkillReadsBuiltAt(SRC, S)).toBe(T3);
    expect(getSkillReads(SRC, S)!.read_count).toBe(1);

    // 第四次重 build 空: 「有旧行」→ 清空 reads + 刷新 built_at
    replaceSkillReads(SRC, S, [], T3 + 1000);
    expect(getSkillReadsBuiltAt(SRC, S)).toBe(T3 + 1000);
    expect(getSkillReads(SRC, S)!.read_count).toBe(0);
  });
});
