/**
 * DB / meta 路径（可配置，默认 ~/data/…）
 */

import os from 'node:os';
import path from 'node:path';

export interface StorePaths {
  dbPath: string;
  metaPath: string;
}

const DEFAULT_DIR = path.join(os.homedir(), 'data');

export function resolveStorePaths(opts?: {
  dbPath?: string;
  metaPath?: string;
}): StorePaths {
  const dbPath =
    opts?.dbPath ||
    process.env.AI_CODING_SESSIONS_DB ||
    path.join(DEFAULT_DIR, 'ai-coding-sessions.sqlite');
  const metaPath =
    opts?.metaPath ||
    process.env.AI_CODING_SESSIONS_META ||
    path.join(DEFAULT_DIR, 'ai-coding-sessions.meta.json');
  return { dbPath, metaPath };
}
