/**
 * Grok Build CLI 本地数据访问服务
 * 读取 ~/.grok/sessions/<encoded-cwd>/<session-uuid>/ 下的:
 *   summary.json + chat_history.jsonl + compaction_requests/ (compact 前原始消息)
 * 参考 Kimi Code 集成方式 (issues/2)
 *
 * compact 数据还原: chat_history.jsonl compact 后旧消息被替换为续写摘要;
 * compaction_requests/<uuid>.json 的 chat_history 字段保存了 compact 前的完整消息,
 * listGrokCodeMessages 会自动合并还原。
 *
 * TODO(issue #16): grok-build@3af4d5d3 (2026-07-21) 起 updates.jsonl 的 turn_completed
 * 携带真实 PromptUsage（input/output/cache/reasoning/costUsdTicks）。优先 tryReadGrokRealUsage；
 * 旧 session 无 usage 时回落 context 快照估算。探测脚本: scripts/bash/probe-grok-usage-format.ts
 *
 * 数据通路:
 * - 真实: params.update.sessionUpdate=turn_completed → params.update.usage
 * - 估算: params._meta.totalTokens 上下文窗口快照 + GROK_CONTEXT_TOKEN_SPLIT_PCT
 */

import os from 'os';
import { readJsonlCached, readJsonlCachedAsync } from '../lib/jsonl-cache';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const HOMEDIR = os.homedir();
const GROK_SESSIONS_ROOT = path.join(HOMEDIR, '.grok', 'sessions');

/**
 * 无分项用量时，按上下文总量拆成 cache / input / output 预估（百分比）。
 * 仅作旧 session / 无 turn_completed.usage 时的 fallback。
 */
export const GROK_CONTEXT_TOKEN_SPLIT_PCT = {
  cacheRead: 95,
  input: 4.2,
  output: 0.8,
} as const;

/** grok-build cost_usd_ticks：1 tick = 1e-10 USD */
export const GROK_COST_USD_TICK = 1e-10;

export function ticksToUsd(ticks: number | undefined | null): number | null {
  if (ticks == null || !Number.isFinite(ticks)) return null;
  return ticks * GROK_COST_USD_TICK;
}

/**
 * 归一化 Grok model id（chat_history / turn_completed.modelUsage / summary.current_model_id）
 * - wire 常用 `grok-4.5-build`，计价表与 summary 为 `grok-4.5` → 剥掉版本后的 `-build` 后缀
 * - 单独的 `grok-build` 是旧产品名，保留（勿当成 4.5）
 * - 禁止用 `grok-build` 做缺省猜测
 */
export function normalizeGrokModelId(
  raw?: string | null,
  fallback?: string | null,
): string | undefined {
  const pick = (v?: string | null) => {
    const s = (v || '').trim();
    return s || undefined;
  };
  const id = pick(raw) || pick(fallback);
  if (!id) return undefined;
  // grok-4.5-build / grok-3-build → grok-4.5 / grok-3
  const versionBuild = id.match(/^(grok-\d+(?:\.\d+)?)-build$/i);
  if (versionBuild) return versionBuild[1];
  return id;
}

/**
 * 将 context window 快照总量按经验比例拆为 cache / input / output。
 * 仅 fallback；有真实 usage 时不要走这里。
 */
export function splitGrokContextTokens(total: number): {
  total: number;
  cacheRead: number;
  input: number;
  output: number;
  reasoning: number;
} {
  if (total <= 0) {
    return { total: 0, cacheRead: 0, input: 0, output: 0, reasoning: 0 };
  }
  const { cacheRead: cPct, input: iPct, output: oPct } = GROK_CONTEXT_TOKEN_SPLIT_PCT;
  const sum = cPct + iPct + oPct;
  const cacheRead = Math.round((total * cPct) / sum);
  const input = Math.round((total * iPct) / sum);
  const output = Math.max(0, total - cacheRead - input);
  return { total, cacheRead, input, output, reasoning: 0 };
}

// ==================== 类型 ====================

export type GrokSubagentMeta = {
  parentId: string;
  childSessionId: string;
  tokensUsed?: number;
  toolCalls?: number;
  turns?: number;
  durationMs?: number;
};

export type GrokSessionItem = {
  sessionId: string;
  sessionDir: string;
  workDir: string; // cwd
  title: string;
  createdAt: number;
  updatedAt: number;
  numMessages?: number;
  numChatMessages?: number;
  modelId?: string;
  parentId?: string;
  subagentMeta?: GrokSubagentMeta;
  /** 该 session 作为 parent 时，其直接 subagent 的元数据 */
  subagentChildren?: GrokSubagentMeta[];
};

export type GrokMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; state?: 'done' | 'pending' };

/** turn_completed.usage / modelUsage 单项（camelCase，与 grok-build wire 一致） */
export type GrokPromptUsageModel = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens: number;
  reasoningTokens: number;
  modelCalls: number;
  apiDurationMs: number;
  costUsdTicks?: number;
};

/** 单次 turn_completed 的 usage */
export type GrokTurnRealUsage = GrokPromptUsageModel & {
  promptId?: string;
  stopReason?: string;
  timestamp?: number;
  numTurns?: number;
  modelUsage: Record<string, GrokPromptUsageModel>;
};

/**
 * session 级真实用量（多 turn 累加）。
 * input = wire.inputTokens - cachedRead（与 claude/kimi 的 non-cache input 对齐）
 */
export type GrokRealUsage = {
  source: 'real';
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  modelCalls: number;
  apiDurationMs: number;
  /** 有 ticks 时优先用；否则 null，由定价表估算 */
  costUsd: number | null;
  costUsdTicks: number | null;
  turnCount: number;
  modelUsage: Record<string, GrokPromptUsageModel>;
  turns: GrokTurnRealUsage[];
};

export type GrokMessageItem = {
  uuid: string;
  sessionId: string;
  role: 'user' | 'assistant';
  timestamp: number;
  text: string;
  thinking?: string;
  toolCalls: Array<{
    toolCallId: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    /** updates tool_call_update.status 或 chat_history tool_result → completed */
    status?: string;
  }>;
  model?: string;
  parentID?: string;
  parts?: GrokMessagePart[];
  /**
   * 来自 updates.jsonl 的该 assistant 步骤对应时刻的 totalTokens（上下文窗口快照）。
   * 不是真实计费 token，仅反映该步骤发生时模型上下文的大小，用于 UI 展示与 session 总用量估算。
   */
  contextTokens?: number;
  /**
   * 若该步骤能挂上 turn_completed.usage（当前仅 session 聚合有可靠数据），
   * 则带真实分项；否则 undefined，走 context 估算。
   */
  realUsage?: {
    input: number;
    output: number;
    cached: number;
    reasoning: number;
    costUsdTicks?: number;
  };
};

/**
 * updates.jsonl 中 params._meta.totalTokens 的快照聚合。
 * 无真实 usage 时的 fallback；有 tryReadGrokRealUsage 时 session total 不依赖此。
 */
export type GrokTurnTokenSnapshot = {
  turnStartMs: number;
  promptId?: string;
  minTotalTokens: number;
  maxTotalTokens: number;
  /** 该 turn 内按时间顺序的所有 totalTokens 快照，用于给中间 assistant 步骤挂 context */
  snapshots?: number[];
};

/**
 * Grok 会话 token 估算结果（context 快照路径）。
 * hasGranularUsage 在存在 turn_completed.usage 时为 true。
 */
export type GrokSessionTokenEstimate = {
  hasGranularUsage: boolean;
  finalContextTokens: number;
  turns: GrokTurnTokenSnapshot[];
};

