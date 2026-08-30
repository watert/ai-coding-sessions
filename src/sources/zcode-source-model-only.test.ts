/** model-only 注入消息过滤 (todo_reminder 等) 单测 */
import { describe, it, expect } from 'vitest';
import { isZcodeModelOnlyMessage, convertZcodeMessage } from './zcode-source';
import type { ZcodeMessageItem } from './zcode-code';

function mkMsg(data: any, parts: any[] = []): ZcodeMessageItem {
  return {
    id: 'msg_1', sessionId: 'sess_1', role: data?.role || 'user',
    timeCreated: 1788062987966, timeUpdated: 1788062987966, data, parts,
  };
}

describe('zcode model-only message 过滤', () => {
  it('识别 todo_reminder / background_task / hidden 语义标记', () => {
    expect(isZcodeModelOnlyMessage(mkMsg({
      role: 'user',
      metadata: { source: 'todo_reminder', visibility: 'model-only' },
    }))).toBe(true);
    expect(isZcodeModelOnlyMessage(mkMsg({
      role: 'user',
      metadata: { visibility: 'model-only' },
      semantics: { kind: 'background_task', uiVisibility: 'hidden' },
    }))).toBe(true);
    expect(isZcodeModelOnlyMessage(mkMsg({
      role: 'user',
      semantics: { kind: 'compact_summary', transcriptVisibility: 'hidden' },
    }))).toBe(true);
  });

  it('正常用户消息不误伤', () => {
    expect(isZcodeModelOnlyMessage(mkMsg({
      role: 'user', time: { created: 1 },
      contextSnapshot: { envInfo: { cwd: '/x' } },
    }))).toBe(false);
    expect(isZcodeModelOnlyMessage(mkMsg({ role: 'assistant' }))).toBe(false);
  });

  it('convertZcodeMessage 不因过滤标记丢失字段', () => {
    const um = convertZcodeMessage(mkMsg({
      role: 'user', metadata: { visibility: 'model-only' },
    }, [{ type: 'text', text: 'The TodoWrite tool...' }]));
    expect(um.info.role).toBe('user');
    expect(um.parts[0].text).toBe('The TodoWrite tool...');
  });
});
