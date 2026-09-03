/**
 * Pi → OpenCode 统一协议转换
 *
 * 数据: ~/.pi/agent/sessions/<cwd-slug>/<ISO-ts>_<uuid>.jsonl
 * - 事件流 session | model_change | thinking_level_change | message
 * - message.role: user / assistant / toolResult
 * - toolCall 与 toolResult 分属两条 message envelope，按 toolCallId 配对
 * - usage/cost 为 agent 真实上报（对齐 grok usage_source='real'）
 *
 * 映射语义:
 * - assistant.content[thinking] → reasoning part
 * - assistant.content[text] → text part
 * - assistant.content[toolCall] → tool part（state.input, 状态暂记 completed，output 由后续 toolResult 补回）
 * - toolResult.message.content[text] → 注入对应 toolCallId 的 state.output
 * - last assistant stopReason → session_status（stop/done / toolUse/in-progress / aborted / error）
 *
 * 分支: v1 线性全收（不剪 parentId 树）
 * 弱标题: 首条 user text 截断；isWeakTitle 不认截断 prompt（issue 开放问题 2，v1 接受）
 */

import path from 'path';
import {
  listPiCodeSessions,
  readPiSessionEvents,
  getPiSession,
  type PiSessionItem,
  type PiMessageEnvelope,
  type PiEvent,
} from './pi-code';
import { checkSessionStatus } from './opencode';
import { calculateSessionPricingFromUnifiedMessages, type SessionPricing } from '../pricing';
import type { UnifiedSessionInfo, UnifiedSessionDetail, UnifiedMessage } from './types';
import type { BashSignals } from '../core';
import { classifyBashCommands, extractBashCommands, EMPTY_BASH_SIGNALS } from './bash-signals';
import { inferDeliverableSignals } from './deliverable-signals';
import {
  maxContextFromUnifiedMessages,
  sanitizeUserTextParts,
  buildLastTokenInfo,
} from './utils';
import { buildActivitySpanFromUnifiedMessages } from './usage-by-day';
import {
  createTimingLists,
  pushAssistantTimingSample,
  summarizeTimingLists,
} from '../lib/timing-stats';

// ==================== title ====================

const TITLE_MAX = 50;

/** 首条 user text 截断 → title；空或缺 user 时回退 sessionId 截断 */
export function derivePiTitle(firstUserText: string | undefined, sessionId: string): string {
  const t = (firstUserText || '').trim();
  if (!t) return sessionId.slice(0, 8);
  // 单行化 + 截断
  const oneLine = t.replace(/\s+/g, ' ');
  if (oneLine.length <= TITLE_MAX) return oneLine;
  // 截断 + ellipsis = TITLE_MAX（保留 ellipsis 字符位）
  return `${oneLine.slice(0, TITLE_MAX - 1)}…`;
}

// ==================== model / tokens ====================

function numTs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.trim()) {
    const d = Date.parse(v);
    if (Number.isFinite(d) && d > 0) return d;
  }
  return 0;
}

function normalizeProviderModel(
  provider?: string | null,
  model?: string | null,
): { providerID: string; modelID: string } | undefined {
  const p = (provider || '').trim();
  const m = (model || '').trim();
  if (!m) return undefined;
  return {
    providerID: p || 'unknown',
    modelID: m,
  };
}

// ==================== status 映射 ====================

function mapPiStatus(
  messages: UnifiedMessage[],
  lastStopReason?: string,
): UnifiedSessionInfo['session_status'] {
  const r = String(lastStopReason || '').toLowerCase();
  if (r === 'stop' || r === 'end_turn' || r === 'eos') return 'done';
  if (r === 'tooluse' || r === 'tool_use' || r === 'tool_calls') return 'in-progress';
  if (r === 'aborted' || r === 'cancelled' || r === 'canceled') return 'aborted';
  if (r === 'error' || r === 'failed') return 'error';
  // fallback: 看末条消息的 info.error
  return checkSessionStatus(messages);
}

