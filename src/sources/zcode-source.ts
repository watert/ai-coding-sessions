/**
 * ZCode → OpenCode 统一协议转换
 * 主数据: ~/.zcode/cli/db/db.sqlite (session/message/part + model_usage)
 */

import path from 'path';
import {
  listZcodeSessions,
  listZcodeMessages,
  getZcodeSession,
  normalizeZcodeModel,
  type ZcodeSessionItem,
  type ZcodeMessageItem,
  type ZcodeModelUsage,
} from './zcode-code';
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

// ==================== Message 转换 ====================

/**
 * ZCode 的 tokens.input / model_usage.input_tokens 通常已包含 cache_read
 * （total ≈ input + output，不含再加 cache）。
 * 统一协议要求 input = 非 cache 新输入，与 codex/grok 一致。
 */
function tokensFromMsgOrUsage(msg: ZcodeMessageItem, usage?: ZcodeModelUsage): any | undefined {
  const t = msg.data?.tokens;
  if (t && (t.total || t.input || t.output)) {
    const rawInput = t.input || 0;
    const cacheRead = t.cache?.read ?? usage?.cacheReadTokens ?? 0;
    const cacheWrite = t.cache?.write ?? usage?.cacheWriteTokens ?? 0;
    // 非 cache 输入 = 全量 prompt - cache
    const input = Math.max(0, rawInput - cacheRead);
    const output = t.output || 0;
    const reasoning = t.reasoning || 0;
    // zcode total 一般为 rawInput + output；回退也按此算，避免把 cache 再加一遍
    const total = t.total || (rawInput + output);
    const tokens: any = {
      total,
      input,
      output,
      reasoning,
    };
    if (cacheRead > 0 || cacheWrite > 0 || t.cache || usage?.cacheReadTokens || usage?.cacheWriteTokens) {
      tokens.cache = { read: cacheRead, write: cacheWrite };
    }
    // context 规模 = 全量 prompt（input 已拆出 cache，再相加）
    tokens.context = {
      total: input + cacheRead,
      input,
      cacheRead,
    };
    return tokens;
  }

  if (!usage) return undefined;
  const rawInput = usage.inputTokens || 0;
  const cacheRead = usage.cacheReadTokens || 0;
  const cacheWrite = usage.cacheWriteTokens || 0;
  const input = Math.max(0, rawInput - cacheRead);
  const output = usage.outputTokens || 0;
  return {
    total: usage.computedTotalTokens || (rawInput + output),
    input,
    output,
    reasoning: usage.reasoningTokens || 0,
    cache: { read: cacheRead, write: cacheWrite },
    context: {
      total: input + cacheRead,
      input,
      cacheRead,
    },
  };
}

function resolveModel(msg: ZcodeMessageItem, usage?: ZcodeModelUsage): { providerID: string; modelID: string } | undefined {
  const rawProvider =
    usage?.providerId
    || msg.data?.providerID
    || msg.data?.model?.providerID;
  const rawModel =
    usage?.modelId
    || msg.data?.modelID
    || msg.data?.model?.modelID;
  if (!rawModel && !rawProvider) return undefined;
  return normalizeZcodeModel(rawProvider, rawModel);
}

