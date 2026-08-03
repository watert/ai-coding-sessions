/**
 * Codex CLI 本地数据访问服务
 * SQLite: ~/.codex/state_*.sqlite (threads 元数据)
 * JSONL:  ~/.codex/sessions/.../rollout-*.jsonl 与 archived_sessions/
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { initSqliteDb, getSqliteDb, closeSqliteDb } from '../lib/sqlite';

const HOMEDIR = os.homedir();
const CODEX_BASE = path.join(HOMEDIR, '.codex');
const SQLITE_INSTANCE = 'codex-state';

// ==================== 类型 ====================

export type CodexSessionItem = {
  sessionId: string;
  sessionDir: string;
  rolloutPath: string;
  workDir: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  modelProvider?: string;
  tokensUsed?: number;
  source?: string;
  parentId?: string;
  archived?: boolean;
  cliVersion?: string;
  preview?: string;
};

export type CodexUsage = {
  input: number;
  output: number;
  cacheRead: number;
  reasoning: number;
  total: number;
};

export type CodexToolCallItem = {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
};

export type CodexMessageItem = {
  uuid: string;
  sessionId: string;
  role: 'user' | 'assistant';
  timestamp: number;
  text: string;
  thinking?: string;
  toolCalls: CodexToolCallItem[];
  parts?: any[];
  usage?: CodexUsage;
  model?: string;
  latencyMs?: number;
  streamDurationMs?: number;
  parentID?: string;
  turnId?: string;
};

// ==================== SQLite 路径 ====================

function findCodexStateDbPath(): string | null {
  if (!fs.existsSync(CODEX_BASE)) return null;
  let files: string[] = [];
  try {
    files = fs.readdirSync(CODEX_BASE).filter((f) => /^state_\d+\.sqlite$/.test(f));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  files.sort((a, b) => {
    const na = parseInt(a.match(/\d+/)![0], 10);
    const nb = parseInt(b.match(/\d+/)![0], 10);
    return nb - na;
  });
  return path.join(CODEX_BASE, files[0]);
}

async function ensureCodexDb(): Promise<boolean> {
  const dbPath = findCodexStateDbPath();
  if (!dbPath) return false;
  try {
    await initSqliteDb(SQLITE_INSTANCE, () => dbPath, true);
    return true;
  } catch (e) {
    console.warn('[codex-code] SQLite 打开失败:', e);
    return false;
  }
}

function stableId(seed: string): string {
  return `codex-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function parseIsoMs(ts?: string | number | null): number {
  if (ts == null) return 0;
  if (typeof ts === 'number') {
    // 秒级时间戳
    return ts < 1e12 ? ts * 1000 : ts;
  }
  const n = Date.parse(ts);
  return Number.isNaN(n) ? 0 : n;
}

// ==================== Session 列表 ====================

type ThreadRow = {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  created_at_ms?: number | null;
  updated_at_ms?: number | null;
  source: string;
  model_provider: string;
  cwd: string;
  title: string;
  tokens_used: number;
  archived: number;
  model?: string | null;
  first_user_message?: string | null;
  preview?: string | null;
  cli_version?: string | null;
};

/** rollout 路径存在性：原路径或 .jsonl.zst */
export function resolveExistingRolloutPath(rawPath: string | null | undefined): string | null {
  if (!rawPath) return null;
  if (fs.existsSync(rawPath)) return rawPath;
  if (rawPath.endsWith('.jsonl') && fs.existsSync(`${rawPath}.zst`)) return `${rawPath}.zst`;
  if (rawPath.endsWith('.jsonl.zst')) {
    const plain = rawPath.slice(0, -4); // drop .zst
    if (fs.existsSync(plain)) return plain;
  }
  return null;
}

