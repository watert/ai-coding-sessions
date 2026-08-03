/**
 * 多 source editDiffs 表驱动（纯函数，不读本机 session）
 */
import { describe, expect, it } from 'bun:test';
import { calculateEditDiffs } from './opencode';
import { calculateEditDiffsFromGrokMessages } from './grok-source';
import { calculateEditDiffsFromKimiMessages } from './kimi-source';
import { calculateEditDiffsFromCodexMessages } from './codex-source';

function toolMsg(tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    info: { id: 'a', role: 'assistant' },
    parts: [
      {
        type: 'tool',
        tool,
        state: {
          status: 'completed',
          input,
          ...extra,
        },
      },
    ],
  } as any;
}

describe('editDiffs table', () => {
  it('opencode: metadata.filediff + write content', () => {
    const parts = [
      {
        tool: 'edit',
        state: {
          metadata: { filediff: { path: '/a.ts', additions: 3, deletions: 1 } },
          input: { path: '/a.ts' },
        },
      },
      {
        tool: 'write',
        state: {
          input: { filePath: '/b.ts', content: 'a\nb\nc' },
        },
      },
    ] as any;
    const d = calculateEditDiffs(parts);
    expect(d.additions).toBe(3 + 3); // filediff 3 + write 3 lines
    expect(d.deletions).toBe(1);
    expect(d.filesChanged).toBe(2);
    expect(d.files).toContain('/a.ts');
    expect(d.files).toContain('/b.ts');
  });

  it('kimi: edit old/new_string + write content + result fallback', () => {
    const fromArgs = calculateEditDiffsFromKimiMessages([
      toolMsg('edit', {
        path: '/k.ts',
        old_string: 'a\nb\n',
        new_string: 'a\nb2\nc\n',
      }),
      toolMsg('write', { path: '/w.ts', content: '1\n2\n' }),
    ]);
    expect(fromArgs.filesChanged).toBe(2);
    expect(fromArgs.additions).toBeGreaterThan(0);
    expect(fromArgs.files).toContain('/k.ts');

    // input 算不出时从 result "+N / -M" 解析
    const fromResult = calculateEditDiffsFromKimiMessages([
      toolMsg('edit', { path: '/r.ts' }, { output: 'Replaced 1 occurrence +5 / -2' }),
    ]);
    expect(fromResult.additions).toBe(5);
    expect(fromResult.deletions).toBe(2);
  });

  it('codex: write lines + apply_patch result +N/-M', () => {
    const d = calculateEditDiffsFromCodexMessages([
      toolMsg('write', { path: '/c.ts', content: 'x\ny\n' }),
      toolMsg('apply_patch', { path: '/p.ts' }, { output: 'ok +4 / -1' }),
      // exec_command 在白名单但不计 diff 若无 +N/-M
      toolMsg('exec_command', { command: 'ls' }, { output: 'a\nb' }),
    ]);
    expect(d.files).toContain('/c.ts');
    expect(d.files).toContain('/p.ts');
    expect(d.additions).toBeGreaterThanOrEqual(2 + 4); // write lines + patch
    expect(d.deletions).toBe(1);
  });

  it('grok: search_replace / write / str_replace alias / 空 content', () => {
    const d = calculateEditDiffsFromGrokMessages([
      toolMsg('search_replace', {
        file_path: '/g1.ts',
        old_string: 'line1\n',
        new_string: 'line1\nline2\n',
      }),
      toolMsg('str_replace', {
        file_path: '/g2.ts',
        old_string: 'a',
        new_string: 'b',
      }),
      toolMsg('write', { file_path: '/g3.ts', content: 'a\nb\nc\n' }),
      toolMsg('write', { file_path: '/empty.ts', content: '' }),
      toolMsg('read_file', { target_file: '/nope.ts' }), // 忽略
    ]);
    expect(d.filesChanged).toBe(4); // empty still counts path if present
    expect(d.files).toContain('/g1.ts');
    expect(d.files).toContain('/g3.ts');
    expect(d.additions).toBeGreaterThanOrEqual(3);
    // read_file 不计入
    expect(d.files.some((f) => f.includes('nope'))).toBe(false);
  });

  it('grok: 无 path 时 files 可空但仍计行 diff', () => {
    const d = calculateEditDiffsFromGrokMessages([
      toolMsg('write', { content: 'only\n' }),
    ]);
    expect(d.additions).toBe(1);
    expect(d.filesChanged).toBe(0);
  });
});