/**
 * 列表/详情会话总用量估算：各 assistant 步骤 context 快照之和。
 * 这是“各步骤发生时上下文大小”的累加，不是 xAI 的真实计费 token；仅用于在没有真实 usage 时
 * 让 session total 与每个步骤的 token 展示保持数量级一致。
 */
export function grokSumAssistantContextTokens(messages: GrokMessageItem[]): number {
  return messages
    .filter((m) => m.role === 'assistant')
    .reduce((sum, m) => sum + (m.contextTokens ?? 0), 0);
}

// ==================== 工具函数 ====================

/** 由 sessionId + jsonl 行号生成稳定 message id，避免每次请求 randomUUID */
function grokStableMessageId(sessionId: string, lineIndex: number): string {
  const h = createHash('sha256').update(`${sessionId}:${lineIndex}`).digest('hex').slice(0, 32);
  return `grok-${h}`;
}

function findSessionDirById(sessionId: string): string | null {
  if (!fs.existsSync(GROK_SESSIONS_ROOT)) return null;
  try {
    const projDirs = fs.readdirSync(GROK_SESSIONS_ROOT).filter(d => !d.startsWith('.') && !d.endsWith('.sqlite'));
    for (const proj of projDirs) {
      const cand = path.join(GROK_SESSIONS_ROOT, proj, sessionId);
      const sum = path.join(cand, 'summary.json');
      if (fs.existsSync(sum)) return cand;
    }
  } catch {}
  return null;
}

