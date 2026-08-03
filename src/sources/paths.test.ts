import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveClaudeBase, encodeClaudeProjectDir, getProjectPath } from './claude-code';
import { resolveKimiBase } from './kimi-code';
import { resolveCodexBase } from './codex-code';
import { resolveGrokSessionsRoot } from './grok-code';
import { resolveZcodeDbPath } from './zcode-code';
import { resolveWorkbuddyRoot } from './workbuddy-code';
import { resolveHomeDir, resolveDataRoot } from '../lib/home-paths';
import { splitLines } from '../lib/jsonl-cache';

describe('source path resolvers (Windows-friendly)', () => {
  test('resolveClaudeBase defaults to ~/.claude when nothing exists', () => {
    // 隔离 XDG，避免本机真实目录干扰
    const env = { HOME: '/tmp/acs-home-none', XDG_CONFIG_HOME: '/tmp/acs-xdg-none' } as any;
    expect(resolveClaudeBase(env)).toBe(path.join('/tmp/acs-home-none', '.claude'));
  });

  test('resolveClaudeBase honors CLAUDE_CONFIG_DIR and projects parent', () => {
    const root = path.join(os.tmpdir(), `claude-cfg-${Date.now()}`);
    expect(resolveClaudeBase({ CLAUDE_CONFIG_DIR: root } as any)).toBe(path.resolve(root));
    expect(
      resolveClaudeBase({ CLAUDE_CONFIG_DIR: path.join(root, 'projects') } as any),
    ).toBe(path.resolve(root));
    expect(
      resolveClaudeBase({ CLAUDE_CONFIG_DIR: `${root},/other` } as any),
    ).toBe(path.resolve(root));
  });

  test('resolveClaudeBase prefers existing XDG over missing home', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-claude-'));
    const xdg = path.join(tmp, 'xdg');
    const home = path.join(tmp, 'home');
    const xdgClaude = path.join(xdg, 'claude');
    fs.mkdirSync(path.join(xdgClaude, 'projects'), { recursive: true });
    const got = resolveClaudeBase({
      HOME: home,
      XDG_CONFIG_HOME: xdg,
    } as any);
    expect(got).toBe(xdgClaude);
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
    const home = '/tmp/acs-kimi-home-none';
    expect(resolveKimiBase({ HOME: home } as any)).toBe(path.join(home, '.kimi-code'));
    const custom = path.join(os.tmpdir(), 'kimi-data');
    expect(resolveKimiBase({ KIMI_DATA_DIR: custom } as any)).toBe(path.resolve(custom));
  });

  test('resolveKimiBase prefers existing .kimi when .kimi-code missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-kimi-'));
    const home = path.join(tmp, 'home');
    const kimi = path.join(home, '.kimi');
    fs.mkdirSync(path.join(kimi, 'sessions'), { recursive: true });
    expect(resolveKimiBase({ HOME: home } as any)).toBe(kimi);
  });

  test('resolveCodexBase defaults and CODEX_HOME', () => {
    const home = '/tmp/acs-codex-none';
    expect(resolveCodexBase({ HOME: home } as any)).toBe(path.join(home, '.codex'));
    const custom = path.join(os.tmpdir(), 'codex-home');
    expect(resolveCodexBase({ CODEX_HOME: custom } as any)).toBe(path.resolve(custom));
  });

  test('resolveGrokSessionsRoot / Zcode / Workbuddy env', () => {
    const home = '/tmp/acs-more-none';
    expect(resolveGrokSessionsRoot({ HOME: home } as any)).toBe(
      path.join(home, '.grok', 'sessions'),
    );
    expect(resolveZcodeDbPath({ HOME: home } as any)).toBe(
      path.join(home, '.zcode', 'cli', 'db', 'db.sqlite'),
    );
    expect(resolveWorkbuddyRoot({ HOME: home } as any)).toBe(path.join(home, '.workbuddy'));
    const g = path.join(os.tmpdir(), 'grok-root');
    expect(resolveGrokSessionsRoot({ GROK_HOME: g } as any)).toBe(path.join(path.resolve(g), 'sessions'));
  });

  test('resolveHomeDir USERPROFILE fallback', () => {
    expect(resolveHomeDir({ USERPROFILE: 'C:\\Users\\runner' } as any)).toBeTruthy();
  });

  test('splitLines handles CRLF', () => {
    expect(splitLines('a\r\nb\rc\n')).toEqual(['a', 'b', 'c', '']);
  });

  test('resolveDataRoot env list first ok', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-root-'));
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    fs.mkdirSync(b);
    const got = resolveDataRoot({
      envValue: `${a},${b}`,
      defaults: [a],
      isOk: (p) => fs.existsSync(p),
    });
    expect(got).toBe(b);
  });
});
