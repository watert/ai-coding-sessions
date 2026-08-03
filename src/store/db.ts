/**
 * 缓存库初始化：mkdirp + schema + WAL + 版本
 */

import fs from 'node:fs';
import path from 'node:path';
import { initSqliteDb, getSqliteDb, closeSqliteDb } from '../lib/sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';
import { resolveStorePaths, type StorePaths } from './paths';

export const STORE_INSTANCE_ID = 'ai-coding-sessions-cache';

let currentPaths: StorePaths | null = null;

export function getStorePaths(): StorePaths {
  if (!currentPaths) currentPaths = resolveStorePaths();
  return currentPaths;
}

export async function initStoreDb(opts?: {
  dbPath?: string;
  metaPath?: string;
}): Promise<StorePaths> {
  const paths = resolveStorePaths(opts);
  currentPaths = paths;

  const dir = path.dirname(paths.dbPath);
  fs.mkdirSync(dir, { recursive: true });

  await initSqliteDb(STORE_INSTANCE_ID, () => paths.dbPath, false);
  const db = getSqliteDb(STORE_INSTANCE_ID);

  // WAL + 忙等待，兼顾 PM2 / CLI 并发
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA synchronous = NORMAL;');
  } catch (e) {
    console.warn('[store] pragma 设置失败:', e);
  }

  db.exec(SCHEMA_SQL);
  migrateIfNeeded(db);

  return paths;
}

function migrateIfNeeded(db: any): void {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  const cur = row ? Number(row.value) : 0;
  if (cur >= SCHEMA_VERSION) return;

  // v0 → v1：仅建表（SCHEMA_SQL 已 IF NOT EXISTS）
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run('schema_version', String(SCHEMA_VERSION));
}

export function getStoreDb(): any {
  return getSqliteDb(STORE_INSTANCE_ID);
}

export function closeStoreDb(): void {
  closeSqliteDb(STORE_INSTANCE_ID);
  currentPaths = null;
}