// ==================== events → unified messages ====================

type PendingTool = { messageIndex: number; partIndex: number };

/**
 * 把整段 pi events 转成 unified messages。
 *
 * 设计:
 * - 未知 type（model_change / thinking_level_change 等）容错跳过
 * - assistant toolCall 部分作为 tool part 加入当前 message；用 toolCallId 登记位置
 * - toolResult 来时回填到对应 toolCall 的 state.output，按 isError 决定 status
 * - assistant message 带 usage/stopReason/provider/model/time
 */
export function convertPiEventsToMessages(
  sessionId: string,
  events: PiEvent[],
  opts: { fallbackCwd?: string } = {},
): { messages: UnifiedMessage[]; lastStopReason?: string } {
  const fallbackCwd = opts.fallbackCwd || '';
  const out: UnifiedMessage[] = [];
  const pendingTools = new Map<string, PendingTool>();
  let lastUserId: string | undefined;
  let lastStopReason: string | undefined;

  let partCounter = 0;
  const newPartId = (msgId: string, prefix: string) => `${msgId}-${prefix}${partCounter++}`;

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type !== 'message') continue;
    const env = ev as PiMessageEnvelope;
    const m = env.message;
    if (!m || !m.role) continue;

    const created = numTs(env.timestamp) || numTs(m.timestamp) || Date.now();
    const envId = String(env.id || `ev-${out.length}`);

    if (m.role === 'user') {
      // flush：toolResult 总跟在 toolCall 后面，但 assistant 可能后续也接 user
      const texts: string[] = [];
      for (const c of m.content || []) {
        if (c && c.type === 'text' && typeof c.text === 'string') {
          texts.push(c.text);
        }
      }
      const text = texts.join('\n');
      const parts: any[] = [];
      if (text) {
        parts.push({
          id: newPartId(envId, 't'),
          type: 'text',
          text,
          sessionID: sessionId,
          messageID: envId,
        });
      }
      out.push({
        info: {
          id: envId,
          sessionID: sessionId,
          role: 'user',
          time: { created },
          path: { cwd: fallbackCwd, root: '' },
        } as any,
        parts,
      });
      lastUserId = envId;
      continue;
    }

    if (m.role === 'toolResult') {
      const callId = m.toolCallId;
      const text = (m.content || [])
        .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
        .filter(Boolean)
        .join('\n');
      const isError = !!m.isError;
      const pending = callId ? pendingTools.get(callId) : undefined;
      if (pending) {
        const msg = out[pending.messageIndex];
        if (msg) {
          const parts = (msg.parts || []) as any[];
          const part = parts[pending.partIndex];
          if (part && part.state) {
            part.state.output = text;
            part.state.status = isError ? 'error' : 'completed';
          }
        }
      }
      // 没有匹配的 toolCall：丢弃（v1 不重建孤儿 tool）
      continue;
    }

    if (m.role === 'assistant') {
      const model = normalizeProviderModel(m.provider, m.model);
      const parts: any[] = [];
      const messageInfo: any = {
        id: envId,
        sessionID: sessionId,
        role: 'assistant',
        parentID: lastUserId,
        time: { created, completed: created },
        path: { cwd: fallbackCwd, root: '' },
      };
      if (model) {
        messageInfo.model = model;
        messageInfo.providerID = model.providerID;
        messageInfo.modelID = model.modelID;
      }

      // usage → tokens
      const usage = m.usage;
      if (usage) {
        const rawInput = usage.input || 0;
        const cacheRead = usage.cacheRead || 0;
        const cacheWrite = usage.cacheWrite || 0;
        const input = Math.max(0, rawInput - cacheRead);
        const output = usage.output || 0;
        const reasoning = usage.reasoning || 0;
        const total = usage.totalTokens || (input + output);
        messageInfo.tokens = {
          total,
          input,
          output,
          reasoning,
          cache: { read: cacheRead, write: cacheWrite },
          context: { total: input + cacheRead, input, cacheRead },
        };
        // pi 自带 usage.cost.total → reported-cost rescale 用
        const costTotal = usage.cost?.total;
        if (typeof costTotal === 'number' && Number.isFinite(costTotal) && costTotal > 0) {
          (messageInfo as any).piUsageCost = costTotal;
        }
      }

      if (m.stopReason) {
        messageInfo.finish = m.stopReason;
        lastStopReason = m.stopReason;
      }
      if (m.api) messageInfo.api = m.api;
      if (m.responseId) messageInfo.responseId = m.responseId;

      // content parts
      for (const c of m.content || []) {
        if (!c || !c.type) continue;
        if (c.type === 'thinking') {
          const thinking = (c as any).thinking || '';
          if (!thinking) continue;
          parts.push({
            id: newPartId(envId, 'r'),
            type: 'reasoning',
            text: thinking,
            sessionID: sessionId,
            messageID: envId,
          });
        } else if (c.type === 'text') {
          const text = (c as any).text || '';
          if (!text) continue;
          parts.push({
            id: newPartId(envId, 't'),
            type: 'text',
            text,
            sessionID: sessionId,
            messageID: envId,
          });
        } else if (c.type === 'toolCall') {
          const tc = c as any;
          const callId = String(tc.id || '');
          const partIndex = parts.length;
          const part: any = {
            id: newPartId(envId, 'tool'),
            type: 'tool',
            tool: String(tc.name || 'unknown'),
            callID: callId,
            sessionID: sessionId,
            messageID: envId,
            state: {
              status: 'completed', // 占位：toolResult 到达后会被覆盖
              input: tc.arguments || {},
              output: '',
              title: tc.name,
              time: { start: created, end: created },
            },
          };
          parts.push(part);
          if (callId) {
            pendingTools.set(callId, { messageIndex: out.length, partIndex });
          }
        }
      }

      out.push({ info: messageInfo, parts });
      continue;
    }
  }

  return { messages: out, lastStopReason };
}

