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

import { readJsonlCached, readJsonlCachedAsync } from '../lib/jsonl-cache';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { resolveDataRoot, resolveHomeDir } from '../lib/home-paths';

/** Grok sessions 根：GROK_HOME → ~/.grok/sessions（env 可指 ~/.grok 或 sessions 目录） */
export function resolveGrokSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveHomeDir(env);
  const normalize = (p: string) => {
    const abs = path.resolve(p);
    if (path.basename(abs) === 'sessions') return abs;
    const nested = path.join(abs, 'sessions');
    return nested;
  };
  return resolveDataRoot({
    envValue: env.GROK_HOME || env.GROK_SESSIONS_DIR,
    defaults: [path.join(home, '.grok', 'sessions')],
    normalize,
    isOk: (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
  });
}

/** 每次 re-resolve，便于 GROK_HOME / GROK_SESSIONS_DIR / 测试注入 */
function grokSessionsRoot(): string {
  return resolveGrokSessionsRoot();
}

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
  /** 墙钟结束时间（assistant step 完成；无则与 timestamp 相同） */
  completedAt?: number;
  /** 时间戳来源：wall=updates 墙钟；synthetic=线性/序号合成 */
  timeSource?: 'wall' | 'synthetic';
  text: string;
  thinking?: string;
  toolCalls: Array<{
    toolCallId: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    /** updates tool_call_update.status（failed 优先）或 chat_history tool_result → completed；soft fail 会降为 completed */
    status?: string;
    /** 失败分类（含 soft，便于聚合） */
    errorKind?: GrokToolErrorKind;
    errorSeverity?: GrokToolErrorSeverity;
    /** tool 墙钟 start/end（updates agentTimestampMs） */
    startMs?: number;
    endMs?: number;
  }>;
  model?: string;
  parentID?: string;
  parts?: GrokMessagePart[];
  /** context compact 合成消息（对齐 Kimi [Context Compacted]） */
  compaction?: boolean;
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

/** updates.jsonl 推导的墙钟事件（避免 chat_history +1ms 假序） */
export type GrokWallClockEvents = {
  userStarts: number[];
  turnEnds: number[];
  /** 每个 model step 的首个 tool_call / agent_message 时间 */
  assistantStarts: number[];
  toolTimes: Map<string, { start: number; end?: number }>;
};

/** compaction_requests 元数据（用于 meta + 详情缝合点消息） */
export type GrokCompactionRecord = {
  requestId: string;
  createdAt: string;
  createdAtMs: number;
  trigger?: string;
  model?: string;
  summary?: string;
  error?: string | null;
  entries: any[];
};

