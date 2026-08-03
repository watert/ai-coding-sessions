import { describe, expect, test } from 'bun:test';
import {
  reconstructClaudeMainChain,
  isClaudeConvertibleMessage,
  parseClaudeJsonl,
} from './claude-main-chain';

function rec(partial: Record<string, any>) {
  return { isSidechain: false, ...partial };
}

describe('reconstructClaudeMainChain', () => {
  test('follows parent chain and drops sidechain', () => {
    const records = [
      rec({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        promptId: 'p1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      }),
      rec({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          id: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
      // sidechain branch — should not appear
      rec({
        type: 'user',
        uuid: 'side-u',
        parentUuid: null,
        isSidechain: true,
        promptId: 'p2',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'user', content: 'side' },
      }),
      rec({
        type: 'assistant',
        uuid: 'side-a',
        parentUuid: 'side-u',
        isSidechain: true,
        timestamp: '2026-01-01T00:00:03.000Z',
        message: {
          id: 'ms',
          role: 'assistant',
          content: [{ type: 'text', text: 'side ans' }],
          usage: { input_tokens: 999, output_tokens: 999 },
        },
      }),
      rec({
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        promptId: 'p3',
        timestamp: '2026-01-01T00:00:04.000Z',
        message: { role: 'user', content: 'next' },
      }),
      rec({
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        timestamp: '2026-01-01T00:00:05.000Z',
        message: {
          id: 'm2',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 20, output_tokens: 3 },
        },
      }),
    ];

    const { messages, meta } = reconstructClaudeMainChain(records);
    expect(meta.sidechain_skipped).toBe(2);
    expect(messages.map((m) => m.uuid)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(messages.some((m) => m.uuid === 'side-a')).toBe(false);
  });

  test('absolute compact_boundary drops pre-boundary history', () => {
    const records = [
      rec({
        type: 'user',
        uuid: 'old-u',
        parentUuid: null,
        promptId: 'p0',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'old' },
      }),
      rec({
        type: 'assistant',
        uuid: 'old-a',
        parentUuid: 'old-u',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          id: 'oldm',
          role: 'assistant',
          content: [{ type: 'text', text: 'old ans' }],
          usage: { input_tokens: 5000, output_tokens: 100 },
        },
      }),
      // absolute compact (no preserved segment)
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'cb1',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      rec({
        type: 'user',
        uuid: 'new-u',
        parentUuid: null,
        promptId: 'p1',
        timestamp: '2026-01-01T00:00:03.000Z',
        message: { role: 'user', content: 'after compact' },
      }),
      rec({
        type: 'assistant',
        uuid: 'new-a',
        parentUuid: 'new-u',
        timestamp: '2026-01-01T00:00:04.000Z',
        message: {
          id: 'newm',
          role: 'assistant',
          content: [{ type: 'text', text: 'fresh' }],
          usage: { input_tokens: 50, output_tokens: 10 },
        },
      }),
    ];

    const { messages, meta } = reconstructClaudeMainChain(records);
    expect(meta.compact_boundaries).toBe(1);
    expect(messages.map((m) => m.uuid)).toEqual(['new-u', 'new-a']);
    expect(messages.some((m) => m.uuid === 'old-a')).toBe(false);
  });

  test('snip removals unlink deleted parents', () => {
    const records = [
      rec({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        promptId: 'p1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'a' },
      }),
      rec({
        type: 'assistant',
        uuid: 'a-snip',
        parentUuid: 'u1',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          id: 'ms',
          role: 'assistant',
          content: [{ type: 'text', text: 'snip me' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      rec({
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a-snip',
        promptId: 'p2',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'user', content: 'b' },
        snipMetadata: { removedUuids: ['a-snip'] },
      }),
      rec({
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        timestamp: '2026-01-01T00:00:03.000Z',
        message: {
          id: 'm2',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 2, output_tokens: 2 },
        },
      }),
    ];

    const { messages, meta } = reconstructClaudeMainChain(records);
    expect(meta.snip_removed).toBe(1);
    expect(messages.map((m) => m.uuid)).toEqual(['u1', 'u2', 'a2']);
    expect(messages.find((m) => m.uuid === 'u2')?.parentUuid).toBe('u1');
  });

  test('recovers parallel assistant siblings by message.id', () => {
    const records = [
      rec({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        promptId: 'p1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'do tools' },
      }),
      rec({
        type: 'assistant',
        uuid: 'a-think',
        parentUuid: 'u1',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          id: 'mid',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'plan' }],
        },
      }),
      rec({
        type: 'assistant',
        uuid: 'a-tool1',
        parentUuid: 'a-think',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          id: 'mid',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.ts' } }],
        },
      }),
      rec({
        type: 'assistant',
        uuid: 'a-tool2',
        parentUuid: 'a-tool1',
        timestamp: '2026-01-01T00:00:03.000Z',
        message: {
          id: 'mid',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { path: 'b.ts' } }],
        },
      }),
      // leaf path only through a-tool2; if we only walked a-tool2 parent chain we get all;
      // break chain so a-tool1 is sibling not on path
      rec({
        type: 'user',
        uuid: 'tr1',
        parentUuid: 'a-tool2',
        promptId: 'p1',
        timestamp: '2026-01-01T00:00:04.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok2' }],
        },
      }),
      // orphan sibling result (parent a-tool1 not on linear leaf if we reparented)
      rec({
        type: 'user',
        uuid: 'tr0',
        parentUuid: 'a-tool1',
        promptId: 'p1',
        timestamp: '2026-01-01T00:00:03.500Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok1' }],
        },
      }),
    ];

    // Force leaf to tr1; chain u1→a-think→a-tool1→a-tool2→tr1 — all on chain already.
    // Alternative structure: a-tool2 parents to a-think, skipping a-tool1
    records[3].parentUuid = 'a-think'; // a-tool2 sibling of a-tool1

    const { messages, meta } = reconstructClaudeMainChain(records);
    const ids = new Set(messages.map((m) => m.uuid));
    expect(ids.has('a-tool1') || ids.has('a-tool2')).toBe(true);
    // both tools should be recovered (on chain or via parallel)
    expect(ids.has('a-tool1')).toBe(true);
    expect(ids.has('a-tool2')).toBe(true);
    expect(meta.parallel_recovered).toBeGreaterThanOrEqual(0);
  });

  test('parseClaudeJsonl skips bad lines', () => {
    const records = parseClaudeJsonl('{"type":"user","uuid":"x"}\nnot-json\n{"type":"assistant","uuid":"y"}\n');
    expect(records).toHaveLength(2);
  });

  test('isClaudeConvertibleMessage allows tool_result without promptId', () => {
    expect(
      isClaudeConvertibleMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeConvertibleMessage({
        type: 'user',
        message: { role: 'user', content: 'nope' },
      }),
    ).toBe(false);
  });
});
