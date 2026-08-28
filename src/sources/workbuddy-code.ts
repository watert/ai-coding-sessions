/**
 * WorkBuddy 本地数据访问
 * SQLite: ~/.workbuddy/workbuddy.db (sessions / session_usage)
 * JSONL:  ~/.workbuddy/projects/<dir-hash>/<sessionId>.jsonl
 * 真·per-call credit/token 在 jsonl providerData.rawUsage
 */

import fs from 'fs';
import path from 'path';
import { initSqliteDb, getSqliteDb, closeSqliteDb } from '../lib/sqlite';
import { splitLines } from '../lib/jsonl-cache';
import { resolveDataRoot, resolveHomeDir } from '../lib/home-paths';

/** WorkBuddy 根：WORKBUDDY_HOME → ~/.workbuddy */
export function resolveWorkbuddyRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveHomeDir(env);
  return resolveDataRoot({
    envValue: env.WORKBUDDY_HOME,
    defaults: [path.join(home, '.workbuddy')],
    isOk: (p) => {
      try {
        return (
          fs.existsSync(path.join(p, 'workbuddy.db')) ||
          fs.existsSync(path.join(p, 'projects')) ||
          fs.existsSync(p)
        );
      } catch {
        return false;
      }
    },
  });
}

/** @deprecated 兼容旧引用；运行时请用 resolveWorkbuddyRoot() / getWorkbuddyDbPath() */
export const WORKBUDDY_ROOT = resolveWorkbuddyRoot();
export const WORKBUDDY_DB_PATH = path.join(WORKBUDDY_ROOT, 'workbuddy.db');
export const WORKBUDDY_PROJECTS_DIR = path.join(WORKBUDDY_ROOT, 'projects');

function workbuddyRoot(): string {
  return resolveWorkbuddyRoot();
}
function workbuddyDbPath(): string {
  return path.join(workbuddyRoot(), 'workbuddy.db');
}
function workbuddyProjectsDir(): string {
  return path.join(workbuddyRoot(), 'projects');
}
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
  return workbuddyDbPath();
}

