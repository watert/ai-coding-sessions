/**
 * Bash 失败深掘：cmdFamily / exitCode / category / build breakdown
 *
 * 与 host `server-hono/src/services/tool-error-stats.ts` 语义对齐，但本文件按 T2 计划
 * 独立重写（不 paste）。`extractBashExitCode` 在包内返回 `number | undefined`（host 为 `string`）。
 */

import type { FailureEvent } from './failure-stats';

export type BashCategory = 'test-run' | 'git' | 'gh' | 'build' | 'other';

export interface BashBreakdownRow {
  cmdFamily: string;
  exitCode?: number;
  category: BashCategory;
  /** 归一后的首个命中 command（用于 byCommand 替代展示；过长会截断） */
  command: string;
  samples: number;
}

// ==================== extractBashCmdFamily ====================

/** 跳过前缀集合（按 host 语义，但写得更紧凑） */
const SKIP_PREFIX = new Set(['cd', 'export', 'true', ':', 'echo', 'sleep']);
const PACKAGE_RUNNERS = ['bunx', 'npx', 'pnpm', 'yarn', 'npm'];
const BUN_SUB_WITH_THIRD = new Set(['test', 'x', 'install', 'add']);

/**
 * 提取主命令族（跳过 cd/export/true/echo/sleep 前缀与 env 赋值）。
 * 输入为空 / 无可用 token → `'(empty)'`。
 */
export function extractBashCmdFamily(command: string): string {
  let cmd = (command || '').trim();
  if (!cmd) return '(empty)';

  // heredoc / 换行截断
  cmd = cmd.split('\n', 1)[0].trim();
  if (!cmd) return '(empty)';

  // 按 && / ; / || 拆段，找首个非 SKIP_PREFIX 的有效段
  const segments = cmd.split(/\s*(?:&&|;|\|\|)\s*/);
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    // 跳过 env 赋值 FOO=bar
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i])) i++;
    // 去掉前导 `(`，兼容 `(cd /tmp && bun test foo)` 这类 subshell 写法
    const bin = ((tokens[i] || '').replace(/^["']|["']$/g, '')).replace(/^\(/, '');
    if (!bin) continue;
    // SKIP_PREFIX：仅在多段拼接时跳过（单段允许保留为 family）
    if (SKIP_PREFIX.has(bin) && segments.length > 1) continue;
    // 包运行器 → bunx/npx <sub>
    if (PACKAGE_RUNNERS.includes(bin)) {
      const sub = tokens[i + 1];
      return sub ? `${bin} ${sub}` : bin;
    }
    // bun <sub>：test/x/install/add 取子命令；run 取第三段
    if (bin === 'bun') {
      const sub = tokens[i + 1];
      if (!sub) return 'bun';
      if (sub === 'run') return tokens[i + 2] ? `bun run ${tokens[i + 2]}` : 'bun run';
      if (BUN_SUB_WITH_THIRD.has(sub)) return `bun ${sub}`;
      return `bun ${sub}`;
    }
    if (bin === 'git' && tokens[i + 1]) return `git ${tokens[i + 1]}`;
    if (bin === 'gh' && tokens[i + 1]) return `gh ${tokens[i + 1]}`;
    return bin;
  }
  return '(empty)';
}

// ==================== extractBashExitCode ====================

/**
 * 从错误文本中提取 exit code。
 * 兼容 `exit code 1` / `exited with code 2` / `Process exited with code 3`。
 * 找不到 → `undefined`。
 */
export function extractBashExitCode(text: string): number | undefined {
  if (!text) return undefined;
  const m =
    text.match(/exit code[:\s]+(\d+)/i)
    || text.match(/exited with code[:\s]+(\d+)/i)
    || text.match(/Process exited with code[:\s]+(\d+)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

// ==================== classifyBashCategory ====================

/**
 * 按 cmdFamily 归类。注意 family 是空格分隔的两词形式（如 'bun test' / 'git push'）。
 * 命中优先级：test-run > git > gh > build > other。
 */
export function classifyBashCategory(family: string): BashCategory {
  const f = (family || '').toLowerCase();
  if (!f || f === '(empty)') return 'other';
  // test-run：family 直接是测试运行器名，或包含 test/spec 子命令
  if (/^(?:vitest|jest|pytest|mocha|vitest-runner)$/.test(f)) return 'test-run';
  if (/(?:^|\s)(?:test|spec)(?:\s|$)/.test(f) || /\bbun test\b/.test(f)) return 'test-run';
  if (f.startsWith('git ') || f === 'git') return 'git';
  if (f.startsWith('gh ') || f === 'gh') return 'gh';
  if (/\b(?:build|tsc|lint|check)\b/.test(f)) return 'build';
  return 'other';
}

// ==================== buildBashBreakdown ====================

interface BucketKey {
  cmdFamily: string;
  exitCode: number | undefined;
}

/** 归一 command 展示用：去多空白 → 截断 160 → 空 → '(empty)' */
export function normCommand(command: string): string {
  const c = (command || '').replace(/\s+/g, ' ').trim();
  return c ? c.slice(0, 160) : '(empty)';
}

/**
 * 按 (cmdFamily, exitCode) 分桶汇总。**输入已经过滤过 `kind==='tool' && toolName==='bash'`**，
 * 本函数不再二次过滤，避免重复劳动。
 * 空 command（normalize 后仍为 ''）的事件会被丢弃，不入桶。
 */
export function buildBashBreakdown(events: FailureEvent[], top: number = 20): BashBreakdownRow[] {
  if (!Array.isArray(events) || events.length === 0) return [];

  const buckets = new Map<string, {
    key: BucketKey;
    category: BashCategory;
    command: string;
    samples: number;
  }>();

  for (const ev of events) {
    if (!ev) continue;
    // 从 errorRaw / error 抽取 exit code（兼容两种来源）
    const errText = String(ev.errorRaw || ev.error || '');
    const exitCode = extractBashExitCode(errText);
    // command：toolName=bash 时 BashEvent 应已携带，但本文件没有 BashEvent 形态；
    // 这里走 errorRaw/error 看是否能反向提取 family。不携带 command 的事件 → 跳过。
    // 兼容：input command 可能在 ev 里（host ToolErrorEvent 走 ev.bash.command）。
    const evAny = ev as FailureEvent & {
      command?: string;
      bash?: { command?: string; cmdFamily?: string; exitCode?: string };
    };
    const command = evAny.command ?? evAny.bash?.command ?? '';
    const family = evAny.bash?.cmdFamily ?? extractBashCmdFamily(command);
    if (!command.trim() && !evAny.bash?.cmdFamily) continue;

    const key: BucketKey = { cmdFamily: family, exitCode };
    const k = `${family}::${exitCode ?? ''}`;
    const existed = buckets.get(k);
    if (existed) {
      existed.samples += 1;
      continue;
    }
    buckets.set(k, {
      key,
      category: classifyBashCategory(family),
      command: normCommand(command),
      samples: 1,
    });
  }

  const rows: BashBreakdownRow[] = Array.from(buckets.values()).map((b) => ({
    cmdFamily: b.key.cmdFamily,
    exitCode: b.key.exitCode,
    category: b.category,
    command: b.command,
    samples: b.samples,
  }));

  rows.sort((a, b) => b.samples - a.samples);
  return top > 0 ? rows.slice(0, top) : rows;
}
