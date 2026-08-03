/**
 * readGrokWallClockEvents 边界：thought→tools 同 step、多 turn、user multi-chunk
 */
import { describe, expect, it, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readGrokWallClockEvents } from './grok-code';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-wall-'));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeUpdates(name: string, rows: unknown[]): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'updates.jsonl'),
    rows.map((x) => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''),
  );
  return dir;
}

function row(
  sessionUpdate: string,
  agentTimestampMs: number,
  extra: Record<string, unknown> = {},
  metaExtra: Record<string, unknown> = {},
) {
  return {
    timestamp: Math.floor(agentTimestampMs / 1000),
    method: 'session/update',
    params: {
      update: { sessionUpdate, ...extra },
      _meta: { agentTimestampMs, ...metaExtra },
    },
  };
}

describe('readGrokWallClockEvents', () => {
  const t0 = 1_700_000_000_000;

  it('thought → tools 同 step 不拆', () => {
    const dir = writeUpdates('same-step', [
      row('user_message_chunk', t0),
      row('agent_thought_chunk', t0 + 100),
      row('agent_message_chunk', t0 + 200),
      row('tool_call', t0 + 300, { toolCallId: 'c1' }),
      row('tool_call', t0 + 301, { toolCallId: 'c2' }),
      row('tool_call_update', t0 + 500, { toolCallId: 'c1', status: 'completed' }),
      row('tool_call_update', t0 + 510, { toolCallId: 'c2', status: 'completed' }),
      row('turn_completed', t0 + 600),
    ]);
    const w = readGrokWallClockEvents(dir);
    expect(w.userStarts).toEqual([t0]);
    expect(w.assistantStarts).toEqual([t0 + 100]); // thought 开步，tools 不新开
    expect(w.turnEnds).toEqual([t0 + 600]);
    expect(w.toolTimes.get('c1')).toEqual({ start: t0 + 300, end: t0 + 500 });
    expect(w.toolTimes.get('c2')).toEqual({ start: t0 + 301, end: t0 + 510 });
  });

  it('tools 完成后下一批 tool_call 新 step', () => {
    const dir = writeUpdates('next-batch', [
      row('user_message_chunk', t0),
      row('tool_call', t0 + 100, { toolCallId: 'a1' }),
      row('tool_call_update', t0 + 200, { toolCallId: 'a1', status: 'completed' }),
      row('tool_call', t0 + 1000, { toolCallId: 'b1' }),
      row('tool_call_update', t0 + 1100, { toolCallId: 'b1', status: 'completed' }),
      row('agent_message_chunk', t0 + 1200),
      row('turn_completed', t0 + 1300),
    ]);
    const w = readGrokWallClockEvents(dir);
    expect(w.assistantStarts).toEqual([t0 + 100, t0 + 1000]);
  });

  it('多 user turn / 多 turn_completed', () => {
    const dir = writeUpdates('multi-turn', [
      row('user_message_chunk', t0),
      row('agent_message_chunk', t0 + 50),
      row('turn_completed', t0 + 100),
      row('user_message_chunk', t0 + 5000),
      row('tool_call', t0 + 5100, { toolCallId: 'x' }),
      row('tool_call_update', t0 + 5200, { toolCallId: 'x', status: 'completed' }),
      row('turn_completed', t0 + 5300),
    ]);
    const w = readGrokWallClockEvents(dir);
    expect(w.userStarts).toEqual([t0, t0 + 5000]);
    expect(w.turnEnds).toEqual([t0 + 100, t0 + 5300]);
    expect(w.assistantStarts).toEqual([t0 + 50, t0 + 5100]);
  });

  it('同 user 多 chunk 只记一个 start（间隔 ≤50ms）', () => {
    const dir = writeUpdates('user-chunks', [
      row('user_message_chunk', t0),
      row('user_message_chunk', t0 + 10),
      row('user_message_chunk', t0 + 40),
      row('agent_message_chunk', t0 + 100),
    ]);
    const w = readGrokWallClockEvents(dir);
    expect(w.userStarts).toEqual([t0]);
  });

  it('同 user chunk 间隔 >50ms 记为新 user start', () => {
    const dir = writeUpdates('user-gap', [
      row('user_message_chunk', t0),
      row('user_message_chunk', t0 + 100),
    ]);
    const w = readGrokWallClockEvents(dir);
    expect(w.userStarts).toEqual([t0, t0 + 100]);
  });

  it('空 updates → 空结果', () => {
    const dir = writeUpdates('empty', []);
    const w = readGrokWallClockEvents(dir);
    expect(w.userStarts).toEqual([]);
    expect(w.assistantStarts).toEqual([]);
    expect(w.turnEnds).toEqual([]);
    expect(w.toolTimes.size).toBe(0);
  });
});