// ==================== reported-cost rescale（对齐 grok） ====================

type PiReportedCost = {
  modelKey: string;
  provider: string;
  model: string;
  cost: number;
};

/**
 * 累加 assistant message 自带的 usage.cost.total → 按 provider/model 聚合并拿到 session 真实成本。
 * 与 `calculateSessionPricingFromUnifiedMessages` 算出来的 details 求差，超阈值即 rescale。
 * 兜底 pi 的 modelKey miss 时 cost=0 问题。
 */
function piReportedCostSummary(
  messages: UnifiedMessage[],
): { totalUsd: number; byModel: Map<string, PiReportedCost> } | null {
  const byModel = new Map<string, PiReportedCost>();
  let total = 0;
  let any = false;
  for (const m of messages) {
    if (m.info?.role !== 'assistant') continue;
    // 直接读 raw cost 字段：convert 时挂在 info 上
    const raw = (m.info as any).piUsageCost as number | undefined;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
    any = true;
    total += raw;
    const provider = String((m.info as any).providerID || m.info.model?.providerID || 'unknown');
    const model = String((m.info as any).modelID || m.info.model?.modelID || 'unknown');
    const key = `${provider}/${model}`;
    const cur = byModel.get(key);
    if (cur) {
      cur.cost += raw;
    } else {
      byModel.set(key, { modelKey: key, provider, model, cost: raw });
    }
  }
  return any ? { totalUsd: total, byModel } : null;
}

/**
 * 把 pi 自带 cost 当真值，对 calculateSessionPricingFromUnifiedMessages 输出做 rescale（grok 式）。
 * 阈值与 grok 对齐：相对差 > 1e-6 才缩放。
 */
