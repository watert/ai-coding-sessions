/**
 * T2: bash-breakdown 单元测试
 * 覆盖：cmdFamily 归一 / exit code 提取 / category 分类 / breakdown 聚合
 */
import { describe, it, expect } from 'bun:test';
import {
  extractBashCmdFamily,
  extractBashExitCode,
  classifyBashCategory,
  buildBashBreakdown,
  type BashBreakdownRow,
} from './bash-breakdown';
import type { FailureEvent } from './failure-stats';

describe('extractBashCmdFamily', () => {
  it('跳过 (cd /tmp && bun test foo) 的 cd 前缀', () => {
    expect(extractBashCmdFamily('(cd /tmp && bun test foo)')).toBe('bun test');
  });

  it('git push origin main → git push', () => {
    expect(extractBashCmdFamily('git push origin main')).toBe('git push');
  });

  it('gh pr create → gh pr', () => {
    expect(extractBashCmdFamily('gh pr create --fill')).toBe('gh pr');
  });

  it('空字符串 → (empty)，不 throw', () => {
    expect(extractBashCmdFamily('')).toBe('(empty)');
    expect(extractBashCmdFamily('   ')).toBe('(empty)');
  });

  it('null / undefined → (empty)', () => {
    // @ts-expect-error 测试 null 容忍
    expect(extractBashCmdFamily(null)).toBe('(empty)');
    expect(extractBashCmdFamily(undefined as unknown as string)).toBe('(empty)');
  });

  it('bun run lint / bun run build / bun test foo', () => {
    expect(extractBashCmdFamily('bun run lint')).toBe('bun run lint');
    expect(extractBashCmdFamily('bun run build')).toBe('bun run build');
    expect(extractBashCmdFamily('bun test foo')).toBe('bun test');
    expect(extractBashCmdFamily('bun install')).toBe('bun install');
    expect(extractBashCmdFamily('bun add foo')).toBe('bun add');
  });

  it('bunx tsc / npx eslint / pnpm dev', () => {
    expect(extractBashCmdFamily('bunx tsc --noEmit')).toBe('bunx tsc');
    expect(extractBashCmdFamily('npx eslint src')).toBe('npx eslint');
    expect(extractBashCmdFamily('pnpm dev')).toBe('pnpm dev');
  });

  it('sleep 5 && git status → git status', () => {
    expect(extractBashCmdFamily('sleep 5 && git status')).toBe('git status');
  });

  it('FOO=bar bun test → bun test', () => {
    expect(extractBashCmdFamily('FOO=bar bun test')).toBe('bun test');
  });

  it('复合 && 段首为 echo 时跳过', () => {
    expect(extractBashCmdFamily('echo hi && gh issue list')).toBe('gh issue');
  });
});

describe('extractBashExitCode', () => {
  it('从 exit code 1 提取 1', () => {
    expect(extractBashExitCode('exit code 1')).toBe(1);
    expect(extractBashExitCode('Process exited with code 2')).toBe(2);
    expect(extractBashExitCode('exited with code 0')).toBe(0);
  });

  it('找不到 → undefined', () => {
    expect(extractBashExitCode('')).toBeUndefined();
    expect(extractBashExitCode('no number here')).toBeUndefined();
    expect(extractBashExitCode('error TS2304: cannot find name')).toBeUndefined();
  });

  it('大写 / 标点变体', () => {
    expect(extractBashExitCode('Exit Code: 137')).toBe(137);
  });
});

