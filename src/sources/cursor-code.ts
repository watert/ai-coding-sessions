/**
 * Cursor Desktop / CLI 本地数据访问
 *
 * Desktop:
 *   state.vscdb → composerHeaders + cursorDiskKV(composerData / bubbleId)
 *   ~/.cursor/projects/<project>/agent-transcripts/<sid>/<sid>.jsonl
 * CLI (可选, 本机可能空):
 *   ~/.cursor/chats/<workspace-hash>/<sid>/store.db
 *
 * 无可靠 billed usage；tokenCount 常为 0；promptTokenBreakdown 仅上下文估算。
 */

import fs from 'fs';
import path from 'path';
import { initSqliteDb, getSqliteDb, closeSqliteDb } from '../lib/sqlite';
import { splitLines } from '../lib/jsonl-cache';
import { resolveDataRoot, resolveHomeDir } from '../lib/home-paths';

const SQLITE_INSTANCE = 'cursor-state';

// ==================== 路径 ====================

/** ~/.cursor ：CURSOR_HOME */
export function resolveCursorHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveHomeDir(env);
  return resolveDataRoot({
    envValue: env.CURSOR_HOME,
    defaults: [path.join(home, '.cursor')],
    isOk: (p) => {
      try {
        return (
          fs.existsSync(path.join(p, 'projects')) ||
          fs.existsSync(path.join(p, 'chats')) ||
          fs.existsSync(p)
        );
      } catch {
        return false;
      }
    },
  });
}

/**
 * Cursor 应用数据根（含 User/globalStorage/state.vscdb）
 * CURSOR_APP_DATA → 平台默认
 */
export function resolveCursorAppData(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveHomeDir(env);
  const defaults: string[] = [];
  if (process.platform === 'darwin') {
    defaults.push(path.join(home, 'Library', 'Application Support', 'Cursor'));
  } else if (process.platform === 'win32') {
    const appdata = env.APPDATA?.trim();
    if (appdata) defaults.push(path.join(appdata, 'Cursor'));
    defaults.push(path.join(home, 'AppData', 'Roaming', 'Cursor'));
  } else {
    // linux
    const xdg = env.XDG_CONFIG_HOME?.trim()
      ? path.resolve(env.XDG_CONFIG_HOME.trim())
      : path.join(home, '.config');
    defaults.push(path.join(xdg, 'Cursor'));
  }
  return resolveDataRoot({
    envValue: env.CURSOR_APP_DATA,
    defaults,
    isOk: (p) => {
      try {
        return (
          fs.existsSync(path.join(p, 'User', 'globalStorage', 'state.vscdb')) ||
          fs.existsSync(path.join(p, 'User')) ||
          fs.existsSync(p)
        );
      } catch {
        return false;
      }
    },
  });
}

export function resolveCursorStateDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CURSOR_STATE_DB?.trim()) return path.resolve(env.CURSOR_STATE_DB.trim());
  return path.join(resolveCursorAppData(env), 'User', 'globalStorage', 'state.vscdb');
}

export const CURSOR_HOME = resolveCursorHome();
export const CURSOR_APP_DATA = resolveCursorAppData();
export const CURSOR_STATE_DB = resolveCursorStateDbPath();

// ==================== 类型 ====================

export type CursorTokenCount = {
  inputTokens?: number;
  outputTokens?: number;
};

export type CursorToolFormerData = {
  toolCallId?: string;
  toolIndex?: number;
  modelCallId?: string;
  status?: string;
  name?: string;
  rawArgs?: string;
  params?: string | Record<string, any>;
  result?: string | Record<string, any>;
  tool?: number | string;
  additionalData?: Record<string, any>;
  [k: string]: any;
};