function rescalePiPricingToReported(
  pricing: SessionPricing,
  reported: { totalUsd: number; byModel: Map<string, PiReportedCost> },
): SessionPricing {
  if (reported.totalUsd <= 0) return pricing;
  const reportedUsd = reported.totalUsd;
  const baselineUsd = (pricing.details || []).reduce((s, d) => s + (d.usd || 0), 0);
  if (baselineUsd <= 0) {
    // 全部 modelKey miss 或 hooks 未注入（pricing 为 0）→ 直接用 reported total
    // details 优先按 reported byModel 1:1 填（带 token 计数）；空 byModel 时用 pricing 现有 details 但 usd=0
    const fromReported = Array.from(reported.byModel.values()).map((m) => ({
      modelKey: m.modelKey,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      usd: m.cost,
      cny: 0,
    }));
    const details = fromReported.length
      ? fromReported
      : (pricing.details || []).map((d) => ({ ...d, usd: 0, cny: 0 }));
    return { usd: reportedUsd, cny: 0, details };
  }
  const denom = Math.max(reportedUsd, baselineUsd);
  if (Math.abs(reportedUsd - baselineUsd) / denom <= 1e-6) return pricing;
  const s = reportedUsd / baselineUsd;
  const cny = (pricing.cny || 0) * s;
  const details = (pricing.details || []).map((d) => ({
    ...d,
    usd: (d.usd || 0) * s,
    cny: (d.cny || 0) * s,
    inputCost: (d.inputCost || 0) * s,
    outputCost: (d.outputCost || 0) * s,
    cacheReadCost: (d.cacheReadCost || 0) * s,
    cacheWriteCost: (d.cacheWriteCost || 0) * s,
  }));
  return { usd: reportedUsd, cny, details };
}

// ==================== stats ====================