describe('classifyBashCategory', () => {
  it('test-run 命中', () => {
    expect(classifyBashCategory('bun test')).toBe('test-run');
    expect(classifyBashCategory('vitest')).toBe('test-run');
    expect(classifyBashCategory('bun test foo')).toBe('test-run');
  });

  it('git / gh 命中', () => {
    expect(classifyBashCategory('git push')).toBe('git');
    expect(classifyBashCategory('git status')).toBe('git');
    expect(classifyBashCategory('gh pr')).toBe('gh');
    expect(classifyBashCategory('gh issue')).toBe('gh');
  });

  it('build 命中（含 tsc / lint / check）', () => {
    expect(classifyBashCategory('bun run lint')).toBe('build');
    expect(classifyBashCategory('bunx tsc')).toBe('build');
    expect(classifyBashCategory('npm run build')).toBe('build');
    expect(classifyBashCategory('cargo check')).toBe('build');
  });

  it('其余 → other', () => {
    expect(classifyBashCategory('ls')).toBe('other');
    expect(classifyBashCategory('curl')).toBe('other');
    expect(classifyBashCategory('(empty)')).toBe('other');
  });
});

describe('buildBashBreakdown', () => {
  function bashEvent(command: string, exitCode?: number, errorText?: string): FailureEvent {
    return {
      source: 'opencode',
      sessionId: 's',
      ts: 0,
      kind: 'tool',
      toolName: 'bash',
      error: errorText || (exitCode != null ? `exit code ${exitCode}` : 'failed'),
      errorRaw: errorText || (exitCode != null ? `exit code ${exitCode}` : 'failed'),
      command,
    } as FailureEvent & { command: string };
  }

  it('3 个相同 cmdFamily 事件 → 1 行 samples=3', () => {
    const rows = buildBashBreakdown([
      bashEvent('bun test foo', 1),
      bashEvent('bun test bar', 1),
      bashEvent('bun test baz', 1),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].cmdFamily).toBe('bun test');
    expect(rows[0].exitCode).toBe(1);
    expect(rows[0].samples).toBe(3);
    expect(rows[0].category).toBe('test-run');
  });

  it('不同 cmdFamily → 多行，按 samples 降序', () => {
    const rows = buildBashBreakdown([
      bashEvent('bun test a', 1),
      bashEvent('git push', 128),
      bashEvent('git push', 128),
      bashEvent('gh pr', 1),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0].cmdFamily).toBe('git push');
    expect(rows[0].samples).toBe(2);
    expect(rows[1].samples).toBe(1);
  });

  it('同 family 不同 exitCode 分桶', () => {
    const rows = buildBashBreakdown([
      bashEvent('bun test a', 1),
      bashEvent('bun test b', 2),
    ]);
    expect(rows).toHaveLength(2);
    const codes = rows.map((r) => r.exitCode).sort();
    expect(codes).toEqual([1, 2]);
  });

  it('top 截断', () => {
    const rows = buildBashBreakdown(
      [
        bashEvent('bun test a', 1),
        bashEvent('git push', 1),
        bashEvent('gh pr', 1),
        bashEvent('ls', 1),
      ],
      2,
    );
    expect(rows).toHaveLength(2);
  });

  it('null 输入 → 空数组，不 throw', () => {
    // @ts-expect-error null 输入
    expect(buildBashBreakdown(null)).toEqual([]);
  });

  it('缺失 command 且无 cmdFamily 兜底 → 跳过', () => {
    const rows = buildBashBreakdown([
      { source: 'opencode', sessionId: 's', ts: 0, kind: 'tool', toolName: 'bash', error: 'x', errorRaw: 'x' } as FailureEvent,
    ]);
    expect(rows).toEqual([]);
  });

  it('通过 ev.bash.cmdFamily 兜底（无 raw command）', () => {
    const ev = {
      source: 'opencode',
      sessionId: 's',
      ts: 0,
      kind: 'tool',
      toolName: 'bash',
      error: 'exit code 1',
      errorRaw: 'exit code 1',
      bash: { cmdFamily: 'git push', exitCode: '1', command: 'git push origin main' },
    } as unknown as FailureEvent;
    const rows = buildBashBreakdown([ev]);
    expect(rows).toHaveLength(1);
    expect(rows[0].cmdFamily).toBe('git push');
    expect(rows[0].category).toBe('git');
  });
});