function parseSummary(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 扫描所有 Grok session 的 updates.jsonl，提取 subagent 元数据。
 * Grok subagent 的 parent 关系与真实用量（subagent_finished.tokens_used）
 * 都只记录在 parent session 的 updates.jsonl 里。
 */
function scanGrokSubagentMetaMap(): Promise<Map<string, GrokSubagentMeta>> {
  return scanGrokSubagentRelations().then(r => r.metaByChild);
}

/**
 * 扫描所有 Grok session 的 updates.jsonl，提取 subagent 的 parent/children 关系。
 * 返回按 childId 索引的 meta 映射，以及按 parentId 索引的子 agent 列表。
 */
export async function scanGrokSubagentRelations(): Promise<{
  metaByChild: Map<string, GrokSubagentMeta>;
  childrenByParent: Map<string, GrokSubagentMeta[]>;
}> {
  const metaByChild = new Map<string, GrokSubagentMeta>();
  const childrenByParent = new Map<string, GrokSubagentMeta[]>();
  if (!fs.existsSync(GROK_SESSIONS_ROOT)) return { metaByChild, childrenByParent };

  let projDirs: string[] = [];
  try {
    projDirs = fs.readdirSync(GROK_SESSIONS_ROOT).filter((d) => {
      const full = path.join(GROK_SESSIONS_ROOT, d);
      return fs.statSync(full).isDirectory() && !d.endsWith('.sqlite');
    });
  } catch {
    return { metaByChild, childrenByParent };
  }

  // 先收集全部 updates.jsonl 路径, 再并发异步读取 (IO 交错, mtime 缓存与 convert 复用)
  const updatesPaths: string[] = [];
  for (const projEnc of projDirs) {
    const projDir = path.join(GROK_SESSIONS_ROOT, projEnc);
    let sessIds: string[] = [];
    try {
      sessIds = fs.readdirSync(projDir).filter((d) => {
        const full = path.join(projDir, d);
        return fs.statSync(full).isDirectory();
      });
    } catch { continue; }
    for (const sid of sessIds) {
      updatesPaths.push(path.join(projDir, sid, 'updates.jsonl'));
    }
  }

  const allRows = await Promise.all(updatesPaths.map(p => readJsonlCachedAsync(p)));
  for (const rows of allRows) {
    if (!rows) continue;
    try {
      for (const row of rows) {
        const update = row?.params?.update;
        if (!isGrokSessionUpdateMethod(row?.method)) continue;
        const childId = update?.child_session_id || update?.subagent_id;
        if (!childId) continue;

        if (update?.sessionUpdate === 'subagent_spawned') {
          const parentId = update?.parent_session_id;
          if (parentId && childId !== parentId) {
            const existing = metaByChild.get(childId);
            metaByChild.set(childId, {
              ...existing,
              parentId,
              childSessionId: childId,
            });
          }
        } else if (update?.sessionUpdate === 'subagent_finished') {
          const meta: Partial<GrokSubagentMeta> = metaByChild.get(childId) || {
            parentId: update?.parent_session_id,
            childSessionId: childId,
          };
          meta.childSessionId = childId;
          meta.tokensUsed = typeof update?.tokens_used === 'number' ? update.tokens_used : meta.tokensUsed;
          meta.toolCalls = typeof update?.tool_calls === 'number' ? update.tool_calls : meta.toolCalls;
          meta.turns = typeof update?.turns === 'number' ? update.turns : meta.turns;
          meta.durationMs = typeof update?.duration_ms === 'number' ? update.duration_ms : meta.durationMs;
          if (meta.parentId) {
            const final = meta as GrokSubagentMeta;
            metaByChild.set(childId, final);
            const siblings = childrenByParent.get(final.parentId) || [];
            // 同一 subagent 可能 finish 多次，去重保留最新
            const idx = siblings.findIndex((s) => s.childSessionId === childId);
            if (idx >= 0) siblings[idx] = final;
            else siblings.push(final);
            childrenByParent.set(final.parentId, siblings);
          }
        }
      }
    } catch { /* ignore single file errors */ }
  }

  return { metaByChild, childrenByParent };
}

// ==================== Session 列表 ====================

export async function listGrokCodeSessions(): Promise<GrokSessionItem[]> {
  if (!fs.existsSync(GROK_SESSIONS_ROOT)) return [];

  // 提前扫描所有 session 的 updates.jsonl，建立 subagent 元数据映射
  const { metaByChild, childrenByParent } = await scanGrokSubagentRelations();

  const sessions: GrokSessionItem[] = [];
  let projDirs: string[] = [];
  try {
    projDirs = fs.readdirSync(GROK_SESSIONS_ROOT).filter((d) => {
      const full = path.join(GROK_SESSIONS_ROOT, d);
      return fs.statSync(full).isDirectory() && !d.endsWith('.sqlite');
    });
  } catch {
    return [];
  }

  for (const projEnc of projDirs) {
    const projDir = path.join(GROK_SESSIONS_ROOT, projEnc);
    let sessIds: string[] = [];
    try {
      sessIds = fs.readdirSync(projDir).filter((d) => {
        const full = path.join(projDir, d);
        return fs.statSync(full).isDirectory();
      });
    } catch { continue; }

    for (const sid of sessIds) {
      const sumPath = path.join(projDir, sid, 'summary.json');
      const sum = parseSummary(sumPath);
      if (!sum || !sum.info || !sum.info.id) continue;

      const cwd = sum.info.cwd || decodeURIComponent(projEnc);
      const title = sum.generated_title || sum.session_summary || 'Untitled';
      const created = sum.created_at ? new Date(sum.created_at).getTime() : 0;
      // Grok CLI 会持续刷新 updated_at（可能是心跳/空闲状态），用 last_active_at 更准确
      const updated = sum.last_active_at
        ? new Date(sum.last_active_at).getTime()
        : (sum.updated_at ? new Date(sum.updated_at).getTime() : created);

      const sessionId = sum.info.id;
      const subagentMeta = metaByChild.get(sessionId);
      sessions.push({
        sessionId,
        sessionDir: path.join(projDir, sid),
        workDir: cwd,
        title: title || 'Untitled',
        createdAt: created,
        updatedAt: updated,
        numMessages: sum.num_messages,
        numChatMessages: sum.num_chat_messages,
        modelId: sum.current_model_id,
        parentId: subagentMeta?.parentId,
        subagentMeta,
        subagentChildren: childrenByParent.get(sessionId),
      });
    }
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ==================== 消息重建 (chat_history.jsonl) ====================

function readUpdatesJsonl(sessionDir: string): any[] {
  const p = path.join(sessionDir, 'updates.jsonl');
  return readJsonlCached(p) ?? [];
}

function parseUsageModel(raw: any): GrokPromptUsageModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const inputTokens = Number(raw.inputTokens) || 0;
  const outputTokens = Number(raw.outputTokens) || 0;
  const totalTokens = Number(raw.totalTokens) || inputTokens + outputTokens;
  const cachedReadTokens = Number(raw.cachedReadTokens) || 0;
  const reasoningTokens = Number(raw.reasoningTokens) || 0;
  const modelCalls = Number(raw.modelCalls) || 0;
  const apiDurationMs = Number(raw.apiDurationMs) || 0;
  const costUsdTicks = raw.costUsdTicks != null && Number.isFinite(Number(raw.costUsdTicks))
    ? Number(raw.costUsdTicks)
    : undefined;
  // 至少要有 token 或 cost，避免空对象
  if (totalTokens <= 0 && !costUsdTicks && modelCalls <= 0) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedReadTokens,
    reasoningTokens,
    modelCalls,
    apiDurationMs,
    costUsdTicks,
  };
}

/**
 * 读取 session 真实 usage（grok-build ≥ 7-21 / CLI 含 PromptUsage）。
 * 来源: updates.jsonl → turn_completed.usage，多 turn 累加。
 * 旧 session 无此字段时返回 null。
 */
export function tryReadGrokRealUsage(sessionDir: string): GrokRealUsage | null {
  if (!sessionDir || !fs.existsSync(sessionDir)) return null;
  const rows = readUpdatesJsonl(sessionDir);
  const turns: GrokTurnRealUsage[] = [];

  for (const row of rows) {
    if (!isGrokSessionUpdateMethod(row?.method)) continue;
    const update = row?.params?.update;
    const rawUsage = update?.usage;
    if (!rawUsage) continue;
    // 主通路 turn_completed；兼容其它带 usage 的 update
    if (update.sessionUpdate && update.sessionUpdate !== 'turn_completed') continue;

    const base = parseUsageModel(rawUsage);
    if (!base) continue;

    const modelUsage: Record<string, GrokPromptUsageModel> = {};
    if (rawUsage.modelUsage && typeof rawUsage.modelUsage === 'object') {
      for (const [mid, mu] of Object.entries(rawUsage.modelUsage)) {
        const parsed = parseUsageModel(mu);
        if (parsed) modelUsage[mid] = parsed;
      }
    }

    turns.push({
      ...base,
      promptId: typeof update.prompt_id === 'string' ? update.prompt_id : undefined,
      stopReason: typeof update.stop_reason === 'string' ? update.stop_reason : undefined,
      timestamp: typeof row.timestamp === 'number'
        ? row.timestamp
        : (typeof row?.params?._meta?.agentTimestampMs === 'number'
          ? row.params._meta.agentTimestampMs
          : undefined),
      numTurns: Number(rawUsage.numTurns) || undefined,
      modelUsage,
    });
  }

  if (!turns.length) return null;

  let inputTokens = 0;
  let output = 0;
  let total = 0;
  let cacheRead = 0;
  let reasoning = 0;
  let modelCalls = 0;
  let apiDurationMs = 0;
  let costUsdTicks: number | null = null;
  let ticksSeen = false;
  const modelUsageAcc = new Map<string, GrokPromptUsageModel>();

  for (const t of turns) {
    inputTokens += t.inputTokens;
    output += t.outputTokens;
    total += t.totalTokens;
    cacheRead += t.cachedReadTokens;
    reasoning += t.reasoningTokens;
    modelCalls += t.modelCalls;
    apiDurationMs += t.apiDurationMs;
    if (t.costUsdTicks != null) {
      costUsdTicks = (costUsdTicks ?? 0) + t.costUsdTicks;
      ticksSeen = true;
    }
    for (const [mid, mu] of Object.entries(t.modelUsage)) {
      const prev = modelUsageAcc.get(mid);
      if (!prev) {
        modelUsageAcc.set(mid, { ...mu });
      } else {
        prev.inputTokens += mu.inputTokens;
        prev.outputTokens += mu.outputTokens;
        prev.totalTokens += mu.totalTokens;
        prev.cachedReadTokens += mu.cachedReadTokens;
        prev.reasoningTokens += mu.reasoningTokens;
        prev.modelCalls += mu.modelCalls;
        prev.apiDurationMs += mu.apiDurationMs;
        if (mu.costUsdTicks != null) {
          prev.costUsdTicks = (prev.costUsdTicks ?? 0) + mu.costUsdTicks;
        }
      }
    }
  }

  // wire.inputTokens 含 cache 部分（totalTokens ≈ inputTokens + outputTokens）
  const input = Math.max(0, inputTokens - cacheRead);

  return {
    source: 'real',
    input,
    output,
    total: total || input + cacheRead + output,
    cacheRead,
    cacheWrite: 0,
    reasoning,
    modelCalls,
    apiDurationMs,
    costUsd: ticksSeen ? ticksToUsd(costUsdTicks) : null,
    costUsdTicks: ticksSeen ? costUsdTicks : null,
    turnCount: turns.length,
    modelUsage: Object.fromEntries(modelUsageAcc),
    turns,
  };
}

/**
 * 从 updates.jsonl 按 turnStartMs 聚合 totalTokens 快照。
 * 注意: 这些 totalTokens 只是上下文窗口大小，不是真实 usage，聚合结果用于 fallback 估算。
 */
export function parseGrokUpdatesTokenEstimate(sessionDir: string): GrokSessionTokenEstimate {
  const rows = readUpdatesJsonl(sessionDir);
  const byTurn = new Map<number, GrokTurnTokenSnapshot>();
  let hasRealUsage = false;

  for (const row of rows) {
    if (row?.method === '_x.ai/session/update' && row?.params?.update?.usage) {
      hasRealUsage = true;
    }
    const meta = row?.params?._meta;
    const total = meta?.totalTokens;
    const turnStartMs = meta?.turnStartMs;
    if (typeof total !== 'number' || typeof turnStartMs !== 'number') continue;

    let snap = byTurn.get(turnStartMs);
    if (!snap) {
      snap = {
        turnStartMs,
        promptId: meta.promptId,
        minTotalTokens: total,
        maxTotalTokens: total,
        snapshots: [total],
      };
      byTurn.set(turnStartMs, snap);
    } else {
      snap.minTotalTokens = Math.min(snap.minTotalTokens, total);
      snap.maxTotalTokens = Math.max(snap.maxTotalTokens, total);
      snap.snapshots!.push(total);
      if (!snap.promptId && meta.promptId) snap.promptId = meta.promptId;
    }
  }

  const turns = Array.from(byTurn.values()).sort((a, b) => a.turnStartMs - b.turnStartMs);
  const finalContextTokens = turns.length ? turns[turns.length - 1].maxTotalTokens : 0;

  return {
    hasGranularUsage: hasRealUsage,
    finalContextTokens,
    turns,
  };
}

/**
 * 从 updates 取真实 user turn 开始时间（ms）。
 * 优先 `_meta.turnStartMs`（与 token estimate 同源）；否则用 user_message_chunk 的 promptIndex 首包。
 */
export function readGrokUserTurnStartMs(sessionDir: string): number[] {
  const fromMeta = parseGrokUpdatesTokenEstimate(sessionDir).turns
    .map((t) => t.turnStartMs)
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 1e11);
  if (fromMeta.length > 0) return fromMeta;

  const rows = readUpdatesJsonl(sessionDir);
  const byPrompt = new Map<number, number>();
  for (const row of rows) {
    const update = row?.params?.update;
    if (update?.sessionUpdate !== 'user_message_chunk') continue;
    const promptIndex = update?._meta?.promptIndex;
    if (typeof promptIndex !== 'number') continue;
    if (byPrompt.has(promptIndex)) continue;
    const ts = grokWireTsToMs(row.timestamp)
      || grokWireTsToMs(row?.params?._meta?.agentTimestampMs);
    if (ts > 1e11) byPrompt.set(promptIndex, ts);
  }
  return Array.from(byPrompt.entries())
    .sort(([a], [b]) => a - b)
    .map(([, ts]) => ts);
}