/** 从 model_usage 或 message.time + part.time 推导 timing */
function resolveTiming(msg: ZcodeMessageItem, usage?: ZcodeModelUsage): {
  created: number;
  decodeStart?: number;
  completed?: number;
  latencyMs: number;
  decodeMs: number;
} {
  if (usage && usage.startedAt) {
    const created = usage.startedAt;
    const decodeStart = usage.firstTokenAt
      || (usage.ttftMs != null ? created + usage.ttftMs : undefined);
    // running 中的 usage 不算 completed（避免 LLM 步结束、tool 仍 running 时误标 done）
    const completed = usage.status === 'running'
      ? undefined
      : (usage.completedAt
        || (usage.durationMs != null ? created + usage.durationMs : undefined));
    const latencyMs = usage.ttftMs
      ?? (decodeStart && decodeStart > created ? decodeStart - created : 0);
    const decodeMs = (usage.durationMs != null && usage.ttftMs != null)
      ? Math.max(0, usage.durationMs - usage.ttftMs)
      : (completed && decodeStart && completed > decodeStart ? completed - decodeStart : 0);
    return { created, decodeStart, completed, latencyMs, decodeMs };
  }

  const created = msg.data?.time?.created || msg.timeCreated;
  // 仅用 message 自带 completed；勿回落 timeUpdated（流式写入会不断更新，误标 done）
  const completed = msg.data?.time?.completed;
  const partStarts = (msg.parts || [])
    .map((p) => p?.time?.start)
    .filter((t): t is number => typeof t === 'number')
    .sort((a, b) => a - b);
  const decodeStart = partStarts[0];
  const latencyMs = decodeStart && decodeStart > created ? decodeStart - created : 0;
  const decodeMs = decodeStart && completed && completed > decodeStart ? completed - decodeStart : 0;
  return { created, decodeStart, completed, latencyMs, decodeMs };
}

export function convertZcodeMessage(msg: ZcodeMessageItem): UnifiedMessage {
  const usage = msg.modelUsage;
  const timing = resolveTiming(msg, usage);
  const model = resolveModel(msg, usage);
  const tokens = msg.role === 'assistant' ? tokensFromMsgOrUsage(msg, usage) : undefined;

  const messageInfo: any = {
    ...msg.data,
    id: msg.id,
    sessionID: msg.sessionId,
    role: msg.role,
    time: {
      ...(msg.data?.time || {}),
      created: timing.created,
      decodeStart: timing.decodeStart,
      completed: timing.completed,
    },
    parentID: msg.data?.parentID,
    path: msg.data?.path || { cwd: '', root: '' },
  };

  // finish: message 优先；否则补 model_usage.finishReason（zcode 常见只写 usage）
  if (!messageInfo.finish && usage?.finishReason) {
    messageInfo.finish = usage.finishReason;
  }

  // usage 终态 error/cancelled 且 message 无 error 时补齐，供 checkSessionStatus
  if (!messageInfo.error && usage) {
    if (usage.status === 'cancelled') {
      messageInfo.error = { name: 'MessageAbortedError', data: { message: 'Aborted' } };
    } else if (usage.status === 'error') {
      messageInfo.error = {
        name: 'MessageError',
        data: { message: usage.finishReason || 'error' },
      };
    }
  }

  if (model) {
    messageInfo.model = model;
    messageInfo.providerID = model.providerID;
    messageInfo.modelID = model.modelID;
  }

  if (tokens) {
    messageInfo.tokens = tokens;
  }

  // prefill / decode TPS
  if (msg.role === 'assistant' && tokens) {
    const { input = 0, output = 0, reasoning = 0 } = tokens;
    const tps: { prefill?: number; decode?: number } = {};
    if (timing.latencyMs > 0 && timing.latencyMs < 300000 && input > 0) {
      tps.prefill = Number((input / (timing.latencyMs / 1000)).toFixed(2));
    }
    const genTok = (output || 0) + (reasoning || 0);
    if (timing.decodeMs > 0 && genTok > 0) {
      tps.decode = Number((genTok / (timing.decodeMs / 1000)).toFixed(2));
    }
    if (tps.prefill || tps.decode) messageInfo.tps = tps;
  }

  // parts：已带 id/sessionID/messageID
  const parts = (msg.parts || []).map((p) => {
    if (p.type === 'tool' && p.tool) {
      // 统一小写 tool 名便于 bash/edit 嗅探（展示仍保留原名在 title）
      return {
        ...p,
        tool: p.tool,
        state: p.state || {},
      };
    }
    return p;
  });

  return { info: messageInfo, parts };
}

// ==================== Edit diffs ====================