export type GrokCompactionMeta = {
  compact_count: number;
  time_compacting?: number;
  tokensBefore?: number;
  records: GrokCompactionRecord[];
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
  if (!fs.existsSync(grokSessionsRoot())) return null;
  try {
    const projDirs = fs.readdirSync(grokSessionsRoot()).filter(d => !d.startsWith('.') && !d.endsWith('.sqlite'));
    for (const proj of projDirs) {
      const cand = path.join(grokSessionsRoot(), proj, sessionId);
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
  if (!fs.existsSync(grokSessionsRoot())) return { metaByChild, childrenByParent };

  let projDirs: string[] = [];
  try {
    projDirs = fs.readdirSync(grokSessionsRoot()).filter((d) => {
      const full = path.join(grokSessionsRoot(), d);
      return fs.statSync(full).isDirectory() && !d.endsWith('.sqlite');
    });
  } catch {
    return { metaByChild, childrenByParent };
  }

  // 先收集全部 updates.jsonl 路径, 再并发异步读取 (IO 交错, mtime 缓存与 convert 复用)
  const updatesPaths: string[] = [];
  for (const projEnc of projDirs) {
    const projDir = path.join(grokSessionsRoot(), projEnc);
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
  if (!fs.existsSync(grokSessionsRoot())) return [];

  // 提前扫描所有 session 的 updates.jsonl，建立 subagent 元数据映射
  const { metaByChild, childrenByParent } = await scanGrokSubagentRelations();

  const sessions: GrokSessionItem[] = [];
  let projDirs: string[] = [];
  try {
    projDirs = fs.readdirSync(grokSessionsRoot()).filter((d) => {
      const full = path.join(grokSessionsRoot(), d);
      return fs.statSync(full).isDirectory() && !d.endsWith('.sqlite');
    });
  } catch {
    return [];
  }

  for (const projEnc of projDirs) {
    const projDir = path.join(grokSessionsRoot(), projEnc);
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

function eventWallMs(row: any): number {
  const meta = row?.params?._meta || {};
  // agentTimestampMs 优先（已是 ms）；其次 wire timestamp 秒/毫秒兼容
  return grokWireTsToMs(meta.agentTimestampMs)
    || grokWireTsToMs(row?.timestamp)
    || 0;
}

/**
 * 从 updates.jsonl 扫墙钟：user 起点、assistant step 起点、turn 结束、tool 起止。
 * assistant step 边界：同批并发 tool_call 算一步；全部完成后的下一次 tool_call / 纯文本 agent_message 为新步。
 */
export function readGrokWallClockEvents(sessionDir: string): GrokWallClockEvents {
  const userStarts: number[] = [];
  const turnEnds: number[] = [];
  const assistantStarts: number[] = [];
  const toolTimes = new Map<string, { start: number; end?: number }>();

  const rows = readUpdatesJsonl(sessionDir)
    .map((row) => ({ row, t: eventWallMs(row) }))
    .filter((x) => x.t > 1e11)
    .sort((a, b) => a.t - b.t);

  /** 当前 step 尚未完成的 tool ids */
  const openTools = new Set<string>();
  let openAssistant = false;
  /** 当前 step 是否已出现过 tool（用于区分「thought→tools 同 step」vs「tools 完成后新 step」） */
  let stepHadTools = false;

  const openAssistantStep = (t: number) => {
    if (!openAssistant) {
      assistantStarts.push(t);
      openAssistant = true;
    }
  };

  for (const { row, t } of rows) {
    const update = row?.params?.update;
    if (!update?.sessionUpdate) continue;
    const su = update.sessionUpdate as string;

    if (su === 'user_message_chunk') {
      // 同一 user 多 chunk：只记首包
      const last = userStarts[userStarts.length - 1];
      if (last == null || t - last > 50) {
        userStarts.push(t);
      }
      openTools.clear();
      openAssistant = false;
      stepHadTools = false;
      continue;
    }

    if (su === 'tool_call') {
      const id = update.toolCallId as string | undefined;
      // 上一批 tool 已全部结束 → 新 model step（thought 后首批 tools 不新开）
      if (openTools.size === 0 && stepHadTools) {
        openAssistant = false;
        stepHadTools = false;
      }
      openAssistantStep(t);
      stepHadTools = true;
      if (id) {
        openTools.add(id);
        const prev = toolTimes.get(id);
        if (!prev || t < prev.start) {
          toolTimes.set(id, { start: t, end: prev?.end });
        }
      }
      continue;
    }

    if (su === 'tool_call_update') {
      const id = update.toolCallId as string | undefined;
      const status = String(update.status || '').toLowerCase();
      if (id) {
        const prev = toolTimes.get(id) || { start: t };
        if (!prev.start || prev.start <= 0) prev.start = t;
        if (status === 'completed' || status === 'failed' || status === 'error') {
          prev.end = prev.end != null ? Math.max(prev.end, t) : t;
          openTools.delete(id);
        }
        toolTimes.set(id, prev);
        openAssistantStep(prev.start);
        stepHadTools = true;
      }
      continue;
    }

    if (su === 'agent_message_chunk' || su === 'agent_thought_chunk') {
      // 纯文本 / reasoning：step 未开则开；tools 全部结束后的收尾文本保持同 step
      if (!openAssistant) openAssistantStep(t);
      continue;
    }

    if (su === 'turn_completed') {
      turnEnds.push(t);
      openTools.clear();
      openAssistant = false;
      stepHadTools = false;
    }
  }

  return { userStarts, turnEnds, assistantStarts, toolTimes };
}

/**
 * chat_history 无真实墙钟；合成 timestamp 从 last_active 起 +1ms 会导致 duration≈0。
 * 优先 updates 墙钟（user / assistant step / tool / turn_completed）；
 * 次回 turnStartMs 锚点 + 步内插值；最后 created→lastActive 线性插值。
 */
export function attachGrokWallClockTimestamps(
  messages: GrokMessageItem[],
  opts: {
    turnStartMs?: number[];
    createdMs?: number;
    lastActiveMs?: number;
    wall?: GrokWallClockEvents;
  },
): void {
  if (!messages.length) return;

  const wall = opts.wall;
  // 回填 tool 墙钟
  if (wall?.toolTimes?.size) {
    for (const m of messages) {
      for (const tc of m.toolCalls || []) {
        const tt = wall.toolTimes.get(tc.toolCallId);
        if (!tt) continue;
        tc.startMs = tt.start;
        if (tt.end != null) tc.endMs = tt.end;
      }
    }
  }

  const userAnchors = (
    (wall?.userStarts?.length ? wall.userStarts : null)
    || (opts.turnStartMs || []).filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 1e11)
  ) as number[];

  const assistantStarts = (wall?.assistantStarts || []).filter((t) => t > 1e11);
  const turnEnds = (wall?.turnEnds || []).filter((t) => t > 1e11);

  if (userAnchors.length > 0 || assistantStarts.length > 0) {
    let turnIdx = -1;
    let aIdx = 0;
    let syntheticOffset = 0;

    for (let mi = 0; mi < messages.length; mi++) {
      const m = messages[mi];
      const isUserQuery = m.role === 'user' && m.text.includes('<user_query>');
      if (isUserQuery) {
        turnIdx++;
        syntheticOffset = 0;
        if (turnIdx < userAnchors.length) {
          m.timestamp = userAnchors[turnIdx];
          m.completedAt = m.timestamp;
          m.timeSource = 'wall';
        }
        continue;
      }

      if (m.role === 'assistant') {
        if (aIdx < assistantStarts.length) {
          m.timestamp = assistantStarts[aIdx];
          m.timeSource = 'wall';
          const toolEnds = (m.toolCalls || [])
            .map((tc) => tc.endMs)
            .filter((x): x is number => typeof x === 'number' && x > 0);
          let done: number | undefined = toolEnds.length ? Math.max(...toolEnds) : undefined;
          if (done == null && aIdx + 1 < assistantStarts.length) {
            done = Math.max(m.timestamp, assistantStarts[aIdx + 1] - 1);
          }
          if (done == null && turnIdx >= 0 && turnIdx < turnEnds.length) {
            done = turnEnds[turnIdx];
          }
          if (done == null && turnEnds.length) {
            const nextEnd = turnEnds.find((e) => e >= m.timestamp);
            if (nextEnd != null) done = nextEnd;
          }
          m.completedAt = done != null && done >= m.timestamp ? done : m.timestamp;
          aIdx++;
          continue;
        }

        // 回落：user 锚点 + 保序 offset（仍优于全局 +1 from last_active）
        if (turnIdx >= 0 && turnIdx < userAnchors.length) {
          syntheticOffset += 1;
          m.timestamp = userAnchors[turnIdx] + syntheticOffset;
          m.completedAt = m.timestamp;
          m.timeSource = 'synthetic';
          continue;
        }
      }

      // 其它 user（continuation 等）：保序贴在前一条后
      if (mi > 0) {
        const prev = messages[mi - 1];
        if (prev?.timestamp) {
          m.timestamp = Math.max(m.timestamp || 0, prev.timestamp + 1);
          m.completedAt = m.timestamp;
          m.timeSource = m.timeSource || 'synthetic';
        }
      }
    }
    return;
  }

  // 无任何锚点：created→lastActive 线性插值
  const start = opts.createdMs;
  const end = opts.lastActiveMs;
  if (!start || !end || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  const n = messages.length;
  if (n === 1) {
    messages[0].timestamp = start;
    messages[0].completedAt = end;
    messages[0].timeSource = 'synthetic';
    return;
  }
  for (let i = 0; i < n; i++) {
    messages[i].timestamp = Math.round(start + ((end - start) * i) / (n - 1));
    messages[i].completedAt = i + 1 < n
      ? Math.round(start + ((end - start) * (i + 1)) / (n - 1))
      : end;
    messages[i].timeSource = 'synthetic';
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

/** 合成 compact 消息 / Kimi 风格文案 */
export function isGrokCompactionText(text: string): boolean {
  return /^\[Context Compacted\]/i.test((text || '').trim());
}

/** session compact 元数据：compaction_requests 优先，signals 兜底计数 */
export function getGrokCompactionMeta(sessionDir: string): GrokCompactionMeta {
  const records = readCompactionRequests(sessionDir);
  const signals = readGrokSignals(sessionDir);
  const okRecords = records.filter((r) => !r.error || r.summary);
  const fromReqs = okRecords.length;
  const fromSignals = typeof signals?.compactionCount === 'number' && signals.compactionCount > 0
    ? signals.compactionCount
    : 0;
  const compact_count = Math.max(fromReqs, fromSignals);
  const timeFromReqs = okRecords
    .map((r) => r.createdAtMs)
    .filter((t) => t > 0);
  const time_compacting = timeFromReqs.length > 0
    ? Math.max(...timeFromReqs)
    : undefined;
  const tokensBefore = typeof signals?.totalTokensBeforeCompaction === 'number'
    && signals.totalTokensBeforeCompaction > 0
    ? signals.totalTokensBeforeCompaction
    : undefined;
  return {
    compact_count,
    time_compacting,
    tokensBefore,
    records: okRecords,
  };
}

function readGrokSignals(sessionDir: string): {
  compactionCount?: number;
  totalTokensBeforeCompaction?: number;
} | null {
  const p = path.join(sessionDir, 'signals.json');
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!data || typeof data !== 'object') return null;
    return {
      compactionCount: typeof data.compactionCount === 'number' ? data.compactionCount : undefined,
      totalTokensBeforeCompaction: typeof data.totalTokensBeforeCompaction === 'number'
        ? data.totalTokensBeforeCompaction
        : undefined,
    };
  } catch {
    return null;
  }
}

function buildGrokCompactMessageText(
  rec: GrokCompactionRecord,
  tokensBefore?: number,
): string {
  const trigger = (rec.trigger || '').toLowerCase();
  const sourceLabel = trigger === 'manual' ? '手动' : trigger === 'auto' ? '自动' : undefined;
  const lines: string[] = [
    sourceLabel ? `[Context Compacted] ${sourceLabel}压缩` : '[Context Compacted]',
  ];
  if (tokensBefore != null && tokensBefore > 0) {
    lines.push(`压缩前上下文约 ${tokensBefore.toLocaleString()} tokens。`);
  }
  if (rec.summary) {
    lines.push('', '## 摘要', rec.summary);
  }
  return lines.join('\n');
}

/**
 * 在 pre/post compact 缝合点插入 assistant compact 消息（对齐 Kimi）。
 * afterMsgIndex：该 entry 处理完后 messages 的最后下标（-1 表示尚无消息）。
 */
function injectGrokCompactMessages(
  messages: GrokMessageItem[],
  sessionId: string,
  inserts: Array<{ afterMsgIndex: number; rec: GrokCompactionRecord }>,
  tokensBefore?: number,
): void {
  if (!inserts.length) return;
  // 从后往前插，保持 earlier 下标有效
  const ordered = [...inserts].sort((a, b) => b.afterMsgIndex - a.afterMsgIndex);
  for (const { afterMsgIndex, rec } of ordered) {
    const idx = Math.max(-1, Math.min(afterMsgIndex, messages.length - 1));
    const prev = idx >= 0 ? messages[idx] : undefined;
    const next = idx + 1 < messages.length ? messages[idx + 1] : undefined;
    let parentID: string | undefined;
    for (let i = idx; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user') continue;
      if (isGrokContinuationSummary(m.text) || isGrokCompactionText(m.text)) continue;
      parentID = m.uuid;
      break;
    }
    // 优先夹在相邻消息之间（墙钟回填后顺序稳定）；createdAt 落在区间内则用真实时间
    let ts: number;
    if (
      rec.createdAtMs > 1e11
      && prev
      && next
      && rec.createdAtMs > prev.timestamp
      && rec.createdAtMs < next.timestamp
    ) {
      ts = rec.createdAtMs;
    } else if (prev && next && next.timestamp > prev.timestamp) {
      ts = Math.floor((prev.timestamp + next.timestamp) / 2);
    } else if (rec.createdAtMs > 1e11) {
      ts = rec.createdAtMs;
    } else if (prev) {
      ts = prev.timestamp + 1;
    } else if (next) {
      ts = Math.max(1, next.timestamp - 1);
    } else {
      ts = Date.now();
    }
    const text = buildGrokCompactMessageText(rec, tokensBefore);
    const uuid = `grok-compact-${rec.requestId || String(rec.createdAtMs || ts)}`;
    const item: GrokMessageItem = {
      uuid,
      sessionId,
      role: 'assistant',
      timestamp: ts,
      text,
      toolCalls: [],
      model: normalizeGrokModelId(rec.model),
      parentID,
      compaction: true,
      parts: [{ type: 'text', text, state: 'done' }],
      // 不计费：compact summary 用量未稳定落在 turn_completed
      realUsage: { input: 0, output: 0, cached: 0, reasoning: 0 },
    };
    messages.splice(idx + 1, 0, item);
  }
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

/** 读取 compaction_requests 目录，返回按 created_at 升序的 pre-compact 记录 */
function readCompactionRequests(sessionDir: string): GrokCompactionRecord[] {
  const dir = path.join(sessionDir, 'compaction_requests');
  if (!fs.existsSync(dir)) return [];
  const results: GrokCompactionRecord[] = [];
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const p = path.join(dir, file);
      try {
        const raw = fs.readFileSync(p, 'utf-8');
        const data = JSON.parse(raw);
        if (!Array.isArray(data.chat_history) || data.chat_history.length === 0) continue;
        const createdAt = typeof data.created_at === 'string' ? data.created_at : '';
        const createdAtMs = createdAt ? Date.parse(createdAt) : NaN;
        results.push({
          requestId: String(data.request_id || file.replace(/\.json$/, '')),
          createdAt,
          createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
          trigger: typeof data.trigger === 'string' ? data.trigger : undefined,
          model: typeof data.model === 'string' ? data.model : undefined,
          summary: typeof data.summary === 'string' ? data.summary : undefined,
          error: data.error == null ? null : String(data.error),
          entries: data.chat_history,
        });
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

/** Grok tool 失败分类（wire failed 后可 soft 降级） */
export type GrokToolErrorKind =
  | 'file_not_found'
  | 'file_too_large'
  | 'file_read_error'
  | 'invalid_args'
  | 'edit_no_match'
  | 'edit_noop'
  | 'cross_host_redirect'
  | 'http_error'
  | 'blocked'
  | 'mcp_error'
  | 'execution_failed'
  | 'unknown';

export type GrokToolErrorSeverity = 'hard' | 'soft';

/** soft：可重试引导（截断/跨域跳转），不计入 ToolSucc 失败 */
const GROK_SOFT_ERROR_KINDS = new Set<GrokToolErrorKind>([
  'file_too_large',
  'cross_host_redirect',
]);

function stringifyGrokToolVal(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    if (typeof o.error === 'string') return o.error;
    if (typeof o.Error === 'string') return o.Error;
    if (typeof o.text === 'string') return o.text;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function extractGrokContentText(content: unknown): string | undefined {
  if (content == null) return undefined;
  if (typeof content === 'string' && content) return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .map((c: any) => c?.content?.text ?? c?.text ?? (typeof c === 'string' ? c : null))
    .filter(Boolean);
  return texts.length ? texts.join('\n') : undefined;
}

/** 从 rawOutput 结构取 kind + 文本 */
function extractGrokRawOutputInfo(raw: unknown): { kind?: GrokToolErrorKind; text?: string } {
  if (raw == null) return {};
  if (typeof raw === 'string') return { text: raw };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { text: stringifyGrokToolVal(raw) };
  }
  const o = raw as Record<string, unknown>;

  // { error: 'tool_execution_failed', message }
  if (typeof o.error === 'string' || typeof o.message === 'string') {
    const msg = [typeof o.message === 'string' ? o.message : '', typeof o.error === 'string' ? o.error : '']
      .filter(Boolean)
      .join(': ');
    const lower = msg.toLowerCase();
    let kind: GrokToolErrorKind = 'execution_failed';
    if (/auto mode blocked|was not executed/i.test(msg)) kind = 'blocked';
    else if (/http|redirect|request failed/i.test(lower)) kind = 'http_error';
    return { kind, text: msg };
  }

  if (o.FileNotFound != null) {
    return { kind: 'file_not_found', text: stringifyGrokToolVal(o.FileNotFound) };
  }
  if (o.FileTooLarge != null) {
    return { kind: 'file_too_large', text: stringifyGrokToolVal(o.FileTooLarge) };
  }
  if (o.FileReadError != null) {
    return { kind: 'file_read_error', text: stringifyGrokToolVal(o.FileReadError) };
  }
  if (o.CrossHostRedirect != null) {
    const cr = o.CrossHostRedirect as Record<string, unknown>;
    const host = cr.original_host ?? cr.originalHost ?? '';
    const url = cr.redirect_url ?? cr.redirectUrl ?? '';
    return {
      kind: 'cross_host_redirect',
      text: `Error: cross-host redirect from ${host} to ${url}. Make a new web_fetch call with the redirect URL if needed.`,
    };
  }
  if (o.NoMatchesFound != null) {
    return { kind: 'edit_no_match', text: stringifyGrokToolVal(o.NoMatchesFound) };
  }
  if (o.InvalidInput != null) {
    const t = stringifyGrokToolVal(o.InvalidInput);
    if (/same/i.test(t)) return { kind: 'edit_noop', text: t };
    return { kind: 'invalid_args', text: t };
  }
  // MCP: { type:'MCP', tool_name, output: { Error } }
  if (o.type === 'MCP' || o.tool_name != null || o.server_name != null) {
    const out = o.output;
    const toolName = typeof o.tool_name === 'string' ? o.tool_name : 'mcp';
    let body = '';
    if (out && typeof out === 'object') {
      const oo = out as Record<string, unknown>;
      body = stringifyGrokToolVal(oo.Error ?? oo.error ?? oo.message ?? out);
    } else {
      body = stringifyGrokToolVal(out);
    }
    return {
      kind: 'mcp_error',
      text: body ? `MCP ${toolName}: ${body}` : `MCP ${toolName} failed`,
    };
  }

  // 成功类结构化输出
  if (typeof o.output_for_prompt === 'string') return { text: o.output_for_prompt };
  if (typeof (o.FileContent as any)?.content === 'string') {
    return { text: (o.FileContent as any).content };
  }
  if (typeof (o.Content as any)?.content === 'string') {
    return { text: (o.Content as any).content };
  }
  if (Array.isArray(o.output) && o.output.length) {
    return {
      text: o.output.map((x: any) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n'),
    };
  }
  return { text: stringifyGrokToolVal(raw) };
}

/** 从失败文本推断 kind（chat_history-only 或 raw 缺字段时） */
export function classifyGrokToolErrorText(text: string): {
  kind: GrokToolErrorKind;
  severity: GrokToolErrorSeverity;
} {
  const t = text || '';
  let kind: GrokToolErrorKind = 'unknown';
  if (/exceeds the maximum allowed tokens|FileTooLarge|try a smaller `limit`/i.test(t)) {
    kind = 'file_too_large';
  } else if (/cross-host redirect/i.test(t)) {
    kind = 'cross_host_redirect';
  } else if (/does not exist|FileNotFound|No such file/i.test(t)) {
    kind = 'file_not_found';
  } else if (/Failed to parse arguments|missing field|invalid type|InvalidInput/i.test(t)) {
    kind = 'invalid_args';
  } else if (/string to replace was not found|NoMatchesFound/i.test(t)) {
    kind = 'edit_no_match';
  } else if (/Old string and new string are the same/i.test(t)) {
    kind = 'edit_noop';
  } else if (/Auto mode blocked|was not executed/i.test(t)) {
    kind = 'blocked';
  } else if (/Cannot read binary|not readable as UTF-8|FileReadError/i.test(t)) {
    kind = 'file_read_error';
  } else if (/HTTP request failed|too many redirects|error sending request/i.test(t)) {
    kind = 'http_error';
  } else if (/MCP |via `use_tool`|Managed MCP/i.test(t)) {
    kind = 'mcp_error';
  } else if (/Tool `.+` failed/i.test(t)) {
    kind = 'execution_failed';
  }
  const severity: GrokToolErrorSeverity = GROK_SOFT_ERROR_KINDS.has(kind) ? 'soft' : 'hard';
  return { kind, severity };
}

/**
 * 对 wire failed 做分类：soft（截断/跨域跳转）不计入 hard fail。
 * rawOutput 优先，其次 result/content 文本。
 */
export function classifyGrokToolFailure(input: {
  result?: unknown;
  rawOutput?: unknown;
  content?: unknown;
}): {
  kind: GrokToolErrorKind;
  severity: GrokToolErrorSeverity;
  message: string;
} {
  const fromRaw = extractGrokRawOutputInfo(input.rawOutput);
  const fromContent = extractGrokContentText(input.content);
  const fromResult = typeof input.result === 'string'
    ? input.result
    : input.result != null
      ? stringifyGrokToolVal(input.result)
      : undefined;
  const message = (fromRaw.text || fromContent || fromResult || '').trim();
  if (fromRaw.kind) {
    const severity: GrokToolErrorSeverity = GROK_SOFT_ERROR_KINDS.has(fromRaw.kind) ? 'soft' : 'hard';
    return { kind: fromRaw.kind, severity, message };
  }
  const cls = classifyGrokToolErrorText(message);
  return { ...cls, message };
}

/** 把 updates 里 content/rawOutput 压成前端好展示的 result（优先可读文本） */
function normalizeGrokToolResult(u: any): unknown {
  const contentText = extractGrokContentText(u.content);
  if (contentText) return contentText;

  if (typeof u.content === 'string' && u.content) return u.content;

  const raw = u.rawOutput;
  if (raw == null) {
    return u.status === 'completed' ? { status: 'completed', title: u.title } : undefined;
  }
  const info = extractGrokRawOutputInfo(raw);
  if (info.text) return info.text;
  return raw;
}

/** tool 结果 + wire status（in_progress 时仍可有 partial result 供展示） */
type GrokToolResultEntry = {
  result?: unknown;
  status?: string;
  errorKind?: GrokToolErrorKind;
  errorSeverity?: GrokToolErrorSeverity;
};

/**
 * tool status 终态优先级（越高越“最终”）。
 * chat_history 的 tool_result 一律可标 completed，但 updates 的 failed 必须能盖掉它；
 * 同时 completed 不可被 in_progress 回退。
 */
function grokToolStatusRank(status?: string): number {
  const s = (status || '').toLowerCase();
  if (s === 'failed' || s === 'error') return 40;
  if (s === 'completed' || s === 'success' || s === 'done') return 30;
  if (s === 'in_progress' || s === 'pending' || s === 'running' || s === 'calling') return 10;
  return 0;
}

/** 合并 tool result/status：result 取有值侧；status 取 rank 更高者 */
function mergeGrokToolResultEntry(
  prev: GrokToolResultEntry | undefined,
  next: GrokToolResultEntry,
): GrokToolResultEntry {
  if (!prev) return next;
  const prevRank = grokToolStatusRank(prev.status);
  const nextRank = grokToolStatusRank(next.status);
  const status = nextRank >= prevRank
    ? (next.status || prev.status)
    : (prev.status || next.status);
  // kind 跟随更高 rank 侧；同 rank 时 next 覆盖
  const useNextMeta = nextRank >= prevRank;
  return {
    result: next.result !== undefined ? next.result : prev.result,
    status,
    errorKind: useNextMeta
      ? (next.errorKind ?? prev.errorKind)
      : (prev.errorKind ?? next.errorKind),
    errorSeverity: useNextMeta
      ? (next.errorSeverity ?? prev.errorSeverity)
      : (prev.errorSeverity ?? next.errorSeverity),
  };
}

/**
 * wire failed → 分类；soft 降为 completed（不计入 ToolSucc 失败），
 * hard 保留 failed，并规范化 result 文本。
 */
function finalizeGrokToolEntry(entry: GrokToolResultEntry): GrokToolResultEntry {
  const st = (entry.status || '').toLowerCase();
  if (st !== 'failed' && st !== 'error') return entry;
  const cls = classifyGrokToolFailure({ result: entry.result });
  const kind = entry.errorKind || cls.kind;
  const severity: GrokToolErrorSeverity = entry.errorSeverity
    || (GROK_SOFT_ERROR_KINDS.has(kind) ? 'soft' : 'hard');
  const result = cls.message || entry.result;
  if (severity === 'soft') {
    return {
      result,
      status: 'completed',
      errorKind: kind,
      errorSeverity: 'soft',
    };
  }
  return {
    result,
    status: 'failed',
    errorKind: kind,
    errorSeverity: 'hard',
  };
}

/** 从 updates.jsonl 收集 tool_call_update 的 result/status（未 soft 降级；调用方 merge 后再 finalize） */
function collectToolResultsFromUpdates(sessionDir: string): Map<string, GrokToolResultEntry> {
  const map = new Map<string, GrokToolResultEntry>();
  for (const row of readUpdatesJsonl(sessionDir)) {
    if (!isGrokSessionUpdateMethod(row?.method)) continue;
    const u = row?.params?.update;
    if (!u || u.sessionUpdate !== 'tool_call_update') continue;
    const id = u.toolCallId;
    if (!id) continue;
    const result = normalizeGrokToolResult(u);
    const status = typeof u.status === 'string' && u.status ? u.status : undefined;
    if (status === 'failed' || status === 'error') {
      const cls = classifyGrokToolFailure({
        result,
        rawOutput: u.rawOutput,
        content: u.content,
      });
      // 保留 wire failed；message 补全 MCP 等空 content
      map.set(id, mergeGrokToolResultEntry(map.get(id), {
        result: cls.message || result,
        status,
        errorKind: cls.kind,
        errorSeverity: cls.severity,
      }));
    } else {
      map.set(id, mergeGrokToolResultEntry(map.get(id), { result, status }));
    }
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

/** 按 toolCallId 回填已创建 assistant 的 toolCalls.result/status（status 不降级） */
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
      if (grokToolStatusRank(status) >= grokToolStatusRank(tc.status)) {
        tc.status = status;
      }
      return;
    }
  }
}

function toolEntryToFields(entry?: GrokToolResultEntry): {
  result?: unknown;
  status?: string;
  errorKind?: GrokToolErrorKind;
  errorSeverity?: GrokToolErrorSeverity;
} {
  if (!entry) return {};
  return {
    result: entry.result,
    status: entry.status,
    errorKind: entry.errorKind,
    errorSeverity: entry.errorSeverity,
  };
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
  const compactionMeta = getGrokCompactionMeta(dir);
  const compactionReqs = compactionMeta.records;
  /** 每个 compact 缝合点：处理完该 entry 下标后插入 compact 消息 */
  const compactSeamEntryIndexes: Array<{ entryIndex: number; rec: GrokCompactionRecord }> = [];
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
    if (entries.length > 0) {
      compactSeamEntryIndexes.push({
        entryIndex: entries.length - 1,
        rec: compactionReqs[0],
      });
    }
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
      if (entries.length > 0) {
        compactSeamEntryIndexes.push({
          entryIndex: entries.length - 1,
          rec: compactionReqs[i],
        });
      }
    }
    appendAfterContinuation(entries, chatEntries);
  } else {
    entries = chatEntries;
  }

  const seamByEntryIndex = new Map<number, GrokCompactionRecord>();
  for (const s of compactSeamEntryIndexes) {
    seamByEntryIndex.set(s.entryIndex, s.rec);
  }
  const compactInserts: Array<{ afterMsgIndex: number; rec: GrokCompactionRecord }> = [];

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

  // pass1: 预扫 tool_result（chat_history 有 content 即视为 completed，但 updates.failed 可盖掉）
  const toolResultsByCallId = new Map<string, GrokToolResultEntry>();
  for (const e of entries) {
    if (e.type === 'tool_result' && e.tool_call_id) {
      toolResultsByCallId.set(
        e.tool_call_id,
        mergeGrokToolResultEntry(toolResultsByCallId.get(e.tool_call_id), {
          result: e.content,
          status: 'completed',
        }),
      );
    }
  }
  // updates 的 status 按 rank 合并：failed > completed > in_progress
  collectToolResultsFromUpdates(dir).forEach((entry, id) => {
    toolResultsByCallId.set(id, mergeGrokToolResultEntry(toolResultsByCallId.get(id), entry));
  });
  // soft（FileTooLarge / CrossHostRedirect）降为 completed；hard 规范化 message
  for (const [id, entry] of toolResultsByCallId) {
    toolResultsByCallId.set(id, finalizeGrokToolEntry(entry));
  }

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
    // try/finally：continue 也记录 compact 缝合点
    try {
    if (e.type === 'tool_result') {
      // 已预扫；若 assistant 已创建则回填（兼容乱序）。status 不覆盖 updates.failed
      if (e.tool_call_id) {
        const merged = mergeGrokToolResultEntry(toolResultsByCallId.get(e.tool_call_id), {
          result: e.content,
          status: 'completed',
        });
        toolResultsByCallId.set(e.tool_call_id, merged);
        backfillToolResult(
          messages,
          e.tool_call_id,
          e.content,
          merged.status || 'completed',
        );
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
    } finally {
      // compact 缝合点：本 entry 处理完后的 message 下标
      const seamRec = seamByEntryIndex.get(lineIndex);
      if (seamRec) {
        compactInserts.push({ afterMsgIndex: messages.length - 1, rec: seamRec });
      }
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
  const wall = readGrokWallClockEvents(dir);
  attachGrokWallClockTimestamps(messages, {
    turnStartMs: turnStartMs.length > 0 ? turnStartMs : readGrokUserTurnStartMs(dir),
    createdMs,
    lastActiveMs: baseTime,
    wall,
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

  // compact 消息在 usage 挂载后插入，避免抢 turn 计费桶
  injectGrokCompactMessages(
    messages,
    sessionId,
    compactInserts,
    compactionMeta.tokensBefore,
  );

  return messages;
}

/** 从消息列表推导 compact 次数/时间（合成消息 + 无 req 时的续写摘要兜底） */
export function deriveGrokCompactionStats(
  messages: GrokMessageItem[],
  sessionDir?: string,
): { compact_count?: number; time_compacting?: number } {
  const meta = sessionDir ? getGrokCompactionMeta(sessionDir) : null;
  const fromMsgs = messages.filter(
    (m) => m.compaction || isGrokCompactionText(m.text) || isGrokContinuationSummary(m.text),
  );
  const count = Math.max(meta?.compact_count || 0, fromMsgs.length);
  if (count <= 0) return {};
  const times = [
    ...(meta?.time_compacting ? [meta.time_compacting] : []),
    ...fromMsgs.map((m) => m.timestamp).filter((t) => t > 0),
  ];
  return {
    compact_count: count,
    time_compacting: times.length ? Math.max(...times) : meta?.time_compacting,
  };
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