export type CursorBubble = {
  bubbleId: string;
  type: number; // 1=user, 2=assistant
  text?: string;
  createdAt?: string;
  tokenCount?: CursorTokenCount;
  modelInfo?: { modelName?: string };
  toolFormerData?: CursorToolFormerData;
  /** 思考正文（Cursor UI "Thought for Xs"） */
  thinking?: { text?: string; signature?: string } | string;
  thinkingDurationMs?: number;
  thinkingStyle?: number;
  /** 30=thinking, 15=tool；header.grouping 也会带 */
  capabilityType?: number;
  isAgentic?: boolean;
  requestId?: string;
  /** header.grouping 透传（step 边界 / tool 展示） */
  grouping?: Record<string, any>;
  [k: string]: any;
};

export type CursorBubbleHeader = {
  bubbleId: string;
  type?: number;
  createdAt?: string;
  serverBubbleId?: string;
  grouping?: {
    isRenderable?: boolean;
    hasText?: boolean;
    hasThinking?: boolean;
    thinkingDurationMs?: number;
    capabilityType?: number;
    toolFormerTool?: number;
    toolCallId?: string;
    toolCallCase?: string;
    isToolGroupable?: boolean;
    isKeptFinalAiVisibleOutsideWorkedForGroup?: boolean;
    turnDurationMs?: number;
    [k: string]: any;
  };
};

export type CursorComposerData = {
  composerId?: string;
  name?: string;
  status?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  unifiedMode?: string;
  isAgentic?: boolean;
  modelConfig?: {
    modelName?: string;
    maxMode?: boolean;
    selectedModels?: Array<{ modelId?: string }>;
  };
  fullConversationHeadersOnly?: CursorBubbleHeader[];
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  filesChangedCount?: number;
  contextUsagePercent?: number;
  promptTokenBreakdown?: {
    totalUsedTokens?: number;
    maxTokens?: number;
    categories?: Array<{ id?: string; label?: string; estimatedTokens?: number }>;
  };
  usageData?: Record<string, any>;
  subtitle?: string;
  subagentComposerIds?: string[];
  subComposerIds?: string[];
  isBestOfNSubcomposer?: boolean;
  agentBackend?: string;
  workspaceIdentifier?: {
    id?: string;
    uri?: { fsPath?: string; path?: string };
    fsPath?: string;
  };
  [k: string]: any;
};

export type CursorHeaderValue = {
  type?: string;
  composerId?: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  conversationCheckpointLastUpdatedAt?: number;
  unifiedMode?: string;
  isArchived?: boolean;
  isDraft?: boolean;
  isSubagent?: boolean;
  isBestOfNSubcomposer?: boolean;
  subtitle?: string;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  filesChangedCount?: number;
  contextUsagePercent?: number;
  workspaceIdentifier?: {
    id?: string;
    uri?: { fsPath?: string; path?: string };
    fsPath?: string;
  };
  trackedGitRepos?: Array<{ repoPath?: string }>;
  [k: string]: any;
};

export type CursorSessionItem = {
  sessionId: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  isSubagent: boolean;
  isArchived: boolean;
  isDraft: boolean;
  unifiedMode?: string;
  subtitle?: string;
  workspaceId?: string;
  header: CursorHeaderValue;
};

export type CursorTranscriptLine = {
  role?: string;
  type?: string;
  status?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, any>;
      id?: string;
    }>;
  };
  [k: string]: any;
};

// ==================== DB ====================

export function getCursorStateDbPath(): string {
  return resolveCursorStateDbPath();
}

export async function initCursorDb(): Promise<boolean> {
  const dbPath = getCursorStateDbPath();
  if (!fs.existsSync(dbPath)) {
    console.warn(`[cursor-code] state.vscdb 不存在: ${dbPath}`);
    return false;
  }
  try {
    await initSqliteDb(SQLITE_INSTANCE, getCursorStateDbPath, true);
    return true;
  } catch (e) {
    console.warn('[cursor-code] SQLite 打开失败:', e);
    return false;
  }
}

export function getCursorDb() {
  return getSqliteDb(SQLITE_INSTANCE);
}

export function closeCursorDb(): void {
  closeSqliteDb(SQLITE_INSTANCE);
}

