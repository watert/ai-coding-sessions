/**
 * Kimi subagent 虚拟 session 拆分测试
 */
import { describe, it, expect } from 'bun:test';
import {
  listKimiSubagentsFromMainWire,
  parseKimiVirtualSessionId,
  buildKimiSubagentSessionId,
  listKimiCodeMessages,
} from './kimi-code';
import { listSessions, getSessionDetail } from './index';

const ROOT = 'session_d9500bae-c9fb-4c86-b9f2-5f4fe116a9ef';

describe('Kimi subagent sessions', () => {
  it('parseKimiVirtualSessionId 应拆分 root 与 agentDir', () => {
    const id = buildKimiSubagentSessionId(ROOT, 'agent-0');
    expect(parseKimiVirtualSessionId(id)).toEqual({ rootSessionId: ROOT, agentDir: 'agent-0' });
    expect(parseKimiVirtualSessionId(ROOT)).toEqual({ rootSessionId: ROOT });
  });

  it('listKimiSubagentsFromMainWire 应发现 agent-0/agent-1', async () => {
    const { listKimiCodeSessions } = await import('./kimi-code');
    const sessions = await listKimiCodeSessions();
    const root = sessions.find(s => s.sessionId === ROOT);
    expect(root).toBeDefined();
    const metas = await listKimiSubagentsFromMainWire(root!.sessionDir, ROOT);
    expect(metas.length).toBeGreaterThanOrEqual(2);
    expect(metas.map(m => m.agentDir).sort()).toContain('agent-0');
    expect(metas[0].parentSessionId).toBe(ROOT);
  });

  it('子 session detail 应有 messages 且 parent_id 指向 root', async () => {
    const { listKimiCodeSessions } = await import('./kimi-code');
    const root = (await listKimiCodeSessions()).find(s => s.sessionId === ROOT);
    const metas = await listKimiSubagentsFromMainWire(root!.sessionDir, ROOT);
    const subId = metas[0].virtualSessionId;
    const detail = await getSessionDetail({ sessionId: subId, source: 'kimi' });
    expect(detail).toBeDefined();
    expect(detail!.info.parent_id).toBe(ROOT);
    expect(detail!.messages.length).toBeGreaterThan(0);
    const msgs = await listKimiCodeMessages({ sessionId: subId, sessionDir: root!.sessionDir });
    expect(msgs.some(m => m.role === 'assistant')).toBe(true);
  });

  it('listSessions source=kimi 应包含带 parent_id 的子项', async () => {
    const { sessions } = await listSessions({ source: 'kimi' });
    const subs = sessions.filter(s => s.parent_id === ROOT);
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(subs.every(s => s.id.includes('__agent-'))).toBe(true);
  }, 60_000);
});