async function getPiSessionStats(
  session: PiSessionItem,
  preloadedEvents?: PiEvent[],
  preloadedMessages?: UnifiedMessage[],
): Promise<{
  stats: {
    total_messages: number;
    total_user_messages: number;
    total_tool_calls: number;
    total_tool_calls_success: number;
    total_tool_calls_failed: number;
    total_tokens: number;
    total_input: number;
    total_output: number;
    total_reasoning: number;
    total_cache_read: number;
    total_cache_write: number;
    models_used: string;
    editDiffs: { additions: number; deletions: number; filesChanged: number; files?: string[] };
    bashSignals: BashSignals;
    last_message?: any;
    last_message_tokens?: number;
    max_context_tokens?: number;
    textParts?: any[];
    userParts?: any[];
    avg_tps?: number;
    avg_latency_ms?: number;
    avg_prefill_tps?: number;
    assistant_tps_list?: number[];
    latency_list?: number[];
    prefill_tps_list?: number[];
    usage_source?: 'real' | 'estimate';
    cost_is_partial?: boolean;
    usage_is_incomplete?: boolean;
    usage_by_model?: Array<{
      provider: string;
      model: string;
      modelKey?: string;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      reasoning?: number;
      tokens?: number;
    }>;
  };
  unifiedMessages: UnifiedMessage[];
  pricing: SessionPricing;
}> {
  const emptyStats = {
    total_messages: 0,
    total_user_messages: 0,
    total_tool_calls: 0,
    total_tool_calls_success: 0,
    total_tool_calls_failed: 0,
    total_tokens: 0,
    total_input: 0,
    total_output: 0,
    total_reasoning: 0,
    total_cache_read: 0,
    total_cache_write: 0,
    models_used: '',
    editDiffs: { additions: 0, deletions: 0, filesChanged: 0 },
    bashSignals: EMPTY_BASH_SIGNALS,
    usage_source: 'real' as const,
    cost_is_partial: true,
    usage_is_incomplete: false,
  };

  try {
    let messages: UnifiedMessage[];
    let lastStopReason: string | undefined;
    if (preloadedMessages) {
      messages = preloadedMessages;
    } else {
      const events = preloadedEvents || readPiSessionEvents(session.filePath);
      const r = convertPiEventsToMessages(session.sessionId, events, {
        fallbackCwd: session.cwd,
      });
      messages = r.messages;
      lastStopReason = r.lastStopReason;
      // reported-cost 标记注入（list 路径已在 listPiSessionsForListing 注入；events 路径此处补齐）
      for (const ev of events) {
        if (!ev || (ev as any).type !== 'message') continue;
        const env = ev as PiMessageEnvelope;
        const m = env.message;
        if (!m || m.role !== 'assistant' || !m.usage?.cost) continue;
        const target = messages.find((x) => x.info.id === String((ev as any).id || ''));
        if (target) (target.info as any).piUsageCost = m.usage.cost.total || 0;
      }
    }

    const stats: typeof emptyStats & {
      max_context_tokens?: number;
      usage_by_model?: Array<{
        provider: string;
        model: string;
        modelKey?: string;
        input: number;
        output: number;
        cache_read: number;
        cache_write: number;
        reasoning?: number;
        tokens?: number;
      }>;
    } = { ...emptyStats };
    stats.total_messages = messages.length;
    stats.editDiffs = calculatePiEditDiffs(messages);
    stats.bashSignals = classifyBashCommands(extractBashCommands(messages));

    const models = new Set<string>();
    const modelUsage = new Map<string, {
      provider: string;
      model: string;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      reasoning: number;
    }>();
    const textParts: any[] = [];
    const userTextParts: any[] = [];
    const timingLists = createTimingLists();
    let lastUserTs: number | null = null;

    for (const um of messages) {
      const role = um.info.role;
      const created = um.info.time?.created || 0;
      if (role === 'user') {
        stats.total_user_messages++;
        lastUserTs = created;
      }
      for (const part of um.parts || []) {
        if (part.type !== 'tool') continue;
        stats.total_tool_calls++;
        const st = (part.state as any)?.status;
        if (st === 'error' || st === 'failed') stats.total_tool_calls_failed++;
        else stats.total_tool_calls_success++;
      }

      if (um.info.tokens) {
        stats.total_input += um.info.tokens.input || 0;
        stats.total_output += um.info.tokens.output || 0;
        stats.total_reasoning += um.info.tokens.reasoning || 0;
        stats.total_cache_read += um.info.tokens.cache?.read || 0;
        stats.total_cache_write += um.info.tokens.cache?.write || 0;
      }

      const providerID = um.info.providerID || um.info.model?.providerID;
      const modelID = um.info.modelID || um.info.model?.modelID;
      if (modelID) {
        models.add(modelID);
        const key = `${providerID || 'unknown'}/${modelID}`;
        const cur = modelUsage.get(key) || {
          provider: providerID || 'unknown',
          model: modelID,
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          reasoning: 0,
        };
        cur.input += um.info.tokens?.input || 0;
        cur.output += um.info.tokens?.output || 0;
        cur.cache_read += um.info.tokens?.cache?.read || 0;
        cur.cache_write += um.info.tokens?.cache?.write || 0;
        cur.reasoning += um.info.tokens?.reasoning || 0;
        modelUsage.set(key, cur);
      }

      const texts = (um.parts || [])
        .filter((p: any) => p.type === 'text' || p.type === 'reasoning')
        .map((p: any) => p.text)
        .filter(Boolean);
      if (texts.length) {
        textParts.push({
          role,
          text: texts.join('\n'),
          tool: '',
          duration: 0,
          startTime: created,
          endTime: created,
        });
        if (role === 'user') {
          userTextParts.push({
            role,
            text: texts.join('\n'),
            tool: '',
            duration: 0,
            startTime: created,
            endTime: created,
          });
        }
      }

      if (role === 'assistant') {
        const tokens = um.info.tokens;
        const latencyMs = lastUserTs && created > lastUserTs ? created - lastUserTs : 0;
        pushAssistantTimingSample(timingLists, {
          latencyMs,
          outputTokens: (tokens?.output || 0) + (tokens?.reasoning || 0),
          inputTokens: (tokens?.input || 0) + (tokens?.cache?.read || 0),
        });
        lastUserTs = null;
      }
    }

    stats.total_tokens = stats.total_input + stats.total_cache_read + stats.total_output;
    stats.models_used = Array.from(models).join(',');
    stats.max_context_tokens = maxContextFromUnifiedMessages(messages) || undefined;

    // 用 usage_by_model 构造 pricing（calculate 内部会读 messages.tokens；这里也直接现算）
    let pricing = calculateSessionPricingFromUnifiedMessages(messages);
    // reported-cost rescale
    const reported = piReportedCostSummary(messages);
    if (reported) {
      pricing = rescalePiPricingToReported(pricing, reported);
      // reported 兜底后，cost_is_partial 视「details 是否有非 0 usd」判定
      const anyNonZero = pricing.details?.some((d) => (d.usd || 0) > 0);
      stats.cost_is_partial = !anyNonZero;
    } else {
      // 无 reported cost：保持 partial
      stats.cost_is_partial = true;
    }
    // 摘掉 rescale 用过的内部字段（不污染 message info 输出）
    for (const um of messages) {
      if ((um.info as any).piUsageCost != null) {
        delete (um.info as any).piUsageCost;
      }
    }

    // usage_by_model 输出（cache 缓存列与 API 层 modelKey 共用）
    stats.usage_by_model = Array.from(modelUsage.entries()).map(([k, v]) => ({
      provider: v.provider,
      model: v.model,
      modelKey: k,
      input: v.input,
      output: v.output,
      cache_read: v.cache_read,
      cache_write: v.cache_write,
      reasoning: v.reasoning,
      tokens: v.input + v.output + v.cache_read + v.cache_write,
    }));

    const timingSummary = summarizeTimingLists(timingLists);

    // userParts 过滤（truncated prompt 不算重复）
    let userParts = sanitizeUserTextParts(userTextParts);
    userParts = userParts.filter((r, i) => {
      const prevText = i > 0 ? userParts[i - 1].text : '';
      return prevText !== r.text;
    });

    const lastWithTokens = [...messages].reverse().find((m) => m.info.tokens?.total);
    const last_message = lastWithTokens?.info
      || [...messages].reverse().find((m) => m.info.role === 'assistant')?.info;
    const last_message_tokens = lastWithTokens?.info.tokens?.total;

    return {
      stats: {
        ...stats,
        total_user_messages: userParts.length || stats.total_user_messages,
        last_message,
        last_message_tokens,
        textParts: textParts.length ? textParts : undefined,
        userParts: userParts.length ? userParts : undefined,
        ...timingSummary,
      },
      unifiedMessages: messages,
      pricing,
    };
  } catch (e) {
    console.warn(`[pi-source] stats 失败: ${session.sessionId}`, e);
    return {
      stats: emptyStats,
      unifiedMessages: [],
      pricing: { usd: 0, cny: 0 },
    };
  }
}