async function ensureDb(): Promise<boolean> {
  try {
    getCursorDb();
    return true;
  } catch {
    return initCursorDb();
  }
}

// ==================== JSON helpers ====================

function decodeJsonish(raw: unknown): any {
  if (raw == null) return null;
  if (typeof raw === 'object' && !Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
    return raw;
  }
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    text = Buffer.from(raw).toString('utf-8');
  } else if (typeof (raw as any).toString === 'function') {
    // bun:sqlite 可能返回 Uint8Array-like
    try {
      text = Buffer.from(raw as any).toString('utf-8');
    } catch {
      text = String(raw);
    }
  } else {
    return null;
  }
  const stripped = text.trim();
  if (!stripped) return null;
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

function extractCwd(value: CursorHeaderValue | CursorComposerData | null | undefined): string {
  if (!value) return '';
  const wi = value.workspaceIdentifier;
  if (wi) {
    const uri = wi.uri;
    if (uri?.fsPath) return String(uri.fsPath);
    if (uri?.path) return String(uri.path);
    if (wi.fsPath) return String(wi.fsPath);
  }
  const tracked = (value as CursorHeaderValue).trackedGitRepos;
  if (Array.isArray(tracked) && tracked[0]?.repoPath) return String(tracked[0].repoPath);
  return '';
}

function numTs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    const d = Date.parse(v);
    if (Number.isFinite(d) && d > 0) return d;
  }
  return 0;
}

// ==================== List ====================

export async function listCursorSessions(): Promise<CursorSessionItem[]> {
  if (!(await ensureDb())) return [];
  const db = getCursorDb();

  let rows: Array<{
    composerId: string;
    workspaceId?: string;
    createdAt?: number;
    lastUpdatedAt?: number;
    isArchived?: number;
    isSubagent?: number;
    recency?: number;
    value?: unknown;
  }> = [];

  try {
    rows = db
      .prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value
         FROM composerHeaders`,
      )
      .all() as typeof rows;
  } catch (e) {
    // 旧版可能无 composerHeaders 表
    console.warn('[cursor-code] composerHeaders 读取失败:', e);
    return [];
  }

  const out: CursorSessionItem[] = [];
  for (const row of rows) {
    const id = String(row.composerId || '');
    if (!id || id === 'empty-state-draft') continue;
    if (row.isArchived) continue;

    const header = (decodeJsonish(row.value) || {}) as CursorHeaderValue;
    if (header.isArchived) continue;

    const createdAt =
      numTs(row.createdAt) || numTs(header.createdAt) || 0;
    // lastUpdatedAt 常停在首条 user；checkpoint 时间更接近真实结束
    const updatedAt = Math.max(
      numTs(row.lastUpdatedAt),
      numTs(row.recency),
      numTs(header.conversationCheckpointLastUpdatedAt),
      numTs(header.lastUpdatedAt),
      createdAt,
    );

    const cwd = extractCwd(header);
    const title =
      (typeof header.name === 'string' && header.name.trim()) ||
      (typeof header.subtitle === 'string' && header.subtitle.trim()) ||
      id.slice(0, 8);

    out.push({
      sessionId: id,
      title,
      cwd,
      createdAt,
      updatedAt,
      isSubagent: Boolean(row.isSubagent || header.isSubagent || header.isBestOfNSubcomposer),
      isArchived: false,
      isDraft: Boolean(header.isDraft),
      unifiedMode: header.unifiedMode,
      subtitle: header.subtitle,
      workspaceId: row.workspaceId || header.workspaceIdentifier?.id,
      header,
    });
  }

  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export async function getCursorSession(sessionId: string): Promise<CursorSessionItem | null> {
  const list = await listCursorSessions();
  const hit = list.find((s) => s.sessionId === sessionId);
  if (hit) return hit;

  // 归档 session 也可能被 detail 请求
  if (!(await ensureDb())) return null;
  const db = getCursorDb();
  try {
    const row = db
      .prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value
         FROM composerHeaders WHERE composerId = ?`,
      )
      .get(sessionId) as any;
    if (!row) return null;
    const header = (decodeJsonish(row.value) || {}) as CursorHeaderValue;
    const createdAt = numTs(row.createdAt) || numTs(header.createdAt) || 0;
    const updatedAt = Math.max(
      numTs(row.lastUpdatedAt),
      numTs(row.recency),
      numTs(header.conversationCheckpointLastUpdatedAt),
      numTs(header.lastUpdatedAt),
      createdAt,
    );
    return {
      sessionId,
      title: header.name || sessionId.slice(0, 8),
      cwd: extractCwd(header),
      createdAt,
      updatedAt,
      isSubagent: Boolean(row.isSubagent || header.isSubagent),
      isArchived: Boolean(row.isArchived || header.isArchived),
      isDraft: Boolean(header.isDraft),
      unifiedMode: header.unifiedMode,
      subtitle: header.subtitle,
      workspaceId: row.workspaceId || header.workspaceIdentifier?.id,
      header,
    };
  } catch {
    return null;
  }
}