function calculateEditDiffs(messages: UnifiedMessage[]): {
  additions: number;
  deletions: number;
  filesChanged: number;
  files: string[];
} {
  let totalAdditions = 0;
  let totalDeletions = 0;
  const filesChanged = new Set<string>();

  for (const message of messages) {
    for (const part of message.parts || []) {
      if (part.type !== 'tool') continue;
      const name = (part.tool || '').toLowerCase();
      if (!['edit', 'write', 'multiedit', 'multi_edit'].includes(name)) continue;

      const state = typeof part.state === 'object' && part.state ? part.state : {};
      const input = (state as any).input || {};
      const metadata = (state as any).metadata || {};
      const filediff = metadata.filediff || {};

      let additions = filediff.additions || 0;
      let deletions = filediff.deletions || 0;
      let filePath =
        filediff.path
        || input.path
        || input.filePath
        || (state as any).title
        || '';

      if (name === 'write' && !additions && input.content) {
        additions = String(input.content).split('\n').length;
      }

      totalAdditions += additions;
      totalDeletions += deletions;
      if (filePath) filesChanged.add(String(filePath));
    }
  }

  return {
    additions: totalAdditions,
    deletions: totalDeletions,
    filesChanged: filesChanged.size,
    files: Array.from(filesChanged),
  };
}

// ==================== Stats ====================

async function getZcodeSessionStats(
  session: ZcodeSessionItem,
  preloadedMessages?: ZcodeMessageItem[],
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
    bashSignals?: BashSignals;
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
  };
  messages: ZcodeMessageItem[];
  unifiedMessages: UnifiedMessage[];
  pricing: SessionPricing;
}> {
  const stats = {
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
    editDiffs: { additions: 0, deletions: 0, filesChanged: 0 } as {
      additions: number;
      deletions: number;
      filesChanged: number;
      files?: string[];
    },
    bashSignals: EMPTY_BASH_SIGNALS as BashSignals,
  };

  try {
    const messages = preloadedMessages || await listZcodeMessages(session.sessionId);
    stats.total_messages = messages.length;

    const models = new Set<string>();
    const textParts: any[] = [];
    const timingLists = createTimingLists();
    const unifiedMessages = messages.map(convertZcodeMessage);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const um = unifiedMessages[i];
      if (msg.role === 'user') stats.total_user_messages++;

      for (const part of msg.parts || []) {
        if (part.type !== 'tool') continue;
        stats.total_tool_calls++;
        const st = part.state?.status;
        if (st === 'completed') stats.total_tool_calls_success++;
        else if (st === 'failed' || st === 'error') stats.total_tool_calls_failed++;
      }

      if (um.info.tokens) {
        stats.total_input += um.info.tokens.input || 0;
        stats.total_output += um.info.tokens.output || 0;
        stats.total_reasoning += um.info.tokens.reasoning || 0;
        stats.total_cache_read += um.info.tokens.cache?.read || 0;
        stats.total_cache_write += um.info.tokens.cache?.write || 0;
      }

      const modelKey = um.info.modelID || um.info.model?.modelID;
      if (modelKey) models.add(modelKey);

      // text parts 摘要
      const texts = (msg.parts || [])
        .filter((p) => p.type === 'text' || p.type === 'reasoning')
        .map((p) => p.text)
        .filter(Boolean);
      if (texts.length) {
        const timing = resolveTiming(msg, msg.modelUsage);
        textParts.push({
          role: msg.role,
          text: texts.join('\n'),
          tool: '',
          duration: timing.decodeMs || 0,
          startTime: timing.created,
          endTime: timing.completed || timing.created,
        });
      }

      if (msg.role === 'assistant') {
        const timing = resolveTiming(msg, msg.modelUsage);
        const tokens = um.info.tokens;
        pushAssistantTimingSample(timingLists, {
          latencyMs: timing.latencyMs,
          outputTokens: (tokens?.output || 0) + (tokens?.reasoning || 0),
          decodeDurationMs: timing.decodeMs > 0 ? timing.decodeMs : undefined,
          inputTokens: (tokens?.input || 0) + (tokens?.cache?.read || 0),
        });
      }
    }

    stats.total_tokens = stats.total_input + stats.total_cache_read + stats.total_output;
    stats.models_used = Array.from(models).join(',');
    stats.editDiffs = calculateEditDiffs(unifiedMessages);
    stats.bashSignals = classifyBashCommands(extractBashCommands(unifiedMessages));
    const pricing = calculateSessionPricingFromUnifiedMessages(unifiedMessages);
    const timingSummary = summarizeTimingLists(timingLists);

    let userParts = sanitizeUserTextParts(textParts.filter((p) => p.role === 'user'));
    userParts = userParts.filter((r, i) => {
      const prevText = i > 0 ? userParts[i - 1].text : '';
      return prevText !== r.text;
    });

    const lastWithTokens = [...unifiedMessages].reverse().find((m) => m.info.tokens?.total);
    const last_message = lastWithTokens?.info;
    const last_message_tokens = lastWithTokens?.info.tokens?.total;

    return {
      stats: {
        ...stats,
        total_user_messages: userParts.length || stats.total_user_messages,
        last_message,
        last_message_tokens,
        max_context_tokens: maxContextFromUnifiedMessages(unifiedMessages) || undefined,
        textParts: textParts.length > 0 ? textParts : undefined,
        userParts: userParts.length > 0 ? userParts : undefined,
        ...timingSummary,
      },
      messages,
      unifiedMessages,
      pricing,
    };
  } catch (e) {
    console.warn(`[ai-coding-stats] 获取 ZCode session 统计失败: ${session.sessionId}`, e);
    return { stats, messages: [], unifiedMessages: [], pricing: { usd: 0, cny: 0 } };
  }
}