// ==================== editDiffs ====================

function calculatePiEditDiffs(messages: UnifiedMessage[]): {
  additions: number;
  deletions: number;
  filesChanged: number;
  files?: string[];
} {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const m of messages) {
    for (const part of m.parts || []) {
      if (part.type !== 'tool') continue;
      const name = String((part as any).tool || '').toLowerCase();
      const input = ((part as any).state?.input || {}) as Record<string, any>;
      const fp = input.path || input.file_path || input.filePath || input.targetFile || input.target_file;
      if (fp && (name === 'edit' || name === 'write' || name === 'multiedit' || name === 'multi_edit')) {
        files.add(String(fp));
      }
      if (name === 'write' && input.content) {
        additions += String(input.content).split('\n').length;
      } else if (name === 'edit' && (input.new_string || input.newString || input.content)) {
        additions += String(input.new_string || input.newString || input.content).split('\n').length;
        const old = input.old_string || input.oldString;
        if (old) deletions += String(old).split('\n').length;
      }
    }
  }
  return {
    additions,
    deletions,
    filesChanged: files.size,
    files: files.size ? Array.from(files) : undefined,
  };
}

// ==================== convert / detail ====================

function deriveProjectName(cwd: string): string {
  if (!cwd) return '';
  return path.basename(cwd) || cwd;
}

