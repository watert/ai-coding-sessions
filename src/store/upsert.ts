/**
 * sessions / prompts / usage_by_day 写入
 */

import type { UnifiedSessionInfo } from '../sources/types';
import type { SourceId } from './schema';
import { getStoreDb } from './db';
import {
  contentFingerprint,
  extractPrompts,
  extractUsageByModel,
  stripPricingForPayload,
} from './fingerprint';

export interface UpsertResult {
  source: SourceId;
  session_id: string;
  action: 'insert' | 'update' | 'skip';
  fingerprint: string;
}

export function getCachedFingerprint(source: SourceId, sessionId: string): string | null {
  const db = getStoreDb();
  const row = db
    .prepare('SELECT content_fingerprint FROM sessions WHERE source = ? AND session_id = ?')
    .get(source, sessionId) as { content_fingerprint: string | null } | undefined;
  return row?.content_fingerprint ?? null;
}

export function getCachedDirtyMark(source: SourceId, sessionId: string): string | null {
  const db = getStoreDb();
  const row = db
    .prepare('SELECT dirty_mark FROM sessions WHERE source = ? AND session_id = ?')
    .get(source, sessionId) as { dirty_mark: string | null } | undefined;
  return row?.dirty_mark ?? null;
}

/**
 * 写入单 session（同一事务：投影列 + payload + prompts 重写 + usage_by_day 重写）
 */
export function upsertSession(
  session: UnifiedSessionInfo,
  opts?: { dirty_mark?: string | null; force?: boolean },
): UpsertResult {
  const source = session.source as SourceId;
  const session_id = session.id;
  const fp = contentFingerprint(session);
  const existing = getCachedFingerprint(source, session_id);

  if (!opts?.force && existing === fp) {
    // 内容未变：仍刷新 dirty_mark/synced_at，避免 heartbeat 脏标记反复触发全量 sync
    const db = getStoreDb();
    db.prepare(
      `UPDATE sessions SET orphaned_at = NULL, dirty_mark = COALESCE(?, dirty_mark), synced_at = ?
       WHERE source = ? AND session_id = ?`,
    ).run(opts?.dirty_mark ?? null, Date.now(), source, session_id);
    return { source, session_id, action: 'skip', fingerprint: fp };
  }

  const db = getStoreDb();
  const now = Date.now();
  const usage_by_model = extractUsageByModel(session);
  const payloadObj = stripPricingForPayload(session);
  const payload = JSON.stringify(payloadObj);
  const meta = session.meta ? JSON.stringify(session.meta) : null;
  const prompts = extractPrompts(session);

  const lastActive =
    session.last_active_at_iso
      ? Date.parse(session.last_active_at_iso)
      : typeof session.time_updated === 'number'
        ? session.time_updated
        : null;
  const lastActiveMs =
    lastActive != null && Number.isFinite(lastActive) ? lastActive : session.time_updated || null;

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (
        source, session_id, title, project, cwd,
        time_created, time_updated, last_active_at, status, models,
        input_tokens, output_tokens, total_tokens, usage_by_model, payload, meta,
        dirty_mark, content_fingerprint, orphaned_at, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(source, session_id) DO UPDATE SET
        title = excluded.title,
        project = excluded.project,
        cwd = excluded.cwd,
        time_created = excluded.time_created,
        time_updated = excluded.time_updated,
        last_active_at = excluded.last_active_at,
        status = excluded.status,
        models = excluded.models,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        total_tokens = excluded.total_tokens,
        usage_by_model = excluded.usage_by_model,
        payload = excluded.payload,
        meta = excluded.meta,
        dirty_mark = excluded.dirty_mark,
        content_fingerprint = excluded.content_fingerprint,
        orphaned_at = NULL,
        synced_at = excluded.synced_at`,
    ).run(
      source,
      session_id,
      session.title ?? null,
      session.project_id ?? session.project_name ?? null,
      session.directory ?? session.project_worktree ?? null,
      session.time_created ?? null,
      session.time_updated ?? null,
      lastActiveMs,
      session.session_status ?? null,
      session.models_used ?? null,
      session.total_input ?? null,
      session.total_output ?? null,
      session.total_tokens ?? null,
      JSON.stringify(usage_by_model),
      payload,
      meta,
      opts?.dirty_mark ?? null,
      fp,
      now,
    );

    // prompts 全量重写
    db.prepare('DELETE FROM prompts WHERE source = ? AND session_id = ?').run(source, session_id);
    const insPrompt = db.prepare(
      `INSERT INTO prompts (source, session_id, idx, created_at, text) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const p of prompts) {
      insPrompt.run(source, session_id, p.idx, p.created_at, p.text);
    }

    // usage_by_day 全量重写
    db.prepare('DELETE FROM usage_by_day WHERE source = ? AND session_id = ?').run(source, session_id);
    const insDay = db.prepare(
      `INSERT INTO usage_by_day (
        source, session_id, day, input_tokens, output_tokens,
        cache_read, cache_write, tokens, messages, usage_by_model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const day of session.usage_by_day || []) {
      const dayModels = (day.byModel || []).map((m) => {
        const parts = (m.modelKey || '').split('/');
        return {
          provider: parts.length > 1 ? parts[0] : 'unknown',
          model: parts.length > 1 ? parts.slice(1).join('/') : m.modelKey || 'unknown',
          modelKey: m.modelKey,
          input: m.input || 0,
          output: m.output || 0,
          cache_read: m.cacheRead || 0,
          cache_write: m.cacheWrite || 0,
          tokens: m.tokens || 0,
        };
      });
      insDay.run(
        source,
        session_id,
        day.date,
        day.input || 0,
        day.output || 0,
        day.cacheRead || 0,
        day.cacheWrite || 0,
        day.tokens || 0,
        null,
        JSON.stringify(dayModels),
      );
    }
  });

  run();
  return {
    source,
    session_id,
    action: existing ? 'update' : 'insert',
    fingerprint: fp,
  };
}

/** full sync：标记源侧消失的 session 为 orphan（不物理删） */
export function markOrphans(source: SourceId, liveIds: Set<string>, now = Date.now()): number {
  const db = getStoreDb();
  const rows = db
    .prepare(
      `SELECT session_id FROM sessions WHERE source = ? AND orphaned_at IS NULL`,
    )
    .all(source) as Array<{ session_id: string }>;

  let n = 0;
  const mark = db.prepare(
    `UPDATE sessions SET orphaned_at = ? WHERE source = ? AND session_id = ?`,
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!liveIds.has(r.session_id)) {
        mark.run(now, source, r.session_id);
        n++;
      }
    }
  });
  tx();
  return n;
}

export function countStats(): {
  session_count: number;
  prompt_count: number;
  token_total: number;
  orphan_count: number;
} {
  const db = getStoreDb();
  const s = db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number };
  const p = db.prepare('SELECT COUNT(*) AS c FROM prompts').get() as { c: number };
  const t = db
    .prepare('SELECT COALESCE(SUM(total_tokens), 0) AS c FROM sessions WHERE orphaned_at IS NULL')
    .get() as { c: number };
  const o = db
    .prepare('SELECT COUNT(*) AS c FROM sessions WHERE orphaned_at IS NOT NULL')
    .get() as { c: number };
  return {
    session_count: s.c,
    prompt_count: p.c,
    token_total: t.c,
    orphan_count: o.c,
  };
}
