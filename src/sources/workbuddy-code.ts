/**
 * WorkBuddy 本地数据访问
 * SQLite: ~/.workbuddy/workbuddy.db (sessions / session_usage)
 * JSONL:  ~/.workbuddy/projects/<dir-hash>/<sessionId>.jsonl
 * 真·per-call credit/token 在 jsonl providerData.rawUsage
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { initSqliteDb, getSqliteDb, closeSqliteDb } from '../lib/sqlite';

const HOMEDIR = os.homedir();
export const WORKBUDDY_ROOT = path.join(HOMEDIR, '.workbuddy');
export const WORKBUDDY_DB_PATH = path.join(WORKBUDDY_ROOT, 'workbuddy.db');
export const WORKBUDDY_PROJECTS_DIR = path.join(WORKBUDDY_ROOT, 'projects');
const SQLITE_INSTANCE = 'workbuddy';

// ==================== 类型 ====================

export type WorkbuddySessionItem = {
  sessionId: string;
  cwd: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt?: number;
  model?: string;
  mode?: string;
  projectId?: string;
  deletedAt?: number;
  /** session_usage.used — context 占用近似 */
  contextUsed?: number;
  /** session_usage.size — context window */
  contextSize?: number;
  /** DB 累计 credits（滞后、单 key） */
  dbCredits?: number;
  /** jsonl 路径（若已定位） */
  jsonlPath?: string;
};

export type WorkbuddyRawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  credit?: number;
  prompt_tokens_details?: { cached_tokens?: number; reasoning_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number; cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  prompt_cache_write_tokens?: number;
  completion_thinking_tokens?: number;
  cached_tokens?: number;
};

export type WorkbuddyJsonlEvent = {
  id?: string;
  type: string;
  role?: string;
  name?: string;
  callId?: string;
  parentId?: string;
  timestamp?: number;
  sessionId?: string;
  cwd?: string;
  status?: string;
  content?: any;
  arguments?: string | Record<string, any>;
  output?: any;
  rawContent?: any;
  providerData?: {
    messageId?: string;
    model?: string;
    requestModelId?: string;
    requestModelName?: string;
    conversationRequestId?: string;
    traceId?: string;
    agent?: string;
    reasoning?: string;
    rawUsage?: WorkbuddyRawUsage;
    usage?: any;
    [k: string]: any;
  };
  [k: string]: any;
};

// ==================== DB ====================

export function getWorkbuddyDbPath(): string {
  return WORKBUDDY_DB_PATH;
}

export async function initWorkbuddyDb(): Promise<boolean> {
  if (!fs.existsSync(WORKBUDDY_DB_PATH)) {
    console.warn(`[workbuddy-code] DB 不存在: ${WORKBUDDY_DB_PATH}`);
    return false;
  }
  try {
    await initSqliteDb(SQLITE_INSTANCE, getWorkbuddyDbPath, true);
    return true;
  } catch (e) {
    console.warn('[workbuddy-code] SQLite 打开失败:', e);
    return false;
  }
}

export function getWorkbuddyDb() {
  return getSqliteDb(SQLITE_INSTANCE);
}

/** 读取 WorkBuddy 默认工作区路径列表（workspaces 表 = "空间"，对应 UI 里的空间区） */
export function listWorkbuddyWorkspacePaths(): string[] {
  const db = getSqliteDb(SQLITE_INSTANCE);
  try {
    const rows = db.prepare(`SELECT path FROM workspaces`).all() as { path: string }[];
    return rows.map((r) => r.path).filter(Boolean);
  } catch {
    return [];
  }
}

export function closeWorkbuddyDb(): void {
  closeSqliteDb(SQLITE_INSTANCE);
}

async function ensureDb(): Promise<boolean> {
  try {
    getWorkbuddyDb();
    return true;
  } catch {
    return initWorkbuddyDb();
  }
}

// ==================== Model 归一化 ====================

/** WorkBuddy model id → provider/model（计价用） */
export function normalizeWorkbuddyModel(
  rawModel?: string,
  requestModelName?: string,
): { providerID: string; modelID: string } {
  let raw = (rawModel || requestModelName || 'unknown').trim();
  // custom-local:MiniMax-M3 → MiniMax-M3
  if (raw.startsWith('custom-local:')) raw = raw.slice('custom-local:'.length);
  const clean = raw.replace(/\[[^\]]*\]/g, '').trim() || raw;
  const m = clean.toLowerCase();

  if (m === 'auto') return { providerID: 'workbuddy', modelID: 'auto' };
  if (m === 'hy3' || m.includes('hunyuan')) return { providerID: 'workbuddy', modelID: clean };
  if (m.includes('minimax') || m === 'm3' || /^minimax/.test(m)) {
    // minimax-m3 → MiniMax-M3
    const id = /minimax-?m3/i.test(clean) ? 'MiniMax-M3' : clean;
    return { providerID: 'minimax', modelID: id };
  }
  if (m.includes('deepseek')) return { providerID: 'deepseek', modelID: clean };
  if (m.includes('glm') || m.includes('zhipu')) return { providerID: 'zai', modelID: clean };
  if (m.includes('kimi') || m.includes('moonshot') || m.includes('k2')) {
    return { providerID: 'moonshotai', modelID: clean };
  }
  if (m.includes('claude') || m.includes('anthropic')) return { providerID: 'anthropic', modelID: clean };
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) {
    return { providerID: 'openai', modelID: clean };
  }
  if (m.includes('gemini')) return { providerID: 'google', modelID: clean };
  if (m.includes('grok')) return { providerID: 'xai', modelID: clean };
  return { providerID: 'workbuddy', modelID: clean };
}

// ==================== JSONL 路径 ====================