/**
 * 转 unified session info（list 用）
 *
 * 实现要点:
 * - title: 首条 user text 截断（v1 接受 isWeakTitle 不认现状）
 * - session_status: 末条 assistant stopReason 映射
 * - usage_source: 'real'（pi 自带 usage + cost）
 * - pricing: calculateSessionPricingFromUnifiedMessages → reported-cost rescale
 * - usage_by_day: 按 assistant message timestamp 切日
 */
export async function convertPiSession(
  session: PiSessionItem,
  preloadedEvents?: PiEvent[],
  preloadedMessages?: UnifiedMessage[],
): Promise<UnifiedSessionInfo> {
  const { stats, unifiedMessages, pricing } = await getPiSessionStats(
    session,
    preloadedEvents,
    preloadedMessages,
  );
  const lastAsst = [...unifiedMessages].reverse().find((m) => m.info.role === 'assistant');
  const lastStopReason = lastAsst?.info.finish || (lastAsst?.info as any)?.stopReason;
  const session_status = mapPiStatus(unifiedMessages, lastStopReason);

  const activity = buildActivitySpanFromUnifiedMessages(
    unifiedMessages,
    session.updatedAt,
    session.createdAt,
  );

  // title：取首条 user text 截断；预载 events 可以让我们直接拿
  let firstUserText: string | undefined;
  if (preloadedEvents) {
    for (const ev of preloadedEvents) {
      if (ev && (ev as any).type === 'message' && (ev as PiMessageEnvelope).message?.role === 'user') {
        const c = (ev as PiMessageEnvelope).message.content?.[0];
        if (c && (c as any).type === 'text') {
          firstUserText = (c as any).text;
          break;
        }
      }
    }
  } else {
    // 兜底：读 unified messages 的第一条 user
    const firstUser = unifiedMessages.find((m) => m.info.role === 'user');
    const tp = firstUser?.parts?.find((p: any) => p.type === 'text') as any;
    firstUserText = tp?.text;
  }
  const title = derivePiTitle(firstUserText, session.sessionId);

  return {
    id: session.sessionId,
    project_id: session.cwd || session.cwdSlug,
    slug: session.sessionId,
    directory: session.cwd,
    title,
    source_title: title,
    version: 'pi',
    time_created: session.createdAt,
    time_updated: session.updatedAt,
    project_name: session.cwd ? deriveProjectName(session.cwd) : undefined,
    project_worktree: session.cwd || undefined,

    total_messages: stats.total_messages,
    total_user_messages: stats.total_user_messages,
    total_tool_calls: stats.total_tool_calls,
    total_tool_calls_success: stats.total_tool_calls_success,
    total_tool_calls_failed: stats.total_tool_calls_failed,
    total_tokens: stats.total_tokens,
    total_input: stats.total_input,
    total_output: stats.total_output,
    total_reasoning: stats.total_reasoning,
    total_cache_read: stats.total_cache_read,
    total_cache_write: stats.total_cache_write,
    last_active_at_iso: activity.last_active_at_iso,
    last_active_at: activity.last_active_at_iso,
    first_active_at_iso: activity.first_active_at_iso,
    span_days: activity.span_days,
    usage_by_day: activity.usage_by_day,
    models_used: stats.models_used,
    usage_by_model: stats.usage_by_model,
    session_status,
    last_message_tokens: stats.last_message_tokens,
    max_context_tokens: stats.max_context_tokens,
    last_message: stats.last_message,
    lastTokenInfo: buildLastTokenInfo(unifiedMessages),
    textParts: stats.textParts,
    userParts: stats.userParts,
    avg_tps: stats.avg_tps,
    avg_latency_ms: stats.avg_latency_ms,
    avg_prefill_tps: stats.avg_prefill_tps,
    assistant_tps_list: stats.assistant_tps_list,
    latency_list: stats.latency_list,
    prefill_tps_list: stats.prefill_tps_list,
    editDiffs: stats.editDiffs,
    bashSignals: stats.bashSignals,
    deliverableSignals: inferDeliverableSignals({ messages: unifiedMessages }),
    pricing,
    usage_source: stats.usage_source,
    cost_is_partial: stats.cost_is_partial,
    usage_is_incomplete: stats.usage_is_incomplete,

    source: 'pi',
  };
}

