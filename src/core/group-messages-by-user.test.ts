/**
 * groupMessagesByUser parentID 环不得卡死
 */
import { describe, expect, it } from 'bun:test';
import { groupMessagesByUser, type OpenCodeMessage } from './opencode';

function msg(id: string, role: 'user' | 'assistant', parentID?: string): OpenCodeMessage {
  return {
    info: { id, role, sessionID: 's', time: { created: 1 }, parentID },
    parts: [{ type: 'text', id: `${id}-p`, sessionID: 's', messageID: id, text: 'x' }],
  };
}

describe('groupMessagesByUser', () => {
  it('parentID 自环 / 互环不会死循环', () => {
    const self = [
      msg('u1', 'user'),
      msg('a1', 'assistant', 'a1'),
    ];
    const looped = [
      msg('u2', 'user'),
      msg('a2', 'assistant', 'a3'),
      msg('a3', 'assistant', 'a2'),
    ];
    expect(() => groupMessagesByUser(self)).not.toThrow();
    expect(() => groupMessagesByUser(looped)).not.toThrow();
    expect(groupMessagesByUser(self).u1.msgs).toEqual([]);
    expect(groupMessagesByUser(looped).u2.msgs).toEqual([]);
  });

  it('正常 parentID 链到 user', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', 'u1'),
      msg('a2', 'assistant', 'a1'),
    ];
    const grouped = groupMessagesByUser(messages);
    expect(grouped.u1.msgs.map((m) => m.info.id)).toEqual(['a1', 'a2']);
  });
});
