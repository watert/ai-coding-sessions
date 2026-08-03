import { describe, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { resolveClaudeBase, encodeClaudeProjectDir, getProjectPath } from './claude-code';
import { resolveKimiBase } from './kimi-code';
import { resolveCodexBase } from './codex-code';

describe('source path resolvers (Windows-friendly)', () => {
  test('resolveClaudeBase defaults to ~/.claude', () => {
    expect(resolveClaudeBase({})).toBe(path.join(os.homedir(), '.claude'));
  });

  test('resolveClaudeBase honors CLAUDE_CONFIG_DIR and projects parent', () => {
    const root = path.join(os.tmpdir(), 'claude-cfg');
    expect(resolveClaudeBase({ CLAUDE_CONFIG_DIR: root })).toBe(path.resolve(root));
    expect(
      resolveClaudeBase({ CLAUDE_CONFIG_DIR: path.join(root, 'projects') }),
    ).toBe(path.resolve(root));
    expect(
      resolveClaudeBase({ CLAUDE_CONFIG_DIR: `${root},/other` }),
    ).toBe(path.resolve(root));
  });

  test('encodeClaudeProjectDir replaces / and \\', () => {
    expect(encodeClaudeProjectDir('/Users/a/proj')).toBe('-Users-a-proj');
    expect(encodeClaudeProjectDir('C:\\Users\\a\\proj')).toBe('C:-Users-a-proj');
  });

  test('getProjectPath uses path.join under base', () => {
    const base = path.join(os.tmpdir(), 'claude-base');
    const p = getProjectPath('/tmp/work', base);
    expect(p).toBe(path.join(base, 'projects', '-tmp-work'));
  });

  test('resolveKimiBase defaults and KIMI_DATA_DIR', () => {
    expect(resolveKimiBase({})).toBe(path.join(os.homedir(), '.kimi-code'));
    const custom = path.join(os.tmpdir(), 'kimi-data');
    expect(resolveKimiBase({ KIMI_DATA_DIR: custom })).toBe(path.resolve(custom));
  });

  test('resolveCodexBase defaults and CODEX_HOME', () => {
    expect(resolveCodexBase({})).toBe(path.join(os.homedir(), '.codex'));
    const custom = path.join(os.tmpdir(), 'codex-home');
    expect(resolveCodexBase({ CODEX_HOME: custom })).toBe(path.resolve(custom));
  });
});