/**
 * detail：live 重读 jsonl，转 unified messages + detail info
 *
 * 设计:
 * - 读 events 时挂 piUsageCost（用于 reported-cost rescale）
 * - 复用 convertPiSession 输出 UnifiedSessionInfo 作 detail.info
 */
export async function getPiSessionDetail(
  sessionId: string,
): Promise<UnifiedSessionDetail | null> {
  const session = await getPiSession(sessionId);
  if (!session) return null;

  const events = readPiSessionEvents(session.filePath);
  // 第一遍：临时挂 raw cost 到 message info，便于 reported-cost 抓取
  const interim = convertPiEventsToMessages(session.sessionId, events, {
    fallbackCwd: session.cwd,
  });
  for (const ev of events) {
    if (!ev || (ev as any).type !== 'message') continue;
    const env = ev as PiMessageEnvelope;
    const m = env.message;
    if (!m || m.role !== 'assistant' || !m.usage?.cost) continue;
    const target = interim.messages.find((x) => x.info.id === String((ev as any).id || ''));
    if (target) {
      (target.info as any).piUsageCost = m.usage.cost.total || 0;
    }
  }

  const info = await convertPiSession(session, events, interim.messages);
  const pricing = info.pricing || { usd: 0, cny: 0 };
  const editDiffs = calculatePiEditDiffs(interim.messages);

  return {
    info: { ...info, pricing },
    messages: interim.messages,
    editDiffs,
    pricing,
  };
}

// ==================== list export ====================

/** list 子命令需要的 live 数据（listSessions 调度用） */
export async function listPiSessionsForListing(): Promise<UnifiedSessionInfo[]> {
  const list = await listPiCodeSessions();
  // 限制并发；pi 的 convert 不读 DB，纯 CPU + 解析
  const { withConcurrencyLimit } = await import('./utils');
  const out = await withConcurrencyLimit(list, async (s) => {
    // 优先快路径：只读 events + 首条 user text，不走完整 stats
    const events = readPiSessionEvents(s.filePath);
    const firstUserText = firstUserTextFromEvents(events);
    const interim = convertPiEventsToMessages(s.sessionId, events, {
      fallbackCwd: s.cwd,
    });
    for (const ev of events) {
      if (!ev || (ev as any).type !== 'message') continue;
      const env = ev as PiMessageEnvelope;
      const m = env.message;
      if (!m || m.role !== 'assistant' || !m.usage?.cost) continue;
      const target = interim.messages.find((x) => x.info.id === String((ev as any).id || ''));
      if (target) (target.info as any).piUsageCost = m.usage.cost.total || 0;
    }
    return convertPiSession({ ...s, firstUserText }, events, interim.messages);
  }, 3);
  return out;
}

function firstUserTextFromEvents(events: PiEvent[]): string | undefined {
  for (const ev of events) {
    if (!ev || (ev as any).type !== 'message') continue;
    const env = ev as PiMessageEnvelope;
    if (env.message?.role !== 'user') continue;
    const c = env.message.content?.[0];
    if (c && (c as any).type === 'text') return (c as any).text;
  }
  return undefined;
}