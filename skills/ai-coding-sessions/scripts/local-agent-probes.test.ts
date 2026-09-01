/**
 * 本地 agent 探测: catalog 完整性 + hermetic 规模统计
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_PROBES,
  checkLocalAgents,
  displayPath,
  formatBytes,
  makeProbeCtx,
  measureRoot,
  probeAgent,
} from './local-agent-probes.ts';

describe('local-agent-probes', () => {
  test('catalog ids unique and roots stay relative to home/env', () => {
    const ids = AGENT_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(AGENT_PROBES.filter((p) => p.kind === 'acs').map((p) => p.id)).toEqual([
      'opencode',
      'claude',
      'kimi',
      'grok',
      'codex',
      'zcode',
      'workbuddy',
      'cursor',
    ]);
    const ctx = makeProbeCtx({ HOME: '/tmp/acs-probe-home', XDG_CONFIG_HOME: '/tmp/acs-xdg' } as any);
    expect(ctx.home).toBe('/tmp/acs-probe-home');
    const cur = makeProbeCtx({ HOME: '/tmp/acs-probe-home', CURSOR_APP_DATA: '/tmp/acs-cursor-app' } as any);
    expect(AGENT_PROBES.find((p) => p.id === 'cursor')!.roots(cur).some((r) => r.includes('acs-cursor-app'))).toBe(true);
    for (const p of AGENT_PROBES) {
      const roots = p.roots(ctx);
      expect(roots.length).toBeGreaterThan(0);
      for (const r of roots) {
        expect(r.includes('/Users/')).toBe(false);
        expect(path.isAbsolute(r) || r.startsWith('/tmp') || r.includes('acs-probe-home') || r.includes('acs-xdg')).toBe(true);
      }
    }
  });

  test('measureRoot counts jsonl scale in a temp tree', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-probe-'));
    const sess = path.join(dir, 'sessions', 'a');
    fs.mkdirSync(sess, { recursive: true });
    fs.writeFileSync(path.join(sess, 'wire.jsonl'), 'x'.repeat(100));
    fs.writeFileSync(path.join(sess, 'skip.txt'), 'nope');
    const hit = measureRoot(dir, '**/wire.jsonl');
    expect(hit.exists).toBe(true);
    expect(hit.files).toBe(1);
    expect(hit.bytes).toBe(100);
    expect(measureRoot(path.join(dir, 'missing'), '**/*').exists).toBe(false);
  });

  test('probeAgent present vs missing; checkLocalAgents respects --all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-probe2-'));
    const kimi = path.join(dir, '.kimi-code', 'sessions', 'w', 's', 'agents', 'main');
    fs.mkdirSync(kimi, { recursive: true });
    fs.writeFileSync(path.join(kimi, 'wire.jsonl'), '{"t":1}\n');
    const ctx = makeProbeCtx({ HOME: dir } as any);
    const kimiProbe = AGENT_PROBES.find((p) => p.id === 'kimi')!;
    const present = probeAgent(kimiProbe, ctx);
    expect(present.status).toBe('present');
    expect(present.files).toBe(1);
    const ghost = AGENT_PROBES.find((p) => p.id === 'pi')!;
    expect(probeAgent(ghost, ctx).status).toBe('missing');
    const shown = checkLocalAgents({ kind: 'acs' }, ctx);
    expect(shown.map((h) => h.id)).toContain('kimi');
    expect(shown.every((h) => h.status === 'present')).toBe(true);
    const all = checkLocalAgents({ kind: 'other', all: true }, ctx);
    expect(all.length).toBeGreaterThan(shown.length);
    expect(displayPath(path.join(dir, 'x'), dir)).toBe(`~${path.sep}x`);
    expect(formatBytes(2048).endsWith('KB')).toBe(true);
  });
});
