/**
 * ZCode CLI 本地数据访问
 * SQLite: ~/.zcode/cli/db/db.sqlite
 * 可选 jsonl: ~/.zcode/cli/rollout/model-io-sess_*.jsonl
 */

import fs from 'fs';
import path from 'path';
import { initSqliteDb, getSqliteDb, closeSqliteDb } from '../lib/sqlite';
import { resolveDataRoot, resolveHomeDir } from '../lib/home-paths';

/** ZCode DB：ZCODE_HOME → ~/.zcode/cli/db/db.sqlite */
export function resolveZcodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveHomeDir(env);
  const defaultDb = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
  return resolveDataRoot({
    envValue: env.ZCODE_HOME || env.ZCODE_DB_PATH,
    defaults: [defaultDb],
    normalize: (p) => {
      const abs = path.resolve(p);
      if (abs.endsWith('.sqlite') || abs.endsWith('.db')) return abs;
      // 指到 .zcode 或 cli 根时拼默认相对路径
      if (path.basename(abs) === 'zcode' || abs.endsWith(`${path.sep}.zcode`)) {
        return path.join(abs, 'cli', 'db', 'db.sqlite');
      }
      if (fs.existsSync(path.join(abs, 'db.sqlite'))) return path.join(abs, 'db.sqlite');
      return path.join(abs, 'cli', 'db', 'db.sqlite');
    },
    isOk: (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
  });
}

/** @deprecated 兼容旧引用；运行时请用 getZcodeDbPath() 以支持 env 注入 */
export const ZCODE_DB_PATH = resolveZcodeDbPath();
const SQLITE_INSTANCE = 'zcode';

// ==================== 类型 ====================

export type ZcodeSessionItem = {
  sessionId: string;
  projectId: string;
  parentId?: string;
  slug: string;
  directory: string;
  title: string;
  version: string;
  taskType?: string;
  createdAt: number;
  updatedAt: number;
  summaryAdditions?: number;
  summaryDeletions?: number;
  summaryFiles?: number;
  timeCompacting?: number;
  timeArchived?: number;
};

export type ZcodeModelUsage = {
  id: string;
  sessionId: string;
  assistantMessageId?: string;
  parentUserMessageId?: string;
  querySource: string;
  providerId: string;
  modelId: string;
  status: string;
  startedAt: number;
  firstTokenAt?: number;
  completedAt?: number;
  durationMs?: number;
  ttftMs?: number;
  finishReason?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  computedTotalTokens: number;
};

export type ZcodeMessageItem = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | string;
  timeCreated: number;
  timeUpdated: number;
  /** message.data 原始 JSON */
  data: any;
  parts: any[];
  /** 关联的 main_turn model_usage（优先取最新 completed） */
  modelUsage?: ZcodeModelUsage;
};

// ==================== DB ====================

export function getZcodeDbPath(): string {
  return resolveZcodeDbPath();
}

export async function initZcodeDb(): Promise<boolean> {
  const dbPath = getZcodeDbPath();
  if (!fs.existsSync(dbPath)) {
    console.warn(`[zcode-code] DB 不存在: ${dbPath}`);
    return false;
  }
  try {
    await initSqliteDb(SQLITE_INSTANCE, getZcodeDbPath, true);
    return true;
  } catch (e) {
    console.warn('[zcode-code] SQLite 打开失败:', e);
    return false;
  }
}

export function getZcodeDb() {
  return getSqliteDb(SQLITE_INSTANCE);
}

export function closeZcodeDb(): void {
  closeSqliteDb(SQLITE_INSTANCE);
}

async function ensureDb(): Promise<boolean> {
  try {
    getZcodeDb();
    return true;
  } catch {
    return initZcodeDb();
  }
}

// ==================== Provider 归一化 ====================

/** ZCode provider_id 常为 UUID，按 model 推断真实 provider */
export function normalizeZcodeModel(
  providerID?: string,
  modelID?: string,
): { providerID: string; modelID: string } {
  const rawModel = (modelID || 'unknown').trim();
  // MiniMax-M3[1m] → MiniMax-M3（计价表通常无 bracket 后缀）
  const cleanModel = rawModel.replace(/\[[^\]]*\]/g, '').trim() || rawModel;
  const isUuid = !providerID || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(providerID);

  if (!isUuid && providerID) {
    return { providerID, modelID: cleanModel };
  }

  const m = cleanModel.toLowerCase();
  // zcode 是 coding agent source，跑 deepseek 不应冒充官方 deepseek API 源（同 workbuddy 修正）
  if (m.includes('deepseek')) return { providerID: 'zcode', modelID: cleanModel };
  if (m.includes('minimax') || /^m\d/.test(m) || m.includes('m3')) {
    return { providerID: 'minimax', modelID: cleanModel };
  }
  if (m.includes('kimi') || m.includes('moonshot') || m.includes('k2')) {
    return { providerID: 'moonshotai', modelID: cleanModel };
  }
  if (m.includes('glm') || m.includes('zhipu')) return { providerID: 'zai', modelID: cleanModel };
  if (m.includes('grok')) return { providerID: 'xai', modelID: cleanModel };
  if (m.includes('claude') || m.includes('anthropic')) return { providerID: 'anthropic', modelID: cleanModel };
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) {
    return { providerID: 'openai', modelID: cleanModel };
  }
  if (m.includes('gemini')) return { providerID: 'google', modelID: cleanModel };
  if (m.includes('mimo')) return { providerID: 'opencode-go', modelID: cleanModel };
  return { providerID: 'zcode', modelID: cleanModel };
}

