import { describe, expect, test } from 'bun:test';
import {
  applyCodexCompaction,
  dropLastUserTurns,
  resolveExistingRolloutPath,
} from './codex-code';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('applyCodexCompaction', () => {
  test('uses last replacement_history as base and keeps later events', () => {
    const records = [
      { type: 'session_meta', payload: { id: 's1' } },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old' }] },
      },
      {
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 999 } } },
      },
      {
        type: 'compacted',
        payload: {
          replacement_history: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summary ask' }] },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'summary ans' }],
            },
          ],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: 'continue after compact' },
      },
      {
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10 } } },
      },
    ];

    const out = applyCodexCompaction(records as any);
    // 2 synthetic response_item + 2 post-compact events
    expect(out.length).toBe(4);
    expect(out[0].type).toBe('response_item');
    expect((out[0] as any).payload.role).toBe('user');
    expect(out[1].type).toBe('response_item');
    expect(out[2].type).toBe('event_msg');
    expect((out[2] as any).payload.type).toBe('user_message');
    // old pre-compact token_count not present
    expect(
      out.some(
        (e) =>
          e.type === 'event_msg' &&
          (e as any).payload?.type === 'token_count' &&
          (e as any).payload?.info?.last_token_usage?.input_tokens === 999,
      ),
    ).toBe(false);
  });

  test('no compacted → identity', () => {
    const records = [{ type: 'session_meta', payload: {} }];
    expect(applyCodexCompaction(records as any)).toEqual(records as any);
  });
});

describe('dropLastUserTurns', () => {
  test('drops last N user turns and trailing assistants', () => {
    const msgs = [
      { role: 'user', id: 'u1' },
      { role: 'assistant', id: 'a1' },
      { role: 'user', id: 'u2' },
      { role: 'assistant', id: 'a2' },
      { role: 'user', id: 'u3' },
      { role: 'assistant', id: 'a3' },
    ];
    const out = dropLastUserTurns(msgs, 2);
    expect(out.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  test('numTurns 0 keeps all', () => {
    const msgs = [{ role: 'user' as const }];
    expect(dropLastUserTurns(msgs, 0)).toEqual(msgs);
  });
});

describe('resolveExistingRolloutPath', () => {
  test('finds .jsonl.zst sibling', () => {
    const dir = tmpdir();
    const plain = join(dir, `rollout-test-${Date.now()}.jsonl`);
    const zst = `${plain}.zst`;
    // only zst exists
    writeFileSync(zst, 'fake');
    try {
      expect(resolveExistingRolloutPath(plain)).toBe(zst);
      expect(resolveExistingRolloutPath(zst)).toBe(zst);
    } finally {
      if (existsSync(zst)) unlinkSync(zst);
    }
  });
});