function rowToSession(row: ThreadRow, parentId?: string): CodexSessionItem {
  const createdAt = row.created_at_ms || parseIsoMs(row.created_at);
  const updatedAt = row.updated_at_ms || parseIsoMs(row.updated_at);
  const title = (row.title || row.preview || row.first_user_message || 'Untitled').trim() || 'Untitled';
  const rolloutPath = resolveExistingRolloutPath(row.rollout_path) || row.rollout_path;
  return {
    sessionId: row.id,
    sessionDir: path.dirname(rolloutPath || row.rollout_path || ''),
    rolloutPath,
    workDir: row.cwd || '',
    title,
    createdAt,
    updatedAt,
    model: row.model || undefined,
    modelProvider: row.model_provider || undefined,
    tokensUsed: row.tokens_used || 0,
    source: row.source || undefined,
    parentId,
    archived: !!row.archived,
    cliVersion: row.cli_version || undefined,
    preview: row.preview || undefined,
  };
}

function loadParentMap(db: any): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const rows = db.prepare('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges').all() as Array<{
      parent_thread_id: string;
      child_thread_id: string;
    }>;
    for (const r of rows) {
      if (r.child_thread_id && r.parent_thread_id) {
        map.set(r.child_thread_id, r.parent_thread_id);
      }
    }
  } catch {
    // 旧库可能无此表
  }
  return map;
}

/** 无 SQLite 时扫描 rollout jsonl */
function scanRolloutSessions(): CodexSessionItem[] {
  const sessions: CodexSessionItem[] = [];
  const roots = [
    path.join(CODEX_BASE, 'sessions'),
    path.join(CODEX_BASE, 'archived_sessions'),
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const files: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (
          ent.isFile() &&
          ent.name.startsWith('rollout-') &&
          (ent.name.endsWith('.jsonl') || ent.name.endsWith('.jsonl.zst'))
        ) {
          files.push(full);
        }
      }
    };
    walk(root);

    for (const rolloutPath of files) {
      try {
        const firstLine = fs.readFileSync(rolloutPath, 'utf-8').split('\n').find((l) => l.trim());
        if (!firstLine) continue;
        const o = JSON.parse(firstLine);
        if (o.type !== 'session_meta') continue;
        const p = o.payload || {};
        const sessionId = p.session_id || p.id;
        if (!sessionId) continue;
        const createdAt = parseIsoMs(p.timestamp || o.timestamp);
        let updatedAt = createdAt;
        try {
          const st = fs.statSync(rolloutPath);
          updatedAt = st.mtimeMs || createdAt;
        } catch {}
        sessions.push({
          sessionId,
          sessionDir: path.dirname(rolloutPath),
          rolloutPath,
          workDir: p.cwd || '',
          title: 'Untitled',
          createdAt,
          updatedAt,
          modelProvider: p.model_provider,
          source: p.source,
          archived: root.includes('archived_sessions'),
          cliVersion: p.cli_version,
        });
      } catch {
        // ignore
      }
    }
  }

  return sessions;
}

