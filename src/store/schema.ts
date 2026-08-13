/**
 * 缓存库 schema（M3）
 * - 无 sync_state 表：同步元信息走 meta JSON
 * - detail/messages 不缓存；prompts 完整落库
 */

export const SCHEMA_VERSION = 2;

/** sessions / prompts / usage_by_day / schema_meta */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT,
  custom_title TEXT,
  custom_title_at INTEGER,
  project TEXT,
  cwd TEXT,
  time_created INTEGER,
  time_updated INTEGER,
  last_active_at INTEGER,
  status TEXT,
  models TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  usage_by_model TEXT,
  payload TEXT NOT NULL,
  dirty_mark TEXT,
  content_fingerprint TEXT,
  orphaned_at INTEGER,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (source, session_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(last_active_at);
CREATE INDEX IF NOT EXISTS idx_sessions_source_updated ON sessions(source, time_updated);
CREATE INDEX IF NOT EXISTS idx_sessions_orphan ON sessions(orphaned_at);

CREATE TABLE IF NOT EXISTS usage_by_day (
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  day TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  tokens INTEGER,
  messages INTEGER,
  usage_by_model TEXT,
  PRIMARY KEY (source, session_id, day)
);

CREATE INDEX IF NOT EXISTS idx_usage_by_day_day ON usage_by_day(day);
CREATE INDEX IF NOT EXISTS idx_usage_by_day_source ON usage_by_day(source, day);

CREATE TABLE IF NOT EXISTS prompts (
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  created_at INTEGER,
  text TEXT NOT NULL,
  PRIMARY KEY (source, session_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(source, session_id);
`;

export type SourceId =
  | 'claude'
  | 'opencode'
  | 'kimi'
  | 'grok'
  | 'codex'
  | 'zcode'
  | 'workbuddy'
  | 'cursor';

export const ALL_SOURCES: SourceId[] = [
  'claude',
  'opencode',
  'kimi',
  'grok',
  'codex',
  'zcode',
  'workbuddy',
  'cursor',
];

export function isSourceId(s: string): s is SourceId {
  return (ALL_SOURCES as string[]).includes(s);
}

/** 分模型用量（缓存列 / 无 pricing） */
export interface UsageByModelEntry {
  provider: string;
  model: string;
  /** 兼容 pricing.details.modelKey：provider/model */
  modelKey?: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning?: number;
  tokens?: number;
}

export interface SessionPromptRow {
  idx: number;
  created_at: number | null;
  text: string;
}

export interface CachedSessionRow {
  source: SourceId;
  session_id: string;
  title: string | null;
  custom_title: string | null;
  custom_title_at: number | null;
  project: string | null;
  cwd: string | null;
  time_created: number | null;
  time_updated: number | null;
  last_active_at: number | null;
  status: string | null;
  models: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  usage_by_model: string | null;
  payload: string;
  dirty_mark: string | null;
  content_fingerprint: string | null;
  orphaned_at: number | null;
  synced_at: number;
}
