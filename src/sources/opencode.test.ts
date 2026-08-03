/**
 * OpenCode SQLite 服务测试
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  getOpencodeDbPath,
  initOpencodeDb,
  getOpencodeDb,
  getSessionList,
  getSessionDetail,
  closeOpencodeDb,
} from './opencode';

describe('OpenCode SQLite 服务', () => {
  beforeAll(async () => {
    await initOpencodeDb();
  });

  afterAll(() => {
    closeOpencodeDb();
  });

  describe('getOpencodeDbPath', () => {
    it('应该返回有效的数据库路径', () => {
      const dbPath = getOpencodeDbPath();
      expect(dbPath).toBeTruthy();
      expect(dbPath).toContain('opencode.db');
    });
  });

  describe('initOpencodeDb', () => {
    it('应该成功初始化数据库连接', () => {
      const db = getOpencodeDb();
      expect(db).toBeTruthy();
    });
  });

  describe('getSessionList', () => {
    it('应该返回 session 列表', () => {
      const { list } = getSessionList();
      expect(Array.isArray(list)).toBe(true);
      
      if (list.length > 0) {
        const item = list[0];
        expect(item).toHaveProperty('session_id');
        expect(item).toHaveProperty('session_title');
        expect(item).toHaveProperty('session_dir');
        expect(item).toHaveProperty('project_id');
        expect(item).toHaveProperty('project_name');
        expect(item).toHaveProperty('total_messages');
        expect(item).toHaveProperty('total_user_messages');
        expect(item).toHaveProperty('total_tool_calls');
        expect(item).toHaveProperty('total_tokens');
        expect(item).toHaveProperty('last_active_at');
      }
    });

    it('应该支持自定义天数', () => {
      const { list: list30days } = getSessionList('2026-06-01', '2026-06-30');
      const { list: list7days } = getSessionList('2026-06-24', '2026-06-30');
      // 30 天的数据量应该 >= 7 天
      expect(list30days.length).toBeGreaterThanOrEqual(list7days.length);
    }, 30_000);
  });

  describe('getSessionDetail compaction', () => {
    // 含 agent=compaction 的真实 session（手动 compact）
    const COMPACT_SESSION = 'ses_06ddf54d1ffeR4tvEvPbU1dx2A';

    it('应标记 compaction 消息并回填 time_compacting', () => {
      const detail = getSessionDetail(COMPACT_SESSION);
      if (!detail) {
        console.log('compact sample session 不存在，跳过');
        return;
      }
      const compactMsgs = detail.messages.filter(m => m.info.compaction);
      expect(compactMsgs.length).toBeGreaterThanOrEqual(2); // user trigger + assistant summary
      const asst = compactMsgs.find(m => m.info.role === 'assistant');
      expect(asst).toBeDefined();
      expect(asst!.parts.some(p => String(p.text || '').startsWith('[Context Compacted]'))).toBe(true);
      const user = compactMsgs.find(m => m.info.role === 'user');
      expect(user).toBeDefined();
      expect(user!.parts.some(p => String(p.text || '').includes('手动压缩') || String(p.text || '').includes('自动压缩'))).toBe(true);
      expect(detail.info.time_compacting).toBeTruthy();
      expect(Number(detail.info.time_compacting)).toBeGreaterThan(0);
    });
  });

  describe('getSessionDetail', () => {
    it('应该返回 session 详情', () => {
      // 先获取一个 session id
      const { list } = getSessionList();
      if (list.length === 0) {
        console.log('没有可用的 session，跳过详情测试');
        return;
      }

      const sessionId = list[0].session_id;
      const detail = getSessionDetail(sessionId);
      
      expect(detail).toBeTruthy();
      expect(detail!.info).toHaveProperty('id', sessionId);
      expect(detail!.info).toHaveProperty('title');
      expect(detail!.info).toHaveProperty('directory');
      expect(Array.isArray(detail!.messages)).toBe(true);

      // 验证 messages 结构
      if (detail!.messages.length > 0) {
        const msg = detail!.messages[0];
        expect(msg).toHaveProperty('info');
        expect(msg).toHaveProperty('parts');
        expect(msg.info).toHaveProperty('id');
        expect(msg.info).toHaveProperty('role');
        expect(msg.info).toHaveProperty('time');
        expect(Array.isArray(msg.parts)).toBe(true);
      }
    });

    it('不存在的 session 应返回 null', () => {
      const detail = getSessionDetail('non-existent-session-id');
      expect(detail).toBeNull();
    });
  });

  describe('数据完整性', () => {
    it('session list 应包含有效的 token 统计', () => {
      const { list } = getSessionList();
      for (const item of list) {
        expect(typeof item.total_tokens).toBe('number');
        expect(typeof item.total_input).toBe('number');
        expect(typeof item.total_output).toBe('number');
        expect(item.total_tokens).toBeGreaterThanOrEqual(0);
      }
    });

    it('session detail 的 messages 应有正确的 parts 关联', () => {
      const { list } = getSessionList();
      if (list.length === 0) return;

      const detail = getSessionDetail(list[0].session_id);
      if (!detail || detail.messages.length === 0) return;

      for (const msg of detail.messages) {
        for (const part of msg.parts) {
          expect(part.messageID).toBe(msg.info.id);
          expect(part.sessionID).toBe(detail.info.id);
        }
      }
    });
  });
});