/**
 * sessionId → jsonl 绝对路径。
 * 注意：WorkBuddy 新开会话会新增 projects/<dir>/<sid>.jsonl，
 * 进程内长期缓存会导致 list 拿到 session 但读不到 jsonl → total_tokens=0 → 前端默认隐藏。
 * 因此 list 每次重建；find miss 时也重建一次。
 */
let jsonlIndex: Map<string, string> | null = null;

function buildJsonlIndex(): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(WORKBUDDY_PROJECTS_DIR)) return map;
  try {
    const dirs = fs.readdirSync(WORKBUDDY_PROJECTS_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dirPath = path.join(WORKBUDDY_PROJECTS_DIR, d.name);
      let files: string[];
      try {
        files = fs.readdirSync(dirPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const sid = f.slice(0, -'.jsonl'.length);
        map.set(sid, path.join(dirPath, f));
      }
    }
  } catch (e) {
    console.warn('[workbuddy-code] 扫描 projects 失败:', e);
  }
  return map;
}

export function findWorkbuddyJsonlPath(sessionId: string): string | undefined {
  if (!jsonlIndex) jsonlIndex = buildJsonlIndex();
  let p = jsonlIndex.get(sessionId);
  if (!p) {
    // 缓存 miss：可能是新 session，重建后再查
    jsonlIndex = buildJsonlIndex();
    p = jsonlIndex.get(sessionId);
  }
  return p;
}

/** 强制重建 jsonl 索引（session 新增后） */
export function invalidateWorkbuddyJsonlIndex(): void {
  jsonlIndex = null;
}

// ==================== Sessions ====================

function parseDbCredits(creditJson: string | null | undefined): number | undefined {
  if (!creditJson) return undefined;
  try {
    const obj = typeof creditJson === 'string' ? JSON.parse(creditJson) : creditJson;
    if (!obj || typeof obj !== 'object') return undefined;
    const vals = Object.values(obj).map(Number).filter((n) => Number.isFinite(n));
    if (!vals.length) return undefined;
    return vals[vals.length - 1];
  } catch {
    return undefined;
  }
}

export async function listWorkbuddySessions(): Promise<WorkbuddySessionItem[]> {
  if (!(await ensureDb())) return [];
  const db = getWorkbuddyDb();

  const rows = db.prepare(`
    SELECT
      s.id, s.cwd, s.title, s.custom_title, s.status,
      s.created_at, s.updated_at, s.last_activity_at, s.deleted_at,
      s.model, s.mode, s.project_id,
      u.used as usage_used, u.size as usage_size, u.credit_json
    FROM sessions s
    LEFT JOIN session_usage u ON u.session_id = s.id
    WHERE s.deleted_at IS NULL OR s.deleted_at = 0
    ORDER BY COALESCE(s.last_activity_at, s.updated_at) DESC
  `).all() as any[];

  // 每次 list 重建：避免长驻进程漏掉新 jsonl，导致 tokens=0 被前端滤掉
  jsonlIndex = buildJsonlIndex();

  return rows.map((r): WorkbuddySessionItem => {
    const title = (r.custom_title || r.title || 'Untitled').trim() || 'Untitled';
    return {
      sessionId: r.id,
      cwd: r.cwd || '',
      title,
      status: r.status || '',
      createdAt: r.created_at || 0,
      updatedAt: r.last_activity_at || r.updated_at || 0,
      lastActivityAt: r.last_activity_at || undefined,
      model: r.model || undefined,
      mode: r.mode || undefined,
      projectId: r.project_id || undefined,
      deletedAt: r.deleted_at || undefined,
      contextUsed: r.usage_used ?? undefined,
      contextSize: r.usage_size ?? undefined,
      dbCredits: parseDbCredits(r.credit_json),
      jsonlPath: jsonlIndex!.get(r.id),
    };
  });
}

export async function getWorkbuddySession(sessionId: string): Promise<WorkbuddySessionItem | null> {
  const list = await listWorkbuddySessions();
  return list.find((s) => s.sessionId === sessionId) || null;
}

// ==================== JSONL 事件 ====================

export function readWorkbuddyJsonl(sessionId: string, jsonlPath?: string): WorkbuddyJsonlEvent[] {
  const p = jsonlPath || findWorkbuddyJsonlPath(sessionId);
  if (!p || !fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8');
  const events: WorkbuddyJsonlEvent[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      // skip bad line
    }
  }
  return events;
}

/** 从 rawUsage 提取统一 token 结构 */
export function tokensFromRawUsage(ru: WorkbuddyRawUsage | undefined | null): {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  credit?: number;
} | undefined {
  if (!ru) return undefined;
  const prompt = ru.prompt_tokens || 0;
  const completion = ru.completion_tokens || 0;
  const cacheRead =
    ru.prompt_tokens_details?.cached_tokens
    ?? ru.prompt_cache_hit_tokens
    ?? ru.cache_read_input_tokens
    ?? ru.cached_tokens
    ?? 0;
  const cacheWrite =
    ru.prompt_cache_write_tokens
    ?? ru.cache_creation_input_tokens
    ?? 0;
  const reasoning =
    ru.completion_tokens_details?.reasoning_tokens
    ?? ru.completion_thinking_tokens
    ?? 0;
  // prompt 通常含 cache；input = non-cache
  const input = Math.max(0, (ru.prompt_cache_miss_tokens != null
    ? ru.prompt_cache_miss_tokens
    : prompt - cacheRead));
  const total = ru.total_tokens || (input + cacheRead + completion);
  return {
    input,
    output: completion,
    reasoning,
    cacheRead,
    cacheWrite,
    total,
    credit: typeof ru.credit === 'number' ? ru.credit : undefined,
  };
}