export async function initWorkbuddyDb(): Promise<boolean> {
  const dbPath = workbuddyDbPath();
  if (!fs.existsSync(dbPath)) {
    console.warn(`[workbuddy-code] DB 不存在: ${dbPath}`);
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
  // deepseek 归到 workbuddy 前缀：workbuddy 是 coding agent source，用它跑 deepseek 不应冒充官方 deepseek API 源
  if (m.includes('deepseek')) return { providerID: 'workbuddy', modelID: clean };
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
  const projectsDir = workbuddyProjectsDir();
  if (!fs.existsSync(projectsDir)) return map;
  try {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dirPath = path.join(projectsDir, d.name);
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
  for (const line of splitLines(text)) {
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

// ==================== Subagent（Agent tool） ====================

/**
 * 虚拟 session id：`<rootSessionId>__<agentId>`
 * agentId 形如 `agent-200abb04`（WorkBuddy subagents 目录名）
 */
const WORKBUDDY_SUBAGENT_ID_SEP = '__';

export type WorkbuddySubagentMeta = {
  virtualSessionId: string;
  parentSessionId: string;
  agentId: string;
  toolCallId: string;
  /** 并发分组：同一 assistant messageId 下的 Agent 调用算同一轮 */
  spawnGroupId?: string;
  subagentType: string;
  description?: string;
  promptPreview?: string;
  outcome?: string;
  /** 子 agent jsonl 绝对路径 */
  jsonlPath?: string;
};

export function parseWorkbuddyVirtualSessionId(
  sessionId: string,
): { rootSessionId: string; agentId?: string } {
  const idx = sessionId.indexOf(WORKBUDDY_SUBAGENT_ID_SEP);
  if (idx === -1) return { rootSessionId: sessionId };
  return {
    rootSessionId: sessionId.slice(0, idx),
    agentId: sessionId.slice(idx + WORKBUDDY_SUBAGENT_ID_SEP.length),
  };
}

export function buildWorkbuddySubagentSessionId(
  rootSessionId: string,
  agentId: string,
): string {
  return `${rootSessionId}${WORKBUDDY_SUBAGENT_ID_SEP}${agentId}`;
}

/** 从 function_call_result 提取 agent id */
export function parseWorkbuddyAgentIdFromResult(
  ev: WorkbuddyJsonlEvent | { output?: unknown; providerData?: WorkbuddyJsonlEvent['providerData'] },
): string | undefined {
  const pd = ev.providerData || {};
  const fromMeta = (pd as any).toolResult?.subAgent?.sessionId;
  if (typeof fromMeta === 'string' && fromMeta.startsWith('agent-')) return fromMeta;

  const out = (ev as any).output;
  let text = '';
  if (typeof out === 'string') text = out;
  else if (out && typeof out === 'object') {
    if (typeof out.text === 'string') text = out.text;
    else if (typeof out.content === 'string') text = out.content;
    else text = JSON.stringify(out);
  }
  if (!text && (pd as any).toolResult?.content) {
    text = String((pd as any).toolResult.content);
  }
  const m = text.match(/\[Agent ID:\s*(agent-[a-f0-9]+)\]/i)
    || text.match(/\b(agent-[a-f0-9]{6,})\b/i);
  return m?.[1];
}

/** parent jsonl 旁的 subagents 目录：`<projects>/<hash>/<sid>/subagents/` */
export function resolveWorkbuddySubagentsDir(
  parentSessionId: string,
  parentJsonlPath?: string,
): string | undefined {
  const p = parentJsonlPath || findWorkbuddyJsonlPath(parentSessionId);
  if (!p) return undefined;
  // projects/<hash>/<sid>.jsonl → projects/<hash>/<sid>/subagents
  return path.join(path.dirname(p), parentSessionId, 'subagents');
}

export function findWorkbuddySubagentJsonlPath(
  parentSessionId: string,
  agentId: string,
  parentJsonlPath?: string,
): string | undefined {
  const dir = resolveWorkbuddySubagentsDir(parentSessionId, parentJsonlPath);
  if (!dir) return undefined;
  const candidate = path.join(dir, `${agentId}.jsonl`);
  if (fs.existsSync(candidate)) return candidate;
  return undefined;
}

/** 磁盘上已有的 agent id 列表（含仅有目录、jsonl 尚未 flush 的情况） */
export function listWorkbuddySubagentIdsOnDisk(
  parentSessionId: string,
  parentJsonlPath?: string,
): string[] {
  const dir = resolveWorkbuddySubagentsDir(parentSessionId, parentJsonlPath);
  if (!dir || !fs.existsSync(dir)) return [];
  const ids = new Set<string>();
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.jsonl') && name.startsWith('agent-')) {
        ids.add(name.slice(0, -'.jsonl'.length));
      } else if (name.startsWith('agent-')) {
        // 目录形态 agent-xxx/
        try {
          if (fs.statSync(path.join(dir, name)).isDirectory()) ids.add(name);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    return [];
  }
  return Array.from(ids).sort();
}

function parseWorkbuddyToolArgs(raw: string | Record<string, any> | undefined): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/**
 * 扫描主 session jsonl 的 Agent tool call/result，并与磁盘 subagents/ 对齐。
 * 产出可转为虚拟 session 的 meta（含运行中：有目录尚无 result）。
 */
export function listWorkbuddySubagentsFromMainJsonl(
  session: WorkbuddySessionItem,
): WorkbuddySubagentMeta[] {
  const parentSessionId = session.sessionId;
  const events = readWorkbuddyJsonl(parentSessionId, session.jsonlPath);

  type CallInfo = {
    callId: string;
    args: Record<string, any>;
    messageId?: string;
    ts?: number;
  };
  type ResultInfo = {
    agentId?: string;
    status?: string;
    ts?: number;
  };

  const calls = new Map<string, CallInfo>();
  const results = new Map<string, ResultInfo>();
  const callOrder: string[] = [];

  for (const ev of events) {
    const name = (ev.name || '').toLowerCase();
    if (name !== 'agent') continue;

    if (ev.type === 'function_call') {
      const callId = ev.callId || ev.id || `call-${calls.size}`;
      if (!calls.has(callId)) callOrder.push(callId);
      calls.set(callId, {
        callId,
        args: parseWorkbuddyToolArgs(ev.arguments as any),
        messageId: ev.providerData?.messageId,
        ts: ev.timestamp,
      });
    } else if (ev.type === 'function_call_result') {
      const callId = ev.callId || '';
      if (!callId) continue;
      results.set(callId, {
        agentId: parseWorkbuddyAgentIdFromResult(ev),
        status: ev.status,
        ts: ev.timestamp,
      });
    }
  }

  const diskIds = listWorkbuddySubagentIdsOnDisk(parentSessionId, session.jsonlPath);
  const usedAgents = new Set<string>();
  const metas: WorkbuddySubagentMeta[] = [];

  const pushMeta = (opts: {
    agentId: string;
    callId: string;
    args?: Record<string, any>;
    messageId?: string;
    outcome?: string;
  }) => {
    if (usedAgents.has(opts.agentId)) return;
    usedAgents.add(opts.agentId);
    const args = opts.args || {};
    const desc = String(args.description || '').trim() || undefined;
    const prompt = String(args.prompt || '').trim();
    const subagentType = String(args.subagent_type || args.subagentType || 'general-purpose');
    const outcome = opts.outcome
      || (opts.agentId ? 'completed' : 'started');
    metas.push({
      virtualSessionId: buildWorkbuddySubagentSessionId(parentSessionId, opts.agentId),
      parentSessionId,
      agentId: opts.agentId,
      toolCallId: opts.callId,
      spawnGroupId: opts.messageId || opts.callId,
      subagentType,
      description: desc,
      promptPreview: prompt ? prompt.slice(0, 200) : undefined,
      outcome,
      jsonlPath: findWorkbuddySubagentJsonlPath(parentSessionId, opts.agentId, session.jsonlPath),
    });
  };

  // 1) 已完成：call + result 带 agentId
  for (const callId of callOrder) {
    const call = calls.get(callId)!;
    const res = results.get(callId);
    if (!res?.agentId) continue;
    const status = (res.status || 'completed').toLowerCase();
    const outcome =
      status === 'failed' || status === 'error' ? 'failed'
        : status === 'aborted' || status === 'cancelled' ? 'aborted'
          : 'completed';
    pushMeta({
      agentId: res.agentId,
      callId,
      args: call.args,
      messageId: call.messageId,
      outcome,
    });
  }

  // 2) 运行中：有 call 无 result，按调用顺序绑定未认领的磁盘 agent
  const pendingCalls = callOrder.filter((id) => {
    const res = results.get(id);
    return !res?.agentId;
  });
  const unclaimedDisk = diskIds.filter((id) => !usedAgents.has(id));
  for (let i = 0; i < pendingCalls.length; i++) {
    const callId = pendingCalls[i];
    const call = calls.get(callId)!;
    const agentId = unclaimedDisk[i];
    if (!agentId) {
      // 尚无目录：跳过（无法建虚拟 session）
      continue;
    }
    pushMeta({
      agentId,
      callId,
      args: call.args,
      messageId: call.messageId,
      outcome: 'started',
    });
  }

  // 3) 磁盘有、jsonl 未覆盖的孤儿 agent（result 丢失等）
  for (const agentId of diskIds) {
    if (usedAgents.has(agentId)) continue;
    pushMeta({
      agentId,
      callId: `disk:${agentId}`,
      messageId: undefined,
      outcome: 'completed',
      args: { description: agentId, subagent_type: 'general-purpose' },
    });
  }

  return metas;
}

export function readWorkbuddySubagentJsonl(
  parentSessionId: string,
  agentId: string,
  jsonlPath?: string,
): WorkbuddyJsonlEvent[] {
  const p = jsonlPath || findWorkbuddySubagentJsonlPath(parentSessionId, agentId);
  if (!p) return [];
  return readWorkbuddyJsonl(agentId, p);
}