// ==================== Sessions ====================

export async function listZcodeSessions(): Promise<ZcodeSessionItem[]> {
  if (!(await ensureDb())) return [];
  const db = getZcodeDb();
  const rows = db.prepare(`
    SELECT
      id, project_id, parent_id, slug, directory, title, version,
      task_type, time_created, time_updated,
      summary_additions, summary_deletions, summary_files,
      time_compacting, time_archived
    FROM session
    ORDER BY time_updated DESC
  `).all() as any[];

  return rows.map((r): ZcodeSessionItem => ({
    sessionId: r.id,
    projectId: r.project_id || '',
    parentId: r.parent_id || undefined,
    slug: r.slug || r.id,
    directory: r.directory || '',
    title: (r.title || 'Untitled').trim() || 'Untitled',
    version: r.version || 'unknown',
    taskType: r.task_type || undefined,
    createdAt: r.time_created || 0,
    updatedAt: r.time_updated || 0,
    summaryAdditions: r.summary_additions ?? undefined,
    summaryDeletions: r.summary_deletions ?? undefined,
    summaryFiles: r.summary_files ?? undefined,
    timeCompacting: r.time_compacting ?? undefined,
    timeArchived: r.time_archived ?? undefined,
  }));
}

export async function getZcodeSession(sessionId: string): Promise<ZcodeSessionItem | null> {
  const list = await listZcodeSessions();
  return list.find((s) => s.sessionId === sessionId) || null;
}

// ==================== model_usage ====================

function rowToModelUsage(r: any): ZcodeModelUsage {
  return {
    id: r.id,
    sessionId: r.session_id,
    assistantMessageId: r.assistant_message_id || undefined,
    parentUserMessageId: r.parent_user_message_id || undefined,
    querySource: r.query_source || '',
    providerId: r.provider_id || '',
    modelId: r.model_id || '',
    status: r.status || '',
    startedAt: r.started_at || 0,
    firstTokenAt: r.first_token_at ?? undefined,
    completedAt: r.completed_at ?? undefined,
    durationMs: r.duration_ms ?? undefined,
    ttftMs: r.time_to_first_token_ms ?? undefined,
    finishReason: r.finish_reason || undefined,
    inputTokens: r.input_tokens || 0,
    outputTokens: r.output_tokens || 0,
    reasoningTokens: r.reasoning_tokens || 0,
    cacheWriteTokens: r.cache_creation_input_tokens || 0,
    cacheReadTokens: r.cache_read_input_tokens || 0,
    computedTotalTokens: r.computed_total_tokens || 0,
  };
}

/** 按 assistant_message_id 取最优 model_usage（main_turn 优先，completed 优先） */
export async function listZcodeModelUsageBySession(sessionId: string): Promise<Map<string, ZcodeModelUsage>> {
  if (!(await ensureDb())) return new Map();
  const db = getZcodeDb();
  const rows = db.prepare(`
    SELECT *
    FROM model_usage
    WHERE session_id = ?
    ORDER BY started_at ASC
  `).all(sessionId) as any[];

  const map = new Map<string, ZcodeModelUsage>();
  for (const r of rows) {
    const u = rowToModelUsage(r);
    if (!u.assistantMessageId) continue;
    const prev = map.get(u.assistantMessageId);
    if (!prev) {
      map.set(u.assistantMessageId, u);
      continue;
    }
    // 优先 main_turn + completed
    const score = (x: ZcodeModelUsage) =>
      (x.querySource === 'main_turn' ? 10 : 0) + (x.status === 'completed' ? 5 : 0) + (x.completedAt || 0) / 1e15;
    if (score(u) >= score(prev)) map.set(u.assistantMessageId, u);
  }
  return map;
}

// ==================== Messages + Parts ====================

export async function listZcodeMessages(sessionId: string): Promise<ZcodeMessageItem[]> {
  if (!(await ensureDb())) return [];
  const db = getZcodeDb();

  const messageRows = db.prepare(`
    SELECT id, session_id, time_created, time_updated, data, sequence
    FROM message
    WHERE session_id = ?
    ORDER BY COALESCE(sequence, 999999), time_created ASC, id ASC
  `).all(sessionId) as any[];

  const partRows = db.prepare(`
    SELECT id, message_id, session_id, time_created, time_updated, data, sequence
    FROM part
    WHERE session_id = ?
    ORDER BY COALESCE(sequence, 999999), time_created ASC, id ASC
  `).all(sessionId) as any[];

  const partsByMsg = new Map<string, any[]>();
  for (const p of partRows) {
    let data: any;
    try {
      data = typeof p.data === 'string' ? JSON.parse(p.data) : p.data;
    } catch {
      data = {};
    }
    const part = {
      ...data,
      id: p.id,
      sessionID: p.session_id,
      messageID: p.message_id,
    };
    const arr = partsByMsg.get(p.message_id) || [];
    arr.push(part);
    partsByMsg.set(p.message_id, arr);
  }

  const usageMap = await listZcodeModelUsageBySession(sessionId);

  return messageRows.map((row): ZcodeMessageItem => {
    let data: any = {};
    try {
      data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch {
      data = {};
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      role: data.role || 'user',
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      data,
      parts: partsByMsg.get(row.id) || [],
      modelUsage: usageMap.get(row.id),
    };
  });
}