// ==================== 导出 ====================

export async function convertZcodeSession(
  session: ZcodeSessionItem,
  preloadedMessages?: ZcodeMessageItem[],
): Promise<UnifiedSessionInfo> {
  const { stats, unifiedMessages, pricing } = await getZcodeSessionStats(session, preloadedMessages);
  const session_status = checkSessionStatus(unifiedMessages);
  const activity = buildActivitySpanFromUnifiedMessages(
    unifiedMessages,
    session.updatedAt,
    session.createdAt,
  );

  // 以 message 活动时间为准：session.time_updated 可能被 title 同步等刷新，导致日期窗口误入
  const time_updated = activity.last_active_at_iso
    ? new Date(activity.last_active_at_iso).getTime()
    : session.updatedAt;
  const time_created = activity.first_active_at_iso
    ? new Date(activity.first_active_at_iso).getTime()
    : session.createdAt;

  const projectName = session.directory
    ? path.basename(session.directory)
    : session.projectId || undefined;

  return {
    id: session.sessionId,
    project_id: session.projectId || session.directory,
    parent_id: session.parentId,
    slug: session.slug || session.sessionId,
    directory: session.directory,
    title: session.title,
    version: session.version || 'unknown',
    time_created,
    time_updated,
    time_compacting: session.timeCompacting,
    time_archived: session.timeArchived,
    project_name: projectName,
    project_worktree: session.directory,
    summary_additions: stats.editDiffs.additions || session.summaryAdditions,
    summary_deletions: stats.editDiffs.deletions || session.summaryDeletions,
    summary_files: stats.editDiffs.filesChanged || session.summaryFiles,

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
    usage_source: 'real',

    source: 'zcode',
  };
}

export async function getZcodeSessionDetail(sessionId: string): Promise<UnifiedSessionDetail | null> {
  const session = await getZcodeSession(sessionId);
  if (!session) return null;

  const messages = await listZcodeMessages(sessionId);
  const unifiedMessages = messages.map(convertZcodeMessage);
  const editDiffs = calculateEditDiffs(unifiedMessages);
  const pricing = calculateSessionPricingFromUnifiedMessages(unifiedMessages);
  const info = await convertZcodeSession(session, messages);

  return {
    info: { ...info, pricing },
    messages: unifiedMessages,
    editDiffs,
    pricing,
  };
}