/**
 * chat_history 无真实墙钟；合成 timestamp 从 last_active 起 +1ms，跨天 session 的
 * userParts 日 badge 会全落在结束日。用 turnStartMs 回填 user turn；同 turn 内 +offset 保序。
 * 无锚点时按 created→lastActive 线性插值。
 */
export function attachGrokWallClockTimestamps(
  messages: GrokMessageItem[],
  opts: { turnStartMs?: number[]; createdMs?: number; lastActiveMs?: number },
): void {
  if (!messages.length) return;
  const anchors = (opts.turnStartMs || []).filter(
    (t) => typeof t === 'number' && Number.isFinite(t) && t > 1e11,
  );

  if (anchors.length > 0) {
    let turnIdx = -1;
    let offset = 0;
    for (const m of messages) {
      const isUserQuery = m.role === 'user' && m.text.includes('<user_query>');
      if (isUserQuery) {
        turnIdx++;
        offset = 0;
        if (turnIdx < anchors.length) m.timestamp = anchors[turnIdx];
        continue;
      }
      if (turnIdx >= 0 && turnIdx < anchors.length) {
        offset += 1;
        m.timestamp = anchors[turnIdx] + offset;
      }
    }
    return;
  }

  const start = opts.createdMs;
  const end = opts.lastActiveMs;
  if (!start || !end || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  const n = messages.length;
  if (n === 1) {
    messages[0].timestamp = start;
    return;
  }
  for (let i = 0; i < n; i++) {
    messages[i].timestamp = Math.round(start + ((end - start) * i) / (n - 1));
  }
}

/**
 * 应跳过的注入噪声（不进 msgs / trend）。
 * 注意：compact 续写摘要 (This session is being continued...) 在上游 merge 阶段已剥离；
 * compaction_requests 保存了 compact 前的完整 chat_history，无需再依赖摘要行。
 */
export function isGrokSyntheticUserText(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return true;
  if (t === '[system]') return true;
  if (t.includes('<user_info>') || t.includes('<system-reminder>')) return true;
  return false;
}

/** compact / resume 续写摘要：保留展示，但不抢 parentID、不占趋势轮次锚点 */
export function isGrokContinuationSummary(text: string): boolean {
  return /^This session is being continued from a previous conversation/i.test((text || '').trim());
}

/** 按 <user_query> 轮次分桶 assistant 步骤（subagent 无 query 时整段一条） */
function bucketAssistantsByUserTurn(messages: GrokMessageItem[]): GrokMessageItem[][] {
  type TurnBucket = { assistants: GrokMessageItem[] };
  const buckets: TurnBucket[] = [];
  let current: TurnBucket | null = null;
  let hasExplicitQuery = false;

  for (const msg of messages) {
    if (msg.role === 'user' && msg.text.includes('<user_query>')) {
      hasExplicitQuery = true;
      current = { assistants: [] };
      buckets.push(current);
      continue;
    }
    if (msg.role === 'assistant' && current) {
      current.assistants.push(msg);
    }
  }

  if (!hasExplicitQuery && buckets.length === 0) {
    const firstRealUserIdx = messages.findIndex(
      (m) => m.role === 'user' && !isGrokSyntheticUserText(m.text),
    );
    if (firstRealUserIdx >= 0) {
      current = { assistants: [] };
      buckets.push(current);
      for (let i = firstRealUserIdx + 1; i < messages.length; i++) {
        if (messages[i].role === 'assistant') current.assistants.push(messages[i]);
      }
    }
  }

  return buckets.map((b) => b.assistants);
}

/**
 * 把 updates 里的 context 窗口快照挂到 assistant。
 * estimate.turns 是 API/agent 轮次，数量常 > user_query 桶；1:1 会对齐截断，
 * 末尾 high-context 快照（compact 后继续涨）会丢。按桶权重分完所有 turn。
 */
function attachContextTokensToMessages(
  messages: GrokMessageItem[],
  estimate: GrokSessionTokenEstimate,
): void {
  const turns = estimate.turns;
  if (!turns.length) return;

  const activeBuckets = bucketAssistantsByUserTurn(messages).filter(b => b.length > 0);
  if (!activeBuckets.length) return;

  const weights = activeBuckets.map(b => b.length);
  const quotas = allocateTurnQuotas(weights, turns.length);

  let turnIdx = 0;
  for (let bi = 0; bi < activeBuckets.length; bi++) {
    const assistants = activeBuckets[bi];
    const q = quotas[bi] || 0;
    const slice = q > 0 ? turns.slice(turnIdx, turnIdx + q) : [];
    turnIdx += q;

    // 合并该桶分到的各 turn 的 snapshots（时间序），再按 assistant 下标插值
    const allSnaps: number[] = [];
    for (const t of slice) {
      const snaps = t.snapshots?.length ? t.snapshots : [t.maxTotalTokens];
      for (const s of snaps) {
        if (typeof s === 'number' && s > 0) allSnaps.push(s);
      }
      if (!t.snapshots?.length && t.maxTotalTokens > 0) {
        // already pushed via fallback above
      }
    }
    if (!allSnaps.length) continue;

    const n = assistants.length;
    for (let i = 0; i < n; i++) {
      const snapIdx = n === 1
        ? allSnaps.length - 1
        : Math.round((i * (allSnaps.length - 1)) / (n - 1));
      assistants[i].contextTokens = allSnaps[snapIdx];
    }
  }
}

/** 按权重把 T 个 turn 分给 B 个桶；T>=B 时每桶至少 1 */
export function allocateTurnQuotas(weights: number[], turnCount: number): number[] {
  const B = weights.length;
  const quotas = new Array(B).fill(0);
  if (B === 0 || turnCount <= 0) return quotas;
  if (turnCount <= B) {
    for (let i = 0; i < turnCount; i++) quotas[i] = 1;
    return quotas;
  }
  for (let i = 0; i < B; i++) quotas[i] = 1;
  let rem = turnCount - B;
  const totalW = weights.reduce((a, b) => a + b, 0) || 1;
  const exact = weights.map(w => (rem * w) / totalW);
  const floors = exact.map(Math.floor);
  for (let i = 0; i < B; i++) quotas[i] += floors[i];
  let left = rem - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, frac: e - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < left; k++) quotas[order[k].i]++;
  return quotas;
}

