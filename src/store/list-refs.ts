/**
 * listRefs：轻量枚举 + 便宜脏标记（mtime / index updatedAt / SQL time_updated）
 *
 * 已知偏差（脏标记语义）：
 * - zcode: time_updated 可被 title 同步刷新，活动应以 message 为准
 * - grok: dirty_mark = updates.jsonl mtime:size（勿用 summary last_active 心跳）
 * - workbuddy: 用量在 jsonl，SQLite 时间戳可能滞后
 * - claude: history.jsonl timestamp 为列表时间，非 message 边界
 *
 * 命中脏后仍需 convert + content_fingerprint 再决定是否写库。
 */

import { getSqliteDb } from '../lib/sqlite';
import { listClaudeCodeSessions } from '../sources/claude-code';
import { listKimiSessionRefs } from '../sources/kimi-code';
import { listGrokSessionRefs } from '../sources/grok-code';
import { listCodexSessions } from '../sources/codex-code';
import { listZcodeSessions, initZcodeDb } from '../sources/zcode-code';
import { listWorkbuddySessions, initWorkbuddyDb } from '../sources/workbuddy-code';
import { listCursorSessions, initCursorDb } from '../sources/cursor-code';
import { initOpencodeDb } from '../sources/opencode';
import type { SourceId } from './schema';
import { ALL_SOURCES } from './schema';

export interface SessionRef {
  source: SourceId;
  session_id: string;
  /** 便宜脏标记（字符串化 mtime / updatedAt） */
  dirty_mark: string;
  time_updated?: number;
  title?: string;
  /** 源侧偏差备注，调试用 */
  dirty_semantics?: string;
}

export interface ListRefsOptions {
  source?: SourceId | 'all';
  /** 只返回 time_updated >= since（ms）；缺省不过滤 */
  since?: number;
}

const SEMANTICS: Partial<Record<SourceId, string>> = {
  zcode: 'time_updated may refresh on title sync; activity prefers messages',
  grok: 'updates.jsonl mtime:size (not summary last_active heartbeat)',
  workbuddy: 'sqlite timestamps may lag jsonl usage',
  claude: 'history.jsonl timestamp is list time, not message bounds',
  kimi: 'wire.jsonl mtime:size (+ state.json mtime floor)',
  opencode: 'session.time_updated SQL',
  codex: 'thread updatedAt',
  cursor: 'composerHeaders lastUpdatedAt; activity prefers bubbles',
};

export async function listRefs(options?: ListRefsOptions): Promise<SessionRef[]> {
  const source = options?.source || 'all';
  const since = options?.since;
  const sources: SourceId[] =
    source === 'all' ? [...ALL_SOURCES] : [source];

  // 多源并行：脏检测热路径
  const batches = await Promise.all(
    sources.map(async (s) => {
      try {
        return await listRefsForSource(s);
      } catch (e) {
        console.warn(`[listRefs] ${s} failed:`, e);
        return [] as SessionRef[];
      }
    }),
  );

  const out: SessionRef[] = [];
  for (const refs of batches) {
    for (const r of refs) {
      if (since != null && r.time_updated != null && r.time_updated < since) continue;
      out.push(r);
    }
  }
  return out;
}

async function listRefsForSource(source: SourceId): Promise<SessionRef[]> {
  const sem = SEMANTICS[source];
  switch (source) {
    case 'claude': {
      const list = await listClaudeCodeSessions();
      return list.map((s) => ({
        source,
        session_id: s.sessionId,
        dirty_mark: String(s.timestamp || 0),
        time_updated: s.timestamp || 0,
        title: s.display,
        dirty_semantics: sem,
      }));
    }
    case 'kimi': {
      // 轻量：index + wire mtime:size，不读 state 正文
      const list = await listKimiSessionRefs();
      return list.map((s) => ({
        source,
        session_id: s.sessionId,
        dirty_mark: s.dirtyMark,
        time_updated: s.updatedAt || 0,
        dirty_semantics: sem,
      }));
    }
    case 'grok': {
      // 轻量：目录 walk + updates mtime:size，不扫 updates 内容
      const list = await listGrokSessionRefs();
      return list.map((s) => ({
        source,
        session_id: s.sessionId,
        dirty_mark: s.dirtyMark,
        time_updated: s.updatedAt || 0,
        dirty_semantics: sem,
      }));
    }
    case 'codex': {
      const list = await listCodexSessions();
      return list.map((s) => ({
        source,
        session_id: s.sessionId,
        dirty_mark: String(s.updatedAt || 0),
        time_updated: s.updatedAt || 0,
        title: s.title,
        dirty_semantics: sem,
      }));
    }
    case 'zcode': {
      await initZcodeDb();
      const list = await listZcodeSessions();
      return list.map((s) => ({
        source,
        session_id: s.sessionId,
        dirty_mark: String(s.updatedAt || 0),
        time_updated: s.updatedAt || 0,
        title: s.title,
        dirty_semantics: sem,
      }));
    }
    case 'workbuddy': {
      await initWorkbuddyDb();
      const list = await listWorkbuddySessions();
      return list.map((s) => ({
        source,
        session_id: s.sessionId,
        dirty_mark: String(s.updatedAt || s.lastActivityAt || 0),
        time_updated: s.updatedAt || s.lastActivityAt || 0,
        title: s.title,
        dirty_semantics: sem,
      }));
    }
    case 'cursor': {
      await initCursorDb();
      const list = await listCursorSessions();
      return list.map((s) => ({
        source,
        session_id: s.sessionId,
        dirty_mark: String(s.updatedAt || 0),
        time_updated: s.updatedAt || 0,
        title: s.title,
        dirty_semantics: sem,
      }));
    }
    case 'opencode': {
      await initOpencodeDb();
      return listOpencodeRefs();
    }
    default:
      return [];
  }
}

function listOpencodeRefs(): SessionRef[] {
  try {
    const db = getSqliteDb('opencode');
    const rows = db
      .prepare(
        `SELECT id, title, time_updated, time_created FROM session ORDER BY time_updated DESC`,
      )
      .all() as Array<{
      id: string;
      title: string | null;
      time_updated: number;
      time_created: number;
    }>;
    return rows.map((r) => ({
      source: 'opencode' as const,
      session_id: r.id,
      dirty_mark: String(r.time_updated || 0),
      time_updated: r.time_updated || 0,
      title: r.title || undefined,
      dirty_semantics: SEMANTICS.opencode,
    }));
  } catch (e) {
    console.warn('[listRefs] opencode SQL failed:', e);
    return [];
  }
}
