/**
 * 同步元信息（独立 JSON，不进 SQLite）
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SourceId } from './schema';
import { resolveStorePaths } from './paths';

export interface SourceSyncMeta {
  last_sync_at: number | null;
  last_full_sync_at?: number | null;
  session_count?: number;
  upserted?: number;
  skipped?: number;
  orphaned?: number;
  error?: string | null;
  /** 该源 listRefs / convert 耗时 ms */
  duration_ms?: number;
}

export interface StoreMeta {
  schema_version: number;
  package_version?: string;
  last_sync_at: number | null;
  last_full_sync_at: number | null;
  sources: Partial<Record<SourceId, SourceSyncMeta>>;
  stats?: {
    session_count?: number;
    prompt_count?: number;
    token_total?: number;
    orphan_count?: number;
  };
  /** 上次对账摘要 */
  last_reconcile?: {
    at: number;
    ok: boolean;
    summary?: string;
  };
}

export function emptyMeta(): StoreMeta {
  return {
    schema_version: 1,
    last_sync_at: null,
    last_full_sync_at: null,
    sources: {},
  };
}

export function loadMeta(metaPath?: string): StoreMeta {
  const p = metaPath || resolveStorePaths().metaPath;
  try {
    if (!fs.existsSync(p)) return emptyMeta();
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as StoreMeta;
    return {
      ...emptyMeta(),
      ...parsed,
      sources: parsed.sources || {},
    };
  } catch (e) {
    console.warn('[store/meta] 读取失败，使用空 meta:', e);
    return emptyMeta();
  }
}

export function saveMeta(meta: StoreMeta, metaPath?: string): void {
  const p = metaPath || resolveStorePaths().metaPath;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, p);
}