function mergeGrokTurns(turns: GrokTurnRealUsage[]): GrokTurnRealUsage {
  const acc: GrokTurnRealUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedReadTokens: 0,
    reasoningTokens: 0,
    modelCalls: 0,
    apiDurationMs: 0,
    modelUsage: {},
  };
  let ticks: number | null = null;
  for (const t of turns) {
    acc.inputTokens += t.inputTokens || 0;
    acc.outputTokens += t.outputTokens || 0;
    acc.totalTokens += t.totalTokens || 0;
    acc.cachedReadTokens += t.cachedReadTokens || 0;
    acc.reasoningTokens += t.reasoningTokens || 0;
    acc.modelCalls += t.modelCalls || 0;
    acc.apiDurationMs += t.apiDurationMs || 0;
    if (t.costUsdTicks != null) ticks = (ticks ?? 0) + t.costUsdTicks;
    for (const [mid, mu] of Object.entries(t.modelUsage || {})) {
      const prev = acc.modelUsage[mid];
      if (!prev) {
        acc.modelUsage[mid] = { ...mu };
      } else {
        prev.inputTokens += mu.inputTokens || 0;
        prev.outputTokens += mu.outputTokens || 0;
        prev.totalTokens += mu.totalTokens || 0;
        prev.cachedReadTokens += mu.cachedReadTokens || 0;
        prev.reasoningTokens += mu.reasoningTokens || 0;
        prev.modelCalls += mu.modelCalls || 0;
        prev.apiDurationMs += mu.apiDurationMs || 0;
        if (mu.costUsdTicks != null) {
          prev.costUsdTicks = (prev.costUsdTicks ?? 0) + mu.costUsdTicks;
        }
      }
    }
  }
  if (ticks != null) acc.costUsdTicks = ticks;
  return acc;
}

/** 把单个（可已合并的）turn usage 均分到 assistants */
function distributeTurnUsageToAssistants(
  turn: GrokTurnRealUsage,
  assistants: GrokMessageItem[],
): void {
  const n = assistants.length;
  if (n <= 0) return;
  const nonCacheInput = Math.max(0, (turn.inputTokens || 0) - (turn.cachedReadTokens || 0));
  const baseCached = turn.cachedReadTokens || 0;
  const baseOutput = turn.outputTokens || 0;
  const baseReason = turn.reasoningTokens || 0;
  const baseTicks = turn.costUsdTicks;

  const splitInt = (total: number, idx: number) => {
    const q = Math.floor(total / n);
    const r = total - q * n;
    return q + (idx === n - 1 ? r : 0);
  };

  for (let i = 0; i < n; i++) {
    assistants[i].realUsage = {
      input: splitInt(nonCacheInput, i),
      output: splitInt(baseOutput, i),
      cached: splitInt(baseCached, i),
      reasoning: splitInt(baseReason, i),
      costUsdTicks: baseTicks != null
        ? (i === n - 1
          ? baseTicks - Math.floor(baseTicks / n) * (n - 1)
          : Math.floor(baseTicks / n))
        : undefined,
    };
  }
}

/**
 * 从 updates.jsonl 的 turn 序列构建完整 trend（compact 前后都在）。
 * 主轴：estimate.turns（prompt 级 context 快照，通常 ≥ real 且含 pre-compact）。
 * token 增量：按 promptId 对齐 real.turns；无 real 时 delta 为 0（仍保留 context 曲线）。
 *
 * 注意：chat_history 在 compact 后会丢旧 prompt，不能再用 message 分组当 trend 点数。
 */
