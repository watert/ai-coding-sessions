/**
 * 缓存层 optional title overlay：custom_title 由 Agent/用户写入，sync 不覆盖。
 * displayTitle = custom_title || source_title
 */

import type { UnifiedSessionDetail, UnifiedSessionInfo } from '../sources/types';
import { isSourceId, type SourceId } from './schema';
import { getStoreDb, isStoreDbReady } from './db';

export const CUSTOM_TITLE_MAX_LEN = 200;

const WEAK_EXACT = new Set(['untitled', 'new session', 'new session.']);

/** 源侧占位标题：Untitled / New Session / New session - ISO */
export function isWeakTitle(title?: string | null): boolean {
  const t = String(title || '').trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  if (WEAK_EXACT.has(lower)) return true;
  if (/^new session\s*-\s*\d{4}-\d{2}-\d{2}t/i.test(t)) return true;
  return false;
}

export function normalizeCustomTitle(raw?: string | null): string | null {
  if (raw == null) return null;
  const t = String(raw).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > CUSTOM_TITLE_MAX_LEN ? t.slice(0, CUSTOM_TITLE_MAX_LEN) : t;
}

export function overlaySessionFields(
  session: UnifiedSessionInfo,
  customTitle?: string | null,
): UnifiedSessionInfo {
  const sourceTitle = session.source_title ?? session.title;
  const custom = normalizeCustomTitle(customTitle);
  return {
    ...session,
    title: custom || sourceTitle,
    source_title: sourceTitle,
    custom_title: custom,
    title_is_custom: Boolean(custom),
  };
}

export interface SetSessionTitleResult {
  ok: boolean;
  action: 'set' | 'clear' | 'skip' | 'not_found';
  source: SourceId;
  session_id: string;
  custom_title: string | null;
  source_title: string | null;
  title: string | null;
  title_is_custom: boolean;
}

export function getCustomTitle(source: SourceId, sessionId: string): string | null {
  if (!isStoreDbReady()) return null;
  const row = getStoreDb()
    .prepare(`SELECT custom_title FROM sessions WHERE source = ? AND session_id = ?`)
    .get(source, sessionId) as { custom_title: string | null } | undefined;
  return normalizeCustomTitle(row?.custom_title);
}

export function loadCustomTitleMap(): Map<string, string> {
  const map = new Map<string, string>();
  if (!isStoreDbReady()) return map;
  const rows = getStoreDb()
    .prepare(
      `SELECT source, session_id, custom_title FROM sessions
       WHERE custom_title IS NOT NULL AND TRIM(custom_title) != ''`,
    )
    .all() as Array<{ source: string; session_id: string; custom_title: string }>;
  for (const r of rows) {
    const t = normalizeCustomTitle(r.custom_title);
    if (t) map.set(`${r.source}:${r.session_id}`, t);
  }
  return map;
}

export function applyCustomTitle(session: UnifiedSessionInfo): UnifiedSessionInfo {
  const source = session.source;
  if (!isSourceId(source)) return overlaySessionFields(session, null);
  return overlaySessionFields(session, getCustomTitle(source, session.id));
}

export function applyCustomTitles(sessions: UnifiedSessionInfo[]): UnifiedSessionInfo[] {
  if (!sessions.length) return sessions;
  const map = loadCustomTitleMap();
  return sessions.map((s) => overlaySessionFields(s, map.get(`${s.source}:${s.id}`) ?? null));
}

/** 不隐式 init 默认库，避免测试/CLI 误开生产路径 */
export async function overlaySessionDetail<T extends UnifiedSessionDetail | null>(
  detail: T,
): Promise<T> {
  if (!detail || !isStoreDbReady()) return detail;
  const source = detail.info?.source;
  const id = detail.info?.id;
  const custom = isSourceId(String(source)) && id ? getCustomTitle(source as SourceId, id) : null;
  return { ...detail, info: overlaySessionFields(detail.info, custom) };
}

export function setSessionTitle(
  source: SourceId,
  sessionId: string,
  title: string | null,
): SetSessionTitleResult {
  const db = getStoreDb();
  const row = db
    .prepare(`SELECT title, custom_title, payload FROM sessions WHERE source = ? AND session_id = ?`)
    .get(source, sessionId) as
    | { title: string | null; custom_title: string | null; payload: string }
    | undefined;

  if (!row) {
    return {
      ok: false,
      action: 'not_found',
      source,
      session_id: sessionId,
      custom_title: null,
      source_title: null,
      title: null,
      title_is_custom: false,
    };
  }

  let sourceTitle = row.title;
  try {
    const payload = JSON.parse(row.payload) as UnifiedSessionInfo;
    sourceTitle = payload.source_title ?? payload.title ?? row.title;
  } catch {
    /* keep row.title */
  }

  const next = normalizeCustomTitle(title);
  const prev = normalizeCustomTitle(row.custom_title);
  if (next === prev) {
    return {
      ok: true,
      action: 'skip',
      source,
      session_id: sessionId,
      custom_title: next,
      source_title: sourceTitle,
      title: next || sourceTitle,
      title_is_custom: Boolean(next),
    };
  }

  db.prepare(
    `UPDATE sessions SET custom_title = ?, custom_title_at = ? WHERE source = ? AND session_id = ?`,
  ).run(next, next ? Date.now() : null, source, sessionId);

  return {
    ok: true,
    action: next ? 'set' : 'clear',
    source,
    session_id: sessionId,
    custom_title: next,
    source_title: sourceTitle,
    title: next || sourceTitle,
    title_is_custom: Boolean(next),
  };
}
