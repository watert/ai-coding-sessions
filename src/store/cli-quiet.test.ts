/**
 * CLI 默认静默 sqlite 生命周期 banner, 避免 Agent 把 stderr 拼进 JSON 解析失败
 */
import { describe, expect, test, afterAll } from 'bun:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.ts');

describe('cli sqlite quiet default', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-cli-quiet-'));
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runCli(extra: string[], envExtra?: Record<string, string | undefined>) {
    const env: Record<string, string | undefined> = { ...process.env, ...envExtra };
    delete env.AI_CODING_SESSIONS_QUIET;
    if (envExtra && 'AI_CODING_SESSIONS_QUIET' in envExtra) {
      env.AI_CODING_SESSIONS_QUIET = envExtra.AI_CODING_SESSIONS_QUIET;
    }
    const proc = Bun.spawn(
      [
        'bun',
        cliPath,
        'list',
        '--source=kimi',
        '--days=1',
        '--limit=1',
        '--raw',
        `--db=${path.join(tmpDir, 't.sqlite')}`,
        `--meta=${path.join(tmpDir, 't.meta.json')}`,
        ...extra,
      ],
      { stdout: 'pipe', stderr: 'pipe', env: env as Record<string, string> },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test('默认: stderr 无 [sqlite: banner, stdout 可 JSON.parse', async () => {
    const { stdout, stderr, exitCode } = await runCli([]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/\[sqlite:/);
    const parsed = JSON.parse(stdout);
    expect(parsed.mode).toBe('cache');
    expect(Array.isArray(parsed.sessions)).toBe(true);
  });

  test('--compact 兼容旧 flag, 不抛 unknown flag', async () => {
    const { stdout, stderr, exitCode } = await runCli(['--compact']);
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/unknown flag/);
    JSON.parse(stdout);
  });

  test('--verbose: stderr 有 sqlite 运行时/关闭日志, stdout 仍是 JSON', async () => {
    const { stdout, stderr, exitCode } = await runCli(['--verbose']);
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/\[sqlite:ai-coding-sessions-cache\] 运行时/);
    expect(stderr).toMatch(/数据库连接已关闭/);
    JSON.parse(stdout);
  });

  test('AI_CODING_SESSIONS_QUIET=0 也可打开 banner', async () => {
    const { stderr, exitCode } = await runCli([], { AI_CODING_SESSIONS_QUIET: '0' });
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/\[sqlite:/);
  });
});