export function buildGrokTrendsFromTurns(
  real: GrokRealUsage | null | undefined,
  estimate: GrokSessionTokenEstimate | null | undefined,
): Array<{
  userMsgId: string;
  startTime: number;
  endTime: number;
  startTokens: { total: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  endTokens: { total: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  delta: { total: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  msgCount: number;
  contextSize: number;
  deltaCost?: {
    input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number;
  };
  endCost?: {
    input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number;
  };
  /** 该 turn 的 ticks 成本 USD（若有） */
  costUsdTicks?: number;
  modelId?: string;
}> {
  const estTurns = estimate?.turns || [];
  const realTurns = real?.turns || [];
  if (!estTurns.length && !realTurns.length) return [];

  const emptyTok = () => ({
    total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
  });

  // estimate 作主轴（完整 prompt 序列）；否则退化为 real
  type SpineItem = {
    id: string;
    startMs: number;
    contextSize: number;
    promptId?: string;
    real?: GrokTurnRealUsage;
  };

  const realByPrompt = new Map<string, GrokTurnRealUsage>();
  for (const t of realTurns) {
    if (t.promptId) realByPrompt.set(t.promptId, t);
  }
  const usedReal = new Set<GrokTurnRealUsage>();

  const takeReal = (promptId?: string, startMs?: number): GrokTurnRealUsage | undefined => {
    if (promptId && realByPrompt.has(promptId)) {
      const r = realByPrompt.get(promptId)!;
      usedReal.add(r);
      return r;
    }
    // 时间最近的未用 real（秒/毫秒兼容）
    if (startMs == null || !realTurns.length) return undefined;
    let best: GrokTurnRealUsage | undefined;
    let bestDist = Infinity;
    for (const r of realTurns) {
      if (usedReal.has(r)) continue;
      const rms = grokWireTsToMs(r.timestamp);
      if (!rms) continue;
      const d = Math.abs(rms - startMs);
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
    if (best && bestDist < 15 * 60 * 1000) {
      usedReal.add(best);
      return best;
    }
    return undefined;
  };

  let spine: SpineItem[];
  if (estTurns.length > 0) {
    spine = estTurns.map((t, i) => ({
      id: t.promptId || `grok-est-turn-${i}`,
      startMs: t.turnStartMs || 0,
      contextSize: t.maxTotalTokens || 0,
      promptId: t.promptId,
      real: takeReal(t.promptId, t.turnStartMs),
    }));
    // 若有 real 未对齐（极少），追加到末尾以免丢 token
    for (let i = 0; i < realTurns.length; i++) {
      const r = realTurns[i];
      if (usedReal.has(r)) continue;
      spine.push({
        id: r.promptId || `grok-real-orphan-${i}`,
        startMs: grokWireTsToMs(r.timestamp) || 0,
        contextSize: 0,
        promptId: r.promptId,
        real: r,
      });
      usedReal.add(r);
    }
  } else {
    spine = realTurns.map((r, i) => ({
      id: r.promptId || `grok-real-turn-${i}`,
      startMs: grokWireTsToMs(r.timestamp) || 0,
      contextSize: 0,
      promptId: r.promptId,
      real: r,
    }));
  }

  spine.sort((a, b) => a.startMs - b.startMs);

  let cum = emptyTok();
  let cumCost = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const trends: ReturnType<typeof buildGrokTrendsFromTurns> = [];

  for (const s of spine) {
    const ru = s.real;
    const cacheRead = ru?.cachedReadTokens || 0;
    const input = ru ? Math.max(0, (ru.inputTokens || 0) - cacheRead) : 0;
    const output = ru?.outputTokens || 0;
    const reasoning = ru?.reasoningTokens || 0;
    const delta = {
      total: input + output + cacheRead,
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite: 0,
    };
    const startTokens = { ...cum };
    cum = {
      total: cum.total + delta.total,
      input: cum.input + delta.input,
      output: cum.output + delta.output,
      reasoning: cum.reasoning + delta.reasoning,
      cacheRead: cum.cacheRead + delta.cacheRead,
      cacheWrite: 0,
    };

    const modelId = ru
      ? (Object.keys(ru.modelUsage || {}).map(k => normalizeGrokModelId(k)).find(Boolean)
        || normalizeGrokModelId(Object.keys(ru.modelUsage || {})[0]))
      : undefined;

    trends.push({
      userMsgId: s.id,
      startTime: s.startMs,
      endTime: s.startMs,
      startTokens,
      endTokens: { ...cum },
      delta,
      msgCount: ru?.modelCalls || (delta.total > 0 ? 1 : 0),
      contextSize: s.contextSize,
      costUsdTicks: ru?.costUsdTicks,
      modelId,
    });
  }

  return trends;
}

/** updates.jsonl timestamp 秒/毫秒兼容 */
function grokWireTsToMs(ts?: number | null): number {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return 0;
  return ts < 1e12 ? ts * 1000 : ts;
}

/**
 * 把 turn_completed 真实 usage 挂到 assistant 步骤。
 *
 * 重要：wire 的 turn ≠ user_query 桶。一次 user 提问可多轮 tool loop（多个 turn_completed）。
 * 旧逻辑 1:1 按桶下标对齐会丢掉后续 turn（trend 点数/token 都偏少）。
 * 现按「有 assistant 的 user 桶」× assistant 数加权，把全部 turn 分完。
 */
function attachRealUsageToMessages(
  messages: GrokMessageItem[],
  real: GrokRealUsage,
): void {
  if (!real.turns?.length) return;
  const activeBuckets = bucketAssistantsByUserTurn(messages).filter(b => b.length > 0);
  if (!activeBuckets.length) return;

  const turns = real.turns;
  const weights = activeBuckets.map(b => b.length);
  const quotas = allocateTurnQuotas(weights, turns.length);

  let turnIdx = 0;
  for (let bi = 0; bi < activeBuckets.length; bi++) {
    const q = quotas[bi] || 0;
    if (q <= 0) continue;
    const slice = turns.slice(turnIdx, turnIdx + q);
    turnIdx += q;
    if (!slice.length) continue;
    const merged = slice.length === 1 ? slice[0] : mergeGrokTurns(slice);
    distributeTurnUsageToAssistants(merged, activeBuckets[bi]);
  }
}

function pushGrokAssistantStep(
  messages: GrokMessageItem[],
  sessionId: string,
  lineIndex: number,
  parentUserUuid: string | undefined,
  modelId: string | undefined,
  init: Partial<Pick<GrokMessageItem, 'text' | 'thinking' | 'toolCalls' | 'parts'>>,
  /** session.current_model_id 等可信回落；禁止默认成 grok-build */
  fallbackModelId?: string,
): GrokMessageItem {
  const item: GrokMessageItem = {
    uuid: grokStableMessageId(sessionId, lineIndex),
    sessionId,
    role: 'assistant',
    timestamp: 0,
    text: init.text || '',
    thinking: init.thinking,
    toolCalls: init.toolCalls || [],
    model: normalizeGrokModelId(modelId, fallbackModelId),
    parentID: parentUserUuid,
    parts: init.parts || [],
  };
  messages.push(item);
  return item;
}

async function readChatHistory(sessionDir: string): Promise<any[]> {
  const p = path.join(sessionDir, 'chat_history.jsonl');
  return (await readJsonlCachedAsync(p)) ?? [];
}

/** 读取 compaction_requests 目录，返回按 created_at 升序的 pre-compact chat_history 列表 */
function readCompactionRequests(sessionDir: string): { createdAt: string; entries: any[] }[] {
  const dir = path.join(sessionDir, 'compaction_requests');
  if (!fs.existsSync(dir)) return [];
  const results: { createdAt: string; entries: any[] }[] = [];
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const p = path.join(dir, file);
      try {
        const raw = fs.readFileSync(p, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.chat_history) && data.chat_history.length > 0) {
          results.push({ createdAt: data.created_at || '', entries: data.chat_history });
        }
      } catch { /* 跳过损坏文件 */ }
    }
  } catch { return []; }
  results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return results;
}

/** 从 entry 提取文本内容（用于判断续写摘要等） */
function getEntryText(e: any): string {
  if (Array.isArray(e.content)) {
    return e.content.map((c: any) => c.text || '').filter(Boolean).join('\n');
  }
  return String(e.content || '');
}

/** 是否为 compaction prompt（compact 时发给 LLM 的摘要请求，不是真实用户消息） */
function isCompactionPrompt(text: string): boolean {
  return /^Your task is to produce a faithful, concise summary/i.test((text || '').trim());
}

/** updates.jsonl 的 method 两种：session/update（主流）与 _x.ai/session/update（turn_completed 等） */
function isGrokSessionUpdateMethod(method: unknown): boolean {
  return method === 'session/update' || method === '_x.ai/session/update';
}

/** 把 updates 里 content/rawOutput 压成前端好展示的 result */
function normalizeGrokToolResult(u: any): unknown {
  // content: [{type:'content', content:{type:'text', text}}]
  if (Array.isArray(u.content)) {
    const texts = u.content
      .map((c: any) => c?.content?.text ?? c?.text ?? (typeof c === 'string' ? c : null))
      .filter(Boolean);
    if (texts.length) return texts.join('\n');
  }
  if (typeof u.content === 'string' && u.content) return u.content;

  const raw = u.rawOutput;
  if (raw == null) {
    return u.status === 'completed' ? { status: 'completed', title: u.title } : undefined;
  }
  // Bash / ReadFile 等结构化输出
  if (typeof raw === 'object') {
    if (typeof raw.output_for_prompt === 'string') return raw.output_for_prompt;
    if (typeof raw.FileContent?.content === 'string') return raw.FileContent.content;
    if (typeof raw.Content?.content === 'string') return raw.Content.content;
    if (Array.isArray(raw.output) && raw.output.length) {
      return raw.output.map((x: any) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
    }
  }
  return raw;
}

/** tool 结果 + wire status（in_progress 时仍可有 partial result 供展示） */
type GrokToolResultEntry = { result?: unknown; status?: string };

/** 从 updates.jsonl 收集 tool_call_update 的 result/status */
function collectToolResultsFromUpdates(sessionDir: string): Map<string, GrokToolResultEntry> {
  const map = new Map<string, GrokToolResultEntry>();
  for (const row of readUpdatesJsonl(sessionDir)) {
    if (!isGrokSessionUpdateMethod(row?.method)) continue;
    const u = row?.params?.update;
    if (!u || u.sessionUpdate !== 'tool_call_update') continue;
    const id = u.toolCallId;
    if (!id) continue;
    const result = normalizeGrokToolResult(u);
    const prev = map.get(id);
    map.set(id, {
      result: result !== undefined ? result : prev?.result,
      // 后写覆盖：最终 completed 会盖掉 in_progress
      status: typeof u.status === 'string' && u.status ? u.status : prev?.status,
    });
  }
  return map;
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { raw };
  }
}

/** 按 toolCallId 回填已创建 assistant 的 toolCalls.result/status */
function backfillToolResult(
  messages: GrokMessageItem[],
  callId: string,
  result: unknown,
  status = 'completed',
): void {
  if (!callId || result === undefined) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const tc = m.toolCalls.find((t) => t.toolCallId === callId);
    if (tc) {
      if (tc.result === undefined) tc.result = result;
      tc.status = status;
      return;
    }
  }
}

function toolEntryToFields(entry?: GrokToolResultEntry): { result?: unknown; status?: string } {
  if (!entry) return {};
  return { result: entry.result, status: entry.status };
}