export async function listCodexSessions(): Promise<CodexSessionItem[]> {
  const ok = await ensureCodexDb();
  if (!ok) {
    return scanRolloutSessions().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  try {
    const db = getSqliteDb(SQLITE_INSTANCE);
    const parentMap = loadParentMap(db);
    const rows = db.prepare(`
      SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
             source, model_provider, cwd, title, tokens_used, archived, model,
             first_user_message, preview, cli_version
      FROM threads
      ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
    `).all() as ThreadRow[];

    return rows
      .filter((r) => !!resolveExistingRolloutPath(r.rollout_path))
      .map((r) => rowToSession(r, parentMap.get(r.id)));
  } catch (e) {
    console.warn('[codex-code] 读取 threads 失败，回退扫描 jsonl:', e);
    return scanRolloutSessions().sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

export async function findCodexSession(sessionId: string): Promise<CodexSessionItem | null> {
  const sessions = await listCodexSessions();
  return sessions.find((s) => s.sessionId === sessionId) || null;
}

// ==================== JSONL 解析 ====================

type RolloutEvent = {
  timestamp?: string;
  type: string;
  payload?: any;
};

/** 读 rollout 文本（支持 .jsonl.zst，需 PATH 上有 zstd） */
export function readRolloutText(rolloutPath: string): string {
  const resolved = resolveExistingRolloutPath(rolloutPath) || rolloutPath;
  if (!resolved || !fs.existsSync(resolved)) return '';
  if (resolved.endsWith('.jsonl.zst') || resolved.endsWith('.zst')) {
    const r = spawnSync('zstd', ['-dc', resolved], {
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) {
      const detail = (r.stderr || r.error?.message || 'zstd failed').toString().slice(0, 200);
      console.warn(`[codex-code] zstd decompress failed for ${resolved}: ${detail}`);
      return '';
    }
    return r.stdout || '';
  }
  return fs.readFileSync(resolved, 'utf-8');
}

function parseRolloutLines(content: string): RolloutEvent[] {
  return content
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as RolloutEvent;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as RolloutEvent[];
}

/**
 * 读 rollout 事件并应用 compact 裁剪（P1 #5）：
 * - 最后一个带 replacement_history 的 compacted：以其为基线，只保留之后的记录
 * - replacement_history 项转为 synthetic response_item
 */
export function readRolloutEvents(rolloutPath: string): RolloutEvent[] {
  if (!rolloutPath) return [];
  const content = readRolloutText(rolloutPath);
  if (!content) return [];
  const raw = parseRolloutLines(content);
  return applyCodexCompaction(raw);
}

/** 纯函数：compacted.replacement_history + 后续事件 */
export function applyCodexCompaction(records: RolloutEvent[]): RolloutEvent[] {
  let startIndex = 0;
  let baseItems: any[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.type !== 'compacted') continue;
    const replacement = rec.payload?.replacement_history;
    if (Array.isArray(replacement)) {
      baseItems = replacement;
      startIndex = i + 1;
    }
  }
  if (!baseItems.length && startIndex === 0) return records;

  const synthetic: RolloutEvent[] = baseItems.map((item, idx) => ({
    type: 'response_item',
    timestamp: records[startIndex - 1]?.timestamp,
    payload: item,
    // 标记便于调试
    _from_compact_replacement: true,
    _compact_idx: idx,
  })) as RolloutEvent[];

  return [...synthetic, ...records.slice(startIndex)];
}

/** 从 messages 列表丢弃末尾 N 个 user 及其后内容（thread_rolled_back） */
export function dropLastUserTurns<T extends { role: string }>(messages: T[], numTurns: number): T[] {
  if (numTurns <= 0 || !messages.length) return messages;
  const positions: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') positions.push(i);
  }
  if (!positions.length) return messages;
  const cutIdx = positions[Math.max(0, positions.length - numTurns)];
  return messages.slice(0, cutIdx);
}

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content
    .map((c) => {
      if (!c || typeof c !== 'object') return String(c || '');
      const part = c as any;
      return part.text || part.output_text || part.input_text || '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractThinkingFromReasoning(payload: any): string {
  if (!payload) return '';
  if (typeof payload.text === 'string') return payload.text;
  const summary = payload.summary;
  if (Array.isArray(summary)) {
    return summary
      .map((s: any) => s?.text || '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parseUsageFromTokenCount(info: any): CodexUsage | undefined {
  if (!info) return undefined;
  const last = info.last_token_usage || info.total_token_usage;
  if (!last) return undefined;
  const inputTokens = last.input_tokens || 0;
  const cacheRead = last.cached_input_tokens || 0;
  // Codex 的 input_tokens 通常已包含 cache；非 cache 输入 = input - cache
  const input = Math.max(0, inputTokens - cacheRead);
  const output = last.output_tokens || 0;
  const reasoning = last.reasoning_output_tokens || 0;
  const total = last.total_tokens || inputTokens + output;
  return { input, output, cacheRead, reasoning, total };
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }
  return { value: raw };
}

// ==================== 消息重建 ====================

export async function listCodexMessages(params: {
  sessionId: string;
  rolloutPath?: string;
}): Promise<CodexMessageItem[]> {
  const { sessionId } = params;
  let rolloutPath = params.rolloutPath;
  if (!rolloutPath) {
    const session = await findCodexSession(sessionId);
    if (!session) throw new Error(`Codex session not found: ${sessionId}`);
    rolloutPath = session.rolloutPath;
  }

  const events = readRolloutEvents(rolloutPath);
  const messages: CodexMessageItem[] = [];

  let currentModel: string | undefined;
  let currentTurnId: string | undefined;
  let turnStartedAtMs = 0;
  let lastUserUuid: string | undefined;

  // 当前 turn 内累积的 assistant 片段
  let pendingThinking = '';
  let pendingText = '';
  let pendingParts: any[] = [];
  let pendingTools: CodexToolCallItem[] = [];
  const toolById = new Map<string, CodexToolCallItem>();
  let pendingUsage: CodexUsage | undefined;
  let pendingLatencyMs: number | undefined;
  let pendingStreamMs: number | undefined;
  let pendingTs = 0;
  let lineIdx = 0;

  const flushAssistant = () => {
    if (!pendingText && !pendingThinking && pendingTools.length === 0 && pendingParts.length === 0) {
      return;
    }
    const uuid = stableId(`${sessionId}:assistant:${lineIdx}:${currentTurnId || pendingTs}`);
    const parts = pendingParts.length
      ? pendingParts
      : [
          ...(pendingThinking
            ? [{ type: 'reasoning', text: pendingThinking, state: 'done' }]
            : []),
          ...(pendingText ? [{ type: 'text', text: pendingText, state: 'done' }] : []),
          ...pendingTools.map((tc) => ({
            type: 'tool',
            tool: tc.name,
            callID: tc.toolCallId,
            state: {
              status: tc.result !== undefined ? 'completed' : 'calling',
              input: tc.args,
              output: tc.result,
              title: tc.name,
            },
          })),
        ];

    messages.push({
      uuid,
      sessionId,
      role: 'assistant',
      timestamp: pendingTs || Date.now(),
      text: pendingText,
      thinking: pendingThinking || undefined,
      toolCalls: pendingTools,
      parts,
      usage: pendingUsage,
      model: currentModel,
      latencyMs: pendingLatencyMs,
      streamDurationMs: pendingStreamMs,
      parentID: lastUserUuid,
      turnId: currentTurnId,
    });

    pendingThinking = '';
    pendingText = '';
    pendingParts = [];
    pendingTools = [];
    toolById.clear();
    pendingUsage = undefined;
    pendingLatencyMs = undefined;
    pendingStreamMs = undefined;
    pendingTs = 0;
  };

  for (const ev of events) {
    lineIdx += 1;
    const ts = parseIsoMs(ev.timestamp);
    const pl = ev.payload || {};

    if (ev.type === 'session_meta') {
      // 可从 meta 取默认信息
      continue;
    }

    if (ev.type === 'turn_context') {
      if (pl.model) currentModel = pl.model;
      if (pl.turn_id) currentTurnId = pl.turn_id;
      continue;
    }

    if (ev.type === 'event_msg') {
      const subtype = pl.type;

      if (subtype === 'task_started') {
        flushAssistant();
        currentTurnId = pl.turn_id || currentTurnId;
        turnStartedAtMs = typeof pl.started_at === 'number'
          ? (pl.started_at < 1e12 ? pl.started_at * 1000 : pl.started_at)
          : ts;
        continue;
      }

      if (subtype === 'user_message') {
        flushAssistant();
        const text = (pl.message || '').trim();
        if (!text) continue;
        const uuid = stableId(`${sessionId}:user:${lineIdx}:${ts}`);
        lastUserUuid = uuid;
        messages.push({
          uuid,
          sessionId,
          role: 'user',
          timestamp: ts || Date.now(),
          text,
          toolCalls: [],
          parts: [{ type: 'text', text, state: 'done' }],
          model: currentModel,
          turnId: currentTurnId,
        });
        continue;
      }

      if (subtype === 'agent_reasoning') {
        const think = (pl.text || '').trim();
        if (!think) continue;
        pendingThinking = pendingThinking ? `${pendingThinking}\n${think}` : think;
        pendingParts.push({ type: 'reasoning', text: think, state: 'done' });
        pendingTs = ts || pendingTs;
        continue;
      }

      if (subtype === 'agent_message') {
        const text = (pl.message || '').trim();
        if (text) {
          pendingText = pendingText ? `${pendingText}\n${text}` : text;
          pendingParts.push({ type: 'text', text, state: 'done' });
        }
        pendingTs = ts || pendingTs;
        continue;
      }

      if (subtype === 'token_count') {
        pendingUsage = parseUsageFromTokenCount(pl.info);
        pendingTs = ts || pendingTs;
        continue;
      }

      if (subtype === 'task_complete') {
        const durationMs = typeof pl.duration_ms === 'number' ? pl.duration_ms : undefined;
        const ttft = typeof pl.time_to_first_token_ms === 'number' ? pl.time_to_first_token_ms : undefined;
        if (ttft != null) pendingLatencyMs = ttft;
        if (durationMs != null && ttft != null) {
          pendingStreamMs = Math.max(0, durationMs - ttft);
        } else if (durationMs != null) {
          pendingStreamMs = durationMs;
        }
        if (typeof pl.completed_at === 'number') {
          const completedMs = pl.completed_at < 1e12 ? pl.completed_at * 1000 : pl.completed_at;
          pendingTs = completedMs;
        } else {
          pendingTs = ts || pendingTs;
        }
        flushAssistant();
        continue;
      }

      if (subtype === 'turn_aborted') {
        flushAssistant();
        continue;
      }

      // P1: 用户回滚最近 N 个 user turn
      if (subtype === 'thread_rolled_back') {
        flushAssistant();
        const n = typeof pl.num_turns === 'number' ? pl.num_turns : 0;
        if (n > 0) {
          const kept = dropLastUserTurns(messages, n);
          messages.length = 0;
          messages.push(...kept);
          // 重置 last user 锚点
          const lastUser = [...messages].reverse().find((m) => m.role === 'user');
          lastUserUuid = lastUser?.uuid;
        }
        continue;
      }

      continue;
    }

    if (ev.type === 'response_item') {
      const itemType = pl.type;

      if (itemType === 'reasoning') {
        const think = extractThinkingFromReasoning(pl).trim();
        // event_msg.agent_reasoning 已覆盖时跳过重复
        if (think && !pendingThinking.includes(think)) {
          pendingThinking = pendingThinking ? `${pendingThinking}\n${think}` : think;
          pendingParts.push({ type: 'reasoning', text: think, state: 'done' });
          pendingTs = ts || pendingTs;
        }
        continue;
      }

      if (itemType === 'function_call') {
        const callId = pl.call_id || pl.id || stableId(`${sessionId}:tool:${lineIdx}`);
        const name = pl.name || 'unknown';
        const args = parseToolArgs(pl.arguments ?? pl.args);
        const tc: CodexToolCallItem = { toolCallId: callId, name, args };
        pendingTools.push(tc);
        toolById.set(callId, tc);
        pendingParts.push({
          type: 'tool',
          tool: name,
          callID: callId,
          state: { status: 'calling', input: args, output: undefined, title: name },
        });
        pendingTs = ts || pendingTs;
        continue;
      }

      if (itemType === 'function_call_output') {
        const callId = pl.call_id || pl.id;
        const output = pl.output ?? pl.result;
        if (callId && toolById.has(callId)) {
          const tc = toolById.get(callId)!;
          tc.result = output;
          const part = pendingParts.find((p) => p.type === 'tool' && p.callID === callId);
          if (part) {
            part.state.status = 'completed';
            part.state.output = output;
          }
        }
        pendingTs = ts || pendingTs;
        continue;
      }

      // response_item.message：compact replacement 或 event_msg 缺失时的 fallback
      if (itemType === 'message' && pl.role === 'user') {
        flushAssistant();
        const text = extractTextFromContent(pl.content).trim();
        if (!text) continue;
        const uuid = stableId(`${sessionId}:user:ri:${lineIdx}:${ts}`);
        lastUserUuid = uuid;
        messages.push({
          uuid,
          sessionId,
          role: 'user',
          timestamp: ts || Date.now(),
          text,
          toolCalls: [],
          parts: [{ type: 'text', text, state: 'done' }],
          model: currentModel,
          turnId: currentTurnId,
        });
        continue;
      }

      if (itemType === 'message' && pl.role === 'assistant') {
        const text = extractTextFromContent(pl.content).trim();
        if (text && !pendingText.includes(text)) {
          pendingText = pendingText ? `${pendingText}\n${text}` : text;
          pendingParts.push({ type: 'text', text, state: 'done' });
          pendingTs = ts || pendingTs;
        }
      }
    }
  }

  flushAssistant();
  return messages.sort((a, b) => a.timestamp - b.timestamp);
}

export async function getCodexSessionUsageSummary(sessionIdOrPath: string): Promise<{
  input: number;
  output: number;
  cacheRead: number;
  reasoning: number;
  total: number;
  model?: string;
}> {
  let rolloutPath = sessionIdOrPath;
  const resolved = resolveExistingRolloutPath(rolloutPath);
  if (!resolved) {
    const session = await findCodexSession(sessionIdOrPath);
    if (!session) throw new Error(`Codex session not found: ${sessionIdOrPath}`);
    rolloutPath = session.rolloutPath;
  } else {
    rolloutPath = resolved;
  }

  // usage 统计：用未 compact 的原始事件更准确（compact 后 token_count 可能不全）
  // 但若仅有 zst/compact 后文件，仍用 readRolloutEvents 的后续 token_count
  const content = readRolloutText(rolloutPath);
  const rawEvents = parseRolloutLines(content);
  const events = applyCodexCompaction(rawEvents);
  const summary = { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0, model: undefined as string | undefined };

  // 优先扫 compact 后时间线里的 token_count；若无则扫全量 raw
  const countFrom = (list: RolloutEvent[]) => {
    for (const ev of list) {
      if (ev.type === 'turn_context' && ev.payload?.model && !summary.model) {
        summary.model = ev.payload.model;
      }
      if (ev.type === 'event_msg' && ev.payload?.type === 'token_count') {
        const u = parseUsageFromTokenCount(ev.payload.info);
        if (!u) continue;
        summary.input += u.input;
        summary.output += u.output;
        summary.cacheRead += u.cacheRead;
        summary.reasoning += u.reasoning;
        summary.total += u.total;
      }
    }
  };
  countFrom(events);
  // compact 基线后若没有任何 token_count，回退 raw（避免归零）
  if (summary.total === 0 && events !== rawEvents) {
    summary.input = 0;
    summary.output = 0;
    summary.cacheRead = 0;
    summary.reasoning = 0;
    summary.total = 0;
    countFrom(rawEvents);
  }

  return summary;
}

export function closeCodexDb(): void {
  try {
    closeSqliteDb(SQLITE_INSTANCE);
  } catch {
    // ignore
  }
}

// ==================== CLI 测试入口 ====================

if (require.main === module) {
  (async () => {
    const sessions = await listCodexSessions();
    console.log(`共 ${sessions.length} 个 codex sessions`);
    if (sessions.length > 0) {
      const last = sessions[0];
      console.log('最新 session:', {
        id: last.sessionId,
        title: last.title,
        model: last.model,
        tokens: last.tokensUsed,
        cwd: last.workDir,
      });
      const msgs = await listCodexMessages({ sessionId: last.sessionId, rolloutPath: last.rolloutPath });
      console.log(`共 ${msgs.length} 条消息`);
      for (const m of msgs.slice(0, 10)) {
        console.log(
          `[${m.role}] ${(m.text || m.thinking || '').slice(0, 80).replace(/\n/g, ' ')} ` +
            `tokens=${JSON.stringify(m.usage)} tools=${m.toolCalls.length}`,
        );
      }
      const usage = await getCodexSessionUsageSummary(last.sessionId);
      console.log('usage summary:', usage);
    }
  })();
}