// ==================== composerData / bubbles ====================

export async function getCursorComposerData(sessionId: string): Promise<CursorComposerData | null> {
  if (!(await ensureDb())) return null;
  const db = getCursorDb();
  try {
    const row = db
      .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
      .get(`composerData:${sessionId}`) as { value?: unknown } | undefined;
    if (!row) return null;
    return (decodeJsonish(row.value) || null) as CursorComposerData | null;
  } catch (e) {
    console.warn(`[cursor-code] composerData 读取失败: ${sessionId}`, e);
    return null;
  }
}

export async function getCursorBubble(
  sessionId: string,
  bubbleId: string,
): Promise<CursorBubble | null> {
  if (!(await ensureDb())) return null;
  const db = getCursorDb();
  try {
    const row = db
      .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
      .get(`bubbleId:${sessionId}:${bubbleId}`) as { value?: unknown } | undefined;
    if (!row) return null;
    const b = decodeJsonish(row.value) as CursorBubble | null;
    if (b && !b.bubbleId) b.bubbleId = bubbleId;
    return b;
  } catch {
    return null;
  }
}

/** 按 conversation 头序加载 bubbles；无头则扫 key 前缀 */
export async function getCursorBubbles(sessionId: string): Promise<CursorBubble[]> {
  if (!(await ensureDb())) return [];
  const db = getCursorDb();
  const composer = await getCursorComposerData(sessionId);
  const headers = composer?.fullConversationHeadersOnly;

  if (Array.isArray(headers) && headers.length > 0) {
    const out: CursorBubble[] = [];
    for (const h of headers) {
      if (!h?.bubbleId) continue;
      const b = await getCursorBubble(sessionId, h.bubbleId);
      if (b) {
        if (h.createdAt && !b.createdAt) b.createdAt = h.createdAt;
        if (h.type != null && b.type == null) b.type = h.type;
        // header.grouping 补 capability / thinking 标记（body 有时缺 capabilityType）
        if (h.grouping) {
          b.grouping = { ...(b.grouping || {}), ...h.grouping };
          if (b.capabilityType == null && h.grouping.capabilityType != null) {
            b.capabilityType = h.grouping.capabilityType;
          }
          if (b.thinkingDurationMs == null && h.grouping.thinkingDurationMs != null) {
            b.thinkingDurationMs = h.grouping.thinkingDurationMs;
          }
        }
        out.push(b);
      } else {
        // header 有但 body 缺失时保留占位
        out.push({
          bubbleId: h.bubbleId,
          type: h.type ?? 2,
          createdAt: h.createdAt,
          text: '',
          grouping: h.grouping,
          capabilityType: h.grouping?.capabilityType,
          thinkingDurationMs: h.grouping?.thinkingDurationMs,
        });
      }
    }
    return out;
  }

  // fallback: 扫全部 bubbleId 前缀
  try {
    const prefix = `bubbleId:${sessionId}:`;
    const rows = db
      .prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE ?`)
      .all(`${prefix}%`) as Array<{ key: string; value: unknown }>;
    const bubbles: CursorBubble[] = [];
    for (const row of rows) {
      const b = decodeJsonish(row.value) as CursorBubble | null;
      if (!b) continue;
      if (!b.bubbleId) {
        b.bubbleId = row.key.slice(prefix.length);
      }
      bubbles.push(b);
    }
    bubbles.sort((a, b) => {
      const ta = numTs(a.createdAt);
      const tb = numTs(b.createdAt);
      return ta - tb;
    });
    return bubbles;
  } catch (e) {
    console.warn(`[cursor-code] bubbles 扫描失败: ${sessionId}`, e);
    return [];
  }
}

// ==================== agent-transcripts ====================

/** 在 ~/.cursor/projects 下找 transcript jsonl */
export function findCursorTranscriptPath(
  sessionId: string,
  cursorHome: string = CURSOR_HOME,
): string | null {
  const projects = path.join(cursorHome, 'projects');
  if (!fs.existsSync(projects)) return null;

  // 常见两种：.../agent-transcripts/<sid>/<sid>.jsonl 或 .../agent-transcripts/<sid>.jsonl
  try {
    const projectDirs = fs.readdirSync(projects, { withFileTypes: true });
    for (const d of projectDirs) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const nested = path.join(projects, d.name, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
      if (fs.existsSync(nested)) return nested;
      const flat = path.join(projects, d.name, 'agent-transcripts', `${sessionId}.jsonl`);
      if (fs.existsSync(flat)) return flat;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function readCursorTranscript(
  sessionId: string,
  cursorHome: string = CURSOR_HOME,
): CursorTranscriptLine[] {
  const p = findCursorTranscriptPath(sessionId, cursorHome);
  if (!p) return [];
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const rows: CursorTranscriptLine[] = [];
    for (const line of splitLines(raw)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

// ==================== 工具名归一 ====================

/** Cursor 内部 tool 名 → 统一协议常用名（便于 bash-signals / editDiffs） */
export function normalizeCursorToolName(name: string | undefined): string {
  if (!name) return 'unknown';
  const n = name.trim();
  const map: Record<string, string> = {
    read_file_v2: 'Read',
    read_file: 'Read',
    run_terminal_command_v2: 'Bash',
    run_terminal_cmd: 'Bash',
    Shell: 'Bash',
    glob_file_search: 'Glob',
    Glob: 'Glob',
    ripgrep_raw_search: 'Grep',
    grep: 'Grep',
    Grep: 'Grep',
    edit_file_v2: 'Edit',
    edit_file: 'Edit',
    search_replace: 'Edit',
    ApplyPatch: 'Edit',
    apply_patch: 'Edit',
    write_file: 'Write',
    Write: 'Write',
    delete_file: 'Delete',
    list_dir: 'LS',
    LS: 'LS',
    TodoWrite: 'TodoWrite',
    todo_write: 'TodoWrite',
    WebSearch: 'WebSearch',
    web_search: 'WebSearch',
  };
  if (map[n]) return map[n];
  // snake → Pascal-ish keep original if unknown
  return n;
}

export function parseCursorToolParams(
  raw: string | Record<string, any> | undefined,
): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : { raw: parsed };
  } catch {
    return { raw };
  }
}

export function cursorToolResultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') {
    try {
      const p = JSON.parse(result);
      if (p && typeof p === 'object') {
        if (typeof p.output === 'string') return p.output;
        if (typeof p.contents === 'string') return p.contents;
        if (typeof p.content === 'string') return p.content;
        if (p.rejected) return JSON.stringify(p);
        return JSON.stringify(p);
      }
    } catch {
      return result;
    }
    return result;
  }
  if (typeof result === 'object') {
    const o = result as any;
    if (typeof o.output === 'string') return o.output;
    if (typeof o.contents === 'string') return o.contents;
    return JSON.stringify(result);
  }
  return String(result);
}