export async function listGrokCodeMessages(params: {
  sessionId: string;
  sessionDir?: string;
}): Promise<GrokMessageItem[]> {
  const { sessionId, sessionDir: dirParam } = params;
  const dir = dirParam || findSessionDirById(sessionId);
  if (!dir || !fs.existsSync(dir)) {
    throw new Error(`Grok session not found: ${sessionId}`);
  }

  // 读取 summary 拿基础时间 + session 默认模型
  const sum = parseSummary(path.join(dir, 'summary.json'));
  // baseTime 用 last_active_at（agent 运行时不漂移），避免 updated_at 持续刷新导致 last_active_at 前移
  const baseTime = sum?.last_active_at
    ? new Date(sum.last_active_at).getTime()
    : (sum?.updated_at ? new Date(sum.updated_at).getTime() : Date.now());
  // summary.current_model_id 优先于 wire 缺省；勿硬编码 grok-build
  const sessionDefaultModel = normalizeGrokModelId(sum?.current_model_id);

  const chatEntries = await readChatHistory(dir);

  // 合并 compact 前的消息：compaction_requests 保存了 compact 时刻的完整 chat_history
  const compactionReqs = readCompactionRequests(dir);
  let entries: any[];
  if (compactionReqs.length > 0) {
    // 最早一次 compact 的 chat_history：去 system prompt + 去末尾 compaction prompt
    const first = compactionReqs[0].entries;
    entries = first.filter((e: any, i: number) => {
      if (e.type === 'system') return false;
      // 末尾 compaction prompt（"Your task is to produce a faithful, concise summary..."）
      if (i === first.length - 1 && e.type === 'user'
        && isCompactionPrompt(getEntryText(e))) return false;
      return true;
    });
    // 后续 compact 及当前 chat_history：找到续写摘要后的新消息追加
    const appendAfterContinuation = (target: any[], source: any[]) => {
      let found = false;
      for (const e of source) {
        if (!found) {
          if (isGrokContinuationSummary(getEntryText(e))) { found = true; }
          continue;
        }
        target.push(e);
      }
      // 安全兜底：若未找到续写摘要标记，退回全量追加
      if (!found) {
        for (const e of source) {
          if (e.type !== 'system') target.push(e);
        }
      }
    };
    for (let i = 1; i < compactionReqs.length; i++) {
      appendAfterContinuation(entries, compactionReqs[i].entries);
    }
    appendAfterContinuation(entries, chatEntries);
  } else {
    entries = chatEntries;
  }

  const messages: GrokMessageItem[] = [];
  /** 仅 <user_query> 用户轮次，避免 system-reminder 抢走 parentID */
  let lastRealUserUuid: string | undefined;
  /** 本 session 内最近一次见到的 model_id（backend_tool 常缺 model_id） */
  let lastSeenModelId: string | undefined = sessionDefaultModel;
  let t = baseTime;

  const resolveEntryModel = (...candidates: Array<string | undefined>) => {
    for (const c of candidates) {
      const n = normalizeGrokModelId(c);
      if (n) {
        lastSeenModelId = n;
        return n;
      }
    }
    return lastSeenModelId || sessionDefaultModel;
  };

  // pass1: 预扫 tool_result（chat_history 里 result 在 assistant 之后 → 已完成）
  const toolResultsByCallId = new Map<string, GrokToolResultEntry>();
  for (const e of entries) {
    if (e.type === 'tool_result' && e.tool_call_id) {
      toolResultsByCallId.set(e.tool_call_id, { result: e.content, status: 'completed' });
    }
  }
  // backend_tool 等：result/status 在 updates.jsonl；chat_history 已 completed 的不降级
  collectToolResultsFromUpdates(dir).forEach((entry, id) => {
    const prev = toolResultsByCallId.get(id);
    if (!prev) {
      toolResultsByCallId.set(id, entry);
      return;
    }
    if (prev.status === 'completed') {
      // 保留 completed；result 空时用 updates 补
      if (prev.result === undefined && entry.result !== undefined) {
        toolResultsByCallId.set(id, { result: entry.result, status: 'completed' });
      }
      return;
    }
    toolResultsByCallId.set(id, {
      result: entry.result !== undefined ? entry.result : prev.result,
      status: entry.status || prev.status,
    });
  });

  /**
   * chat_history 里同一 model step 常拆成:
   *   reasoning → assistant(text+tools) → tool_result*
   * 或 reasoning → backend_tool_call
   * 若各自成 msg，detail 会把同一调用的 context/usage 累加两遍。
   * 缓存 pending reasoning，并入下一条 action 消息。
   */
  let pendingReasoning: { text: string; modelId?: string } | null = null;

  const takePendingReasoning = (): { thinking?: string; parts: GrokMessagePart[] } => {
    if (!pendingReasoning?.text) return { parts: [] };
    const text = pendingReasoning.text;
    pendingReasoning = null;
    return {
      thinking: text,
      parts: [{ type: 'reasoning', text, state: 'done' }],
    };
  };

  const flushOrphanReasoning = (lineIndex: number) => {
    if (!pendingReasoning?.text) return;
    const modelId = resolveEntryModel(pendingReasoning.modelId);
    const { thinking, parts } = takePendingReasoning();
    const item = pushGrokAssistantStep(
      messages,
      sessionId,
      lineIndex,
      lastRealUserUuid,
      modelId,
      { thinking, parts },
      sessionDefaultModel,
    );
    item.timestamp = t;
  };

  for (let lineIndex = 0; lineIndex < entries.length; lineIndex++) {
    const e = entries[lineIndex];
    t += 1; // 保序递增
    if (e.type === 'tool_result') {
      // 已预扫；若 assistant 已创建则回填（兼容乱序）
      if (e.tool_call_id) {
        toolResultsByCallId.set(e.tool_call_id, { result: e.content, status: 'completed' });
        backfillToolResult(messages, e.tool_call_id, e.content, 'completed');
      }
      continue;
    }
    // chat_history 顶层 system（agent prompt）不进会话流
    if (e.type === 'system') continue;

    if (e.type === 'user') {
      // 用户轮次开始前，落盘未合并的 reasoning
      flushOrphanReasoning(lineIndex);
      const text = Array.isArray(e.content)
        ? e.content.map((c: any) => c.text || '').filter(Boolean).join('\n')
        : String(e.content || '');
      // user_info / system-reminder：跳过（勿 push [system] 假 user）
      if (isGrokSyntheticUserText(text)) continue;

      const uuid = grokStableMessageId(sessionId, lineIndex);
      messages.push({
        uuid,
        sessionId,
        role: 'user',
        timestamp: t,
        text,
        toolCalls: [],
      });
      // compact 续写摘要：若有 compaction_requests 数据已在 merge 阶段剥离；
      // 此处为无 compaction 数据的旧 session 兜底：保留展示但不更新 lastRealUserUuid
      if (isGrokContinuationSummary(text)) continue;
      if (text.includes('<user_query>')) {
        lastRealUserUuid = uuid;
      } else if (!lastRealUserUuid) {
        // subagent 等场景没有 <user_query>，第一个真实 user 作为轮次锚点
        lastRealUserUuid = uuid;
      }
      continue;
    }
    if (e.type === 'reasoning') {
      const summaryBits = (e.summary || []).map((s: any) => s.text || '').filter(Boolean).join('\n');
      const reasoningText = summaryBits.trim();
      if (!reasoningText) continue;
      // 连续 reasoning 拼接（部分 session 会拆多段）
      if (pendingReasoning?.text) {
        pendingReasoning.text = `${pendingReasoning.text}\n${reasoningText}`;
        if (e.model_id) pendingReasoning.modelId = e.model_id;
      } else {
        pendingReasoning = { text: reasoningText, modelId: e.model_id };
      }
      continue;
    }
    if (e.type === 'assistant') {
      const text = e.content || '';
      const tcs = (e.tool_calls || []).map((tc: any) => ({
        toolCallId: tc.id,
        name: tc.name,
        args: parseToolArgs(tc.arguments),
        ...toolEntryToFields(toolResultsByCallId.get(tc.id)),
      }));
      const pendingModel = pendingReasoning?.modelId;
      const pending = takePendingReasoning();
      const parts: GrokMessagePart[] = [...pending.parts];
      if (text) parts.push({ type: 'text', text });
      const modelId = resolveEntryModel(e.model_id, pendingModel);
      const item = pushGrokAssistantStep(
        messages,
        sessionId,
        lineIndex,
        lastRealUserUuid,
        modelId,
        { text, thinking: pending.thinking, toolCalls: tcs, parts },
        sessionDefaultModel,
      );
      item.timestamp = t;
      continue;
    }
    // 新格式：backend_tool_call（x_search 等），result 来自 updates tool_call_update
    if (e.type === 'backend_tool_call') {
      const k = e.kind || {};
      const id = k.id || k.call_id || k.toolCallId;
      if (!id) continue;
      const name = k.name || k.tool_type || 'backend_tool';
      const args = parseToolArgs(k.input);
      const pendingModel = pendingReasoning?.modelId;
      const pending = takePendingReasoning();
      // backend_tool 几乎从不带 model_id → 用 session/最近 assistant 模型
      const modelId = resolveEntryModel(e.model_id, pendingModel);
      const item = pushGrokAssistantStep(
        messages,
        sessionId,
        lineIndex,
        lastRealUserUuid,
        modelId,
        {
          thinking: pending.thinking,
          toolCalls: [{
            toolCallId: id,
            name,
            args,
            ...toolEntryToFields(toolResultsByCallId.get(id)),
          }],
          parts: [...pending.parts],
        },
        sessionDefaultModel,
      );
      item.timestamp = t;
      continue;
    }
    if (['text', 'summary_text'].includes(e.type)) {
      const summaryBits = (e.summary || []).map((s: any) => s.text || '').filter(Boolean).join('\n');
      const content = summaryBits
        || (typeof e.content === 'string' ? e.content : (e.text || ''));
      if (!content) continue;
      const pendingModel = pendingReasoning?.modelId;
      const pending = takePendingReasoning();
      const modelId = resolveEntryModel(e.model_id, pendingModel);
      const item = pushGrokAssistantStep(
        messages,
        sessionId,
        lineIndex,
        lastRealUserUuid,
        modelId,
        {
          text: content,
          thinking: pending.thinking,
          parts: [...pending.parts, { type: 'text', text: content }],
        },
        sessionDefaultModel,
      );
      item.timestamp = t;
    }
  }
  flushOrphanReasoning(entries.length);

  const tokenEstimate = parseGrokUpdatesTokenEstimate(dir);
  attachContextTokensToMessages(messages, tokenEstimate);

  // 合成 timestamp 全挤在 last_active 日 → 列表跨天 badge 错误；回填真实墙钟
  const createdMs = sum?.created_at ? new Date(sum.created_at).getTime() : undefined;
  const turnStartMs = tokenEstimate.turns.map((t) => t.turnStartMs).filter(
    (t): t is number => typeof t === 'number' && t > 1e11,
  );
  attachGrokWallClockTimestamps(messages, {
    turnStartMs: turnStartMs.length > 0 ? turnStartMs : readGrokUserTurnStartMs(dir),
    createdMs,
    lastActiveMs: baseTime,
  });

  // 有真实 usage 时挂到各 step，detail 累加与 list session total 对齐
  const real = tryReadGrokRealUsage(dir);
  if (real) {
    attachRealUsageToMessages(messages, real);
    // usage.modelUsage 的 key 也可作最终回落
    const usageModel = Object.keys(real.modelUsage || {})
      .map((k) => normalizeGrokModelId(k))
      .find(Boolean);
    // 未挂上的 step（进行中 turn / 无 turn_completed）不计费，避免 context 估算再掺进 total
    for (const m of messages) {
      if (m.role !== 'assistant') continue;
      if (!m.model) {
        m.model = usageModel || sessionDefaultModel;
      } else {
        m.model = normalizeGrokModelId(m.model) || m.model;
      }
      if (!m.realUsage) {
        m.realUsage = { input: 0, output: 0, cached: 0, reasoning: 0 };
      }
    }
  } else {
    for (const m of messages) {
      if (m.role === 'assistant' && !m.model) {
        m.model = sessionDefaultModel;
      } else if (m.role === 'assistant' && m.model) {
        m.model = normalizeGrokModelId(m.model) || m.model;
      }
    }
  }

  return messages;
}

/** 从 messages + usage + session 汇总 models_used（逗号分隔、已归一） */
export function collectGrokModelsUsed(
  messages: GrokMessageItem[],
  opts?: {
    sessionModelId?: string;
    modelUsageKeys?: string[];
  },
): string {
  const set = new Set<string>();
  for (const k of opts?.modelUsageKeys || []) {
    const n = normalizeGrokModelId(k);
    if (n) set.add(n);
  }
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const n = normalizeGrokModelId(m.model);
    if (n) set.add(n);
  }
  if (set.size === 0) {
    const n = normalizeGrokModelId(opts?.sessionModelId);
    if (n) set.add(n);
  }
  return Array.from(set).join(',') || 'unknown';
}

// ==================== 用量汇总 ====================

export type GrokSessionUsageSummary = {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  /** real = turn_completed.usage；estimate = context 快照拆分 */
  usageSource: 'real' | 'estimate';
  costUsd?: number | null;
  costUsdTicks?: number | null;
  modelUsage?: Record<string, GrokPromptUsageModel>;
  real?: GrokRealUsage;
  estimate?: GrokSessionTokenEstimate;
};

/**
 * 汇总 Grok session 用量。
 * 优先 tryReadGrokRealUsage（turn_completed.usage）；否则 context 快照估算。
 */
export async function getGrokSessionUsageSummary(
  sessionIdOrDir: string,
  messages?: GrokMessageItem[],
  subagentMeta?: GrokSubagentMeta,
): Promise<GrokSessionUsageSummary> {
  const dir = fs.existsSync(sessionIdOrDir) && fs.statSync(sessionIdOrDir).isDirectory()
    ? sessionIdOrDir
    : findSessionDirById(sessionIdOrDir);
  if (!dir) {
    return { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, usageSource: 'estimate' };
  }
  const estimate = parseGrokUpdatesTokenEstimate(dir);
  const real = tryReadGrokRealUsage(dir);
  if (real) {
    return {
      input: real.input,
      output: real.output,
      total: real.total,
      cacheRead: real.cacheRead,
      cacheWrite: real.cacheWrite,
      reasoning: real.reasoning,
      usageSource: 'real',
      costUsd: real.costUsd,
      costUsdTicks: real.costUsdTicks,
      modelUsage: real.modelUsage,
      real,
      estimate,
    };
  }

  const msgs = messages || await listGrokCodeMessages({ sessionId: path.basename(dir), sessionDir: dir });
  // subagent tokens_used 接近真实，但无分项；作 total fallback
  const rawTotal = subagentMeta?.tokensUsed ?? grokSumAssistantContextTokens(msgs);
  const split = splitGrokContextTokens(rawTotal);
  return {
    input: split.input,
    output: split.output,
    total: split.total,
    cacheRead: split.cacheRead,
    cacheWrite: 0,
    reasoning: split.reasoning,
    usageSource: 'estimate',
    estimate,
  };
}

// CLI 测试
if (require.main === module) {
  (async () => {
    const ss = await listGrokCodeSessions();
    console.log('Grok sessions:', ss.length);
    if (ss[0]) {
      console.log('最新:', ss[0]);
      const msgs = await listGrokCodeMessages({ sessionId: ss[0].sessionId, sessionDir: ss[0].sessionDir });
      console.log('消息数:', msgs.length);
      msgs.slice(0, 3).forEach(m => console.log(m.role, m.text.slice(0, 80).replace(/\n/g, ' '), 'tools:', m.toolCalls.length));
    }
  })();
}
