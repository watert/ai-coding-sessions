/**
 * Kimi Code → OpenCode 转换
 */

import path from 'path';
import dayjs from 'dayjs';
import Debug from 'debug';
import { diffLines } from 'diff';
import {
  listKimiCodeSessions,
  listKimiCodeMessages,
  listKimiSubagentsFromMainWire,
  parseKimiVirtualSessionId,
  buildKimiSubagentToolMetadata,
  type KimiSessionItem,
  type KimiMessageItem,
  type KimiSubagentMeta,
  type KimiToolCallItem,
  type KimiUsage,
  type KimiMessageRole,
} from './kimi-code';
import { checkSessionStatus } from './opencode';
import { calculateSessionPricingFromUnifiedMessages, type SessionPricing } from '../pricing';
import type { UnifiedSessionInfo, UnifiedSessionDetail, UnifiedMessage } from './types';
import type { BashSignals } from '../core';
import { classifyBashCommands, extractBashCommands, EMPTY_BASH_SIGNALS } from './bash-signals';
import { inferDeliverableSignals } from './deliverable-signals';
import { maxContextFromUnifiedMessages, sanitizeUserTextParts, buildLastTokenInfo } from './utils';
import { buildActivitySpanFromUnifiedMessages } from './usage-by-day';
import {
  createTimingLists,
  pushAssistantTimingSample,
  summarizeTimingLists,
} from '../lib/timing-stats';

const debugFallback = Debug('fetchav:kimi:fallback');

// ==================== Kimi Code → OpenCode 转换 ====================

function convertKimiUsageToTokens(usage: KimiUsage | undefined): {
  total: number;
  input: number;
  output: number;
  cache?: { read: number; write: number };
  context?: { total: number; input: number; cacheRead: number };
} | undefined {
  if (!usage) return undefined;
  // total 与 opencode 语义对齐：input + cache_read + output
  const tokens: {
    total: number;
    input: number;
    output: number;
    cache?: { read: number; write: number };
    context?: { total: number; input: number; cacheRead: number };
  } = {
    total: usage.inputOther + usage.inputCacheRead + usage.output,
    input: usage.inputOther,
    output: usage.output,
  };
  if (usage.inputCacheRead > 0 || usage.inputCacheCreation > 0) {
    tokens.cache = {
      read: usage.inputCacheRead,
      write: usage.inputCacheCreation,
    };
  }
  return tokens;
}

function convertKimiToolCallToPart(
  toolCall: KimiToolCallItem,
  sessionId: string,
  messageId: string,
): UnifiedMessage['parts'][number] {
  const result = toolCall.result;
  const hasResult = result !== undefined;
  const isError = !!(
    hasResult
    && typeof result === 'object'
    && result !== null
    && 'isError' in result
    && (result as { isError?: unknown }).isError
  );
  const subMeta = buildKimiSubagentToolMetadata({
    rootSessionId: sessionId,
    toolName: toolCall.name,
    args: toolCall.args,
    result,
  });
  return {
    type: 'tool',
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: messageId,
    tool: toolCall.name,
    callID: toolCall.toolCallId,
    time: { start: Date.now(), end: Date.now() },
    state: {
      status: hasResult ? (isError ? 'failed' : 'completed') : 'calling',
      input: toolCall.args,
      output: result,
      title: toolCall.description,
      ...(isError ? { error: result } : {}),
      ...(subMeta ? { metadata: subMeta } : {}),
    },
  };
}

/** kimi finishReason → OpenCode finish */
function normalizeKimiFinish(reason?: string): string | undefined {
  if (!reason) return undefined;
  if (reason === 'end_turn') return 'stop';
  if (reason === 'tool_use') return 'tool-calls';
  return reason;
}

function convertKimiMessage(
  msg: KimiMessageItem,
  sessionId: string,
  onFallback?: (msgId: string, streamDurationMs: number, latencyMs: number, timestamp: number) => void,
): UnifiedMessage {
  const timestamp = msg.timestamp;
  // kimi 的 timestamp 是 step 完成/开始时间；用 latency/streamDuration 反推完整时间线
  const streamDurationMs = msg.streamDurationMs || 0;
  const latencyMs = msg.latencyMs || 0;
  const isCompaction = !!msg.text?.startsWith('[Context Compacted]');
  // step.end 才会写入 finishReason；无 finishReason 视为 step 未结束（进行中）
  // compact 合成消息视作已结束
  const stepEnded = !!msg.finishReason || msg.role === 'user' || isCompaction;
  const decodeStart = streamDurationMs > 0 ? timestamp - streamDurationMs : timestamp;
  const created = latencyMs > 0 ? decodeStart - latencyMs : decodeStart;
  // 时间字段缺失时静默回退会产生错位时间线；通过回调由调用方汇总，避免单条消息刷屏
  // user / compact 消息本身没有正常 step 时序，不视为异常
  if ((streamDurationMs <= 0 || latencyMs <= 0) && onFallback && msg.role === 'assistant' && !isCompaction) {
    onFallback(msg.uuid, streamDurationMs, latencyMs, timestamp);
  }

  const finish = normalizeKimiFinish(msg.finishReason) || (isCompaction ? 'stop' : undefined);
  const messageInfo: UnifiedMessage['info'] = {
    id: msg.uuid,
    sessionID: sessionId,
    role: msg.role,
    time: {
      created,
      decodeStart,
      // 仅 step 结束后写 completed，避免进行中消息被误判为 done
      ...(stepEnded ? { completed: timestamp } : {}),
    },
    parentID: msg.parentID,
    path: { cwd: msg.cwd || '', root: '' },
    ...(finish ? { finish } : {}),
    ...(isCompaction ? { compaction: true } : {}),
  };

  if (msg.model) {
    const modelParts = msg.model.split('/');
    if (modelParts.length >= 2) {
      messageInfo.model = { providerID: modelParts[0], modelID: modelParts.slice(1).join('/') };
    } else {
      messageInfo.model = { providerID: 'unknown', modelID: msg.model };
    }
  }

  if (msg.thinkingEffort) {
    messageInfo.thinkingEffort = msg.thinkingEffort;
  }

  if (msg.usage) {
    const tokens = convertKimiUsageToTokens(msg.usage);
    messageInfo.tokens = tokens;
    // 用最终 step 的用量标记真实 context window，与 turn 总消耗区分
    if (tokens && msg.lastStepUsage) {
      tokens.context = {
        total: msg.lastStepUsage.inputOther + msg.lastStepUsage.inputCacheRead,
        input: msg.lastStepUsage.inputOther,
        cacheRead: msg.lastStepUsage.inputCacheRead,
      };
    }
  }

  // assistant 消息计算 prefill / decode TPS
  if (msg.role === 'assistant' && messageInfo.tokens) {
    const { input = 0, output = 0 } = messageInfo.tokens;
    const tps: { prefill?: number; decode?: number } = {};
    // 与 list 视图一致：过滤极端 latency，避免跨接口数据漂移
    if (latencyMs > 0 && latencyMs < 300000 && input > 0) {
      tps.prefill = Number((input / (latencyMs / 1000)).toFixed(2));
    }
    if (streamDurationMs > 0 && output > 0) {
      tps.decode = Number((output / (streamDurationMs / 1000)).toFixed(2));
    }
    if (tps.prefill || tps.decode) {
      messageInfo.tps = tps;
    }
  }

  const parts: UnifiedMessage['parts'] = [];
  if (msg.parts && msg.parts.length > 0) {
    // 使用按原始顺序重建的 parts，对齐 OpenCode 协议
    for (const p of msg.parts) {
      if (p.type === 'text') {
        parts.push({
          type: 'text',
          id: crypto.randomUUID(),
          sessionID: sessionId,
          messageID: msg.uuid,
          text: p.text,
        });
      } else if (p.type === 'reasoning') {
        parts.push({
          type: 'reasoning',
          id: crypto.randomUUID(),
          sessionID: sessionId,
          messageID: msg.uuid,
          text: p.text,
          state: p.state || 'done',
        });
      } else if (p.type === 'tool') {
        const input = p.state?.input || {};
        const output = p.state?.output;
        const subMeta = buildKimiSubagentToolMetadata({
          rootSessionId: sessionId,
          toolName: p.tool,
          args: input,
          result: output,
        });
        parts.push({
          type: 'tool',
          id: crypto.randomUUID(),
          sessionID: sessionId,
          messageID: msg.uuid,
          tool: p.tool,
          callID: p.callID,
          state: {
            status: p.state?.status || 'completed',
            input,
            output,
            title: p.state?.title,
            ...(subMeta ? { metadata: subMeta } : {}),
          },
        });
      }
    }
  } else {
    // fallback：旧式聚合字段
    if (msg.text) {
      parts.push({
        type: 'text',
        id: crypto.randomUUID(),
        sessionID: sessionId,
        messageID: msg.uuid,
        text: msg.text,
      });
    }
    if (msg.thinking) {
      parts.push({
        type: 'reasoning',
        id: crypto.randomUUID(),
        sessionID: sessionId,
        messageID: msg.uuid,
        text: msg.thinking,
        state: 'done',
      });
    }
    for (const tc of msg.toolCalls) {
      parts.push(convertKimiToolCallToPart(tc, sessionId, msg.uuid));
    }
  }

  return { info: messageInfo, parts };
}

function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split('\n');
  // 文本以换行结尾时，最后一行为空行，不计入有效行数
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** 用 diff 库计算两段文本的行级差异 */
function calculateLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const changes = diffLines(oldText, newText);
  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    if (change.added) additions += change.count || 0;
    if (change.removed) deletions += change.count || 0;
  }
  return { additions, deletions };
}

function calculateEditDiffsFromKimiMessages(messages: UnifiedMessage[]): {
  additions: number;
  deletions: number;
  filesChanged: number;
  files: string[];
} {
  let totalAdditions = 0;
  let totalDeletions = 0;
  const filesChanged = new Set<string>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool') continue;
      const name = (part.tool || '').toLowerCase();
      if (!['edit', 'write'].includes(name)) continue;

      const state = typeof part.state === 'object' && part.state !== null ? part.state : {};
      const input = (state as { input?: Record<string, unknown> }).input || {};
      const output = state.output;
      const resultText = typeof output === 'object' ? JSON.stringify(output) : String(output || '');

      let filePath = (input.path as string) || (input.filePath as string) || (state.title as string) || '';
      let additions = 0;
      let deletions = 0;

      if (name === 'edit') {
        // Kimi Edit 的 result 只有 "Replaced N occurrence in ..."，没有 +/-/行数，
        // 因此用 diff 库从 args.old_string / new_string 计算真实差异
        const oldStr = String(input.old_string || '');
        const newStr = String(input.new_string || '');
        const diff = calculateLineDiff(oldStr, newStr);
        additions = diff.additions;
        deletions = diff.deletions;
      } else if (name === 'write' && input.content) {
        additions = countLines(String(input.content));
      }

      // fallback：若 input 无法计算，尝试从 result 文本中解析 +xx / -xx 行数
      if (additions === 0 && deletions === 0) {
        const diffMatch = resultText.match(/\+\d+\s*\/\s*-\d+/);
        if (diffMatch) {
          const [a, d] = diffMatch[0].split('/').map(s => parseInt(s.replace(/[+\s-]/g, ''), 10));
          if (!isNaN(a)) additions = a;
          if (!isNaN(d)) deletions = d;
        }
      }

      totalAdditions += additions;
      totalDeletions += deletions;
      if (filePath) filesChanged.add(filePath);
    }
  }

  return {
    additions: totalAdditions,
    deletions: totalDeletions,
    filesChanged: filesChanged.size,
    files: [...filesChanged],
  };
}

interface KimiTextPart {
  role: KimiMessageRole;
  text: string;
  tool: string;
  duration: number;
  startTime: number;
  endTime: number;
}

async function getKimiSessionStats(
  session: KimiSessionItem,
  preloadedMessages?: KimiMessageItem[],
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
    editDiffs: { additions: number; deletions: number; filesChanged: number };
    bashSignals?: BashSignals;
    fallbackCount?: number;
    last_message?: UnifiedSessionInfo['last_message'];
    last_message_tokens?: number;
    lastTokenInfo?: UnifiedSessionInfo['lastTokenInfo'];
    max_context_tokens?: number;
    textParts?: KimiTextPart[];
    userParts?: KimiTextPart[];
    avg_tps?: number;
    avg_latency_ms?: number;
    avg_prefill_tps?: number;
    assistant_tps_list?: number[];
    latency_list?: number[];
    prefill_tps_list?: number[];
    time_compacting?: number;
    compact_count?: number;
  };
  messages: KimiMessageItem[];
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
    editDiffs: { additions: 0, deletions: 0, filesChanged: 0 },
    bashSignals: EMPTY_BASH_SIGNALS,
  };

  try {
    const messages = preloadedMessages || await listKimiCodeMessages({ sessionId: session.sessionId, sessionDir: session.sessionDir });
    stats.total_messages = messages.length;

    const models = new Set<string>();
    const textParts: KimiTextPart[] = [];
    const timingLists = createTimingLists();
    let firstModel: string | undefined;

    for (const msg of messages) {
      if (msg.role === 'user') {
        stats.total_user_messages++;
      }
      stats.total_tool_calls += msg.toolCalls.length;
      for (const part of msg.parts || []) {
        if (part.type !== 'tool') continue;
        if (part.state?.status === 'completed') stats.total_tool_calls_success++;
        else if (['failed', 'error'].includes(part.state?.status)) stats.total_tool_calls_failed++;
      }

      if (msg.usage) {
        stats.total_input += msg.usage.inputOther || 0;
        stats.total_output += msg.usage.output || 0;
        stats.total_cache_read += msg.usage.inputCacheRead || 0;
        stats.total_cache_write += msg.usage.inputCacheCreation || 0;
      }

      if (msg.model) {
        models.add(msg.model);
        if (!firstModel) firstModel = msg.model;
      }

      if (msg.text || msg.thinking) {
        textParts.push({
          role: msg.role,
          text: [msg.text, msg.thinking].filter(Boolean).join('\n'),
          tool: '',
          duration: msg.streamDurationMs || 0,
          startTime: msg.timestamp,
          endTime: msg.timestamp + (msg.streamDurationMs || 0),
        });
      }

      if (msg.role === 'assistant' && msg.latencyMs && msg.latencyMs > 0 && msg.latencyMs < 300000) {
        pushAssistantTimingSample(timingLists, {
          latencyMs: msg.latencyMs,
          outputTokens: msg.usage?.output || 0,
          decodeDurationMs: msg.streamDurationMs && msg.streamDurationMs > 0 ? msg.streamDurationMs : undefined,
          inputTokens: msg.usage?.inputOther || 0,
        });
      }
    }

    stats.total_tokens = stats.total_input + stats.total_cache_read + stats.total_output;
    stats.models_used = Array.from(models).join(',');
    if (firstModel && !stats.models_used) {
      stats.models_used = firstModel;
    }

    const timingSummary = summarizeTimingLists(timingLists);

    let fallbackCount = 0;
    const unifiedMessages = messages.map(msg => convertKimiMessage(msg, session.sessionId, () => fallbackCount++));
    stats.editDiffs = calculateEditDiffsFromKimiMessages(unifiedMessages);
    stats.bashSignals = classifyBashCommands(extractBashCommands(unifiedMessages));

    const pricing = calculateSessionPricingFromUnifiedMessages(unifiedMessages);

    const compactTimestamps = messages
      .filter(m => m.text?.startsWith('[Context Compacted]'))
      .map(m => m.timestamp);
    const compact_count = compactTimestamps.length || undefined;
    const time_compacting = compactTimestamps.length > 0
      ? Math.max(...compactTimestamps)
      : undefined;

    let userParts = sanitizeUserTextParts(textParts.filter(p => p.role === 'user'));
    userParts = userParts.filter((r, i) => {
      const prevText = i > 0 ? userParts[i - 1].text : '';
      return prevText !== r.text;
    });

    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    let last_message_tokens: number | undefined;
    let last_message: UnifiedSessionInfo['last_message'] | undefined;
    if (lastMsg) {
      try {
        const converted = convertKimiMessage(lastMsg, session.sessionId);
        last_message = converted.info;
        last_message_tokens = converted.info.tokens?.total;
      } catch {
        // ignore
      }
    }
    const lastTokenInfo = buildLastTokenInfo(unifiedMessages);

    return {
      stats: {
        ...stats,
        total_user_messages: userParts.length,
        fallbackCount,
        last_message,
        last_message_tokens,
        lastTokenInfo,
        max_context_tokens: maxContextFromUnifiedMessages(unifiedMessages) || undefined,
        textParts: textParts.length > 0 ? textParts : undefined,
        userParts: userParts.length > 0 ? userParts : undefined,
        ...timingSummary,
        time_compacting,
        compact_count,
      },
      messages,
      unifiedMessages,
      pricing,
    };
  } catch (e) {
    console.warn(`[ai-coding-stats] 获取 Kimi session 统计失败: ${session.sessionId}`, e);
    return { stats, messages: [], unifiedMessages: [], pricing: { usd: 0, cny: 0 } };
  }
}

async function getKimiSubagentSessionStats(
  root: KimiSessionItem,
  meta: KimiSubagentMeta,
  preloadedMessages?: KimiMessageItem[],
) {
  const pseudo: KimiSessionItem = {
    sessionId: meta.virtualSessionId,
    sessionDir: root.sessionDir,
    workDir: root.workDir,
    title: meta.description || `${meta.subagentType} (${meta.agentDir})`,
    createdAt: root.createdAt,
    updatedAt: root.updatedAt,
  };
  return getKimiSessionStats(pseudo, preloadedMessages);
}

export async function convertKimiSubagentSession(
  root: KimiSessionItem,
  meta: KimiSubagentMeta,
  preloadedMessages?: KimiMessageItem[],
): Promise<UnifiedSessionInfo> {
  const { stats, unifiedMessages, pricing } = await getKimiSubagentSessionStats(root, meta, preloadedMessages);
  if ((stats.fallbackCount ?? 0) > 0) {
    debugFallback(`[convertKimiSubagentSession] 时间字段回退汇总 sessionId=${meta.virtualSessionId} fallbackCount=${stats.fallbackCount}/${unifiedMessages.length}`);
  }
  // AgentSwarm 返回的 outcome 比 wire 文件本身更准确地反映子 agent 是否失败/被中断
  let session_status = checkSessionStatus(unifiedMessages);
  if (meta.outcome === 'failed') session_status = 'error';
  else if (meta.outcome === 'aborted') session_status = 'aborted';
  else if (meta.outcome === 'started' || meta.outcome === 'running') session_status = 'in-progress';

  const title = meta.description
    ? `${meta.subagentType}: ${meta.description}`
    : `${meta.subagentType} (${meta.agentDir})`;

  // 仅失败/中断时注入 AgentSwarm 错误详情（completed 的 body 不是 error）
  const last_message: UnifiedSessionInfo['last_message'] =
    (meta.outcome === 'failed' || meta.outcome === 'aborted') && meta.errorInfo
      ? {
          ...(stats.last_message || {}),
          id: `${meta.virtualSessionId}-error`,
          sessionID: meta.virtualSessionId,
          role: 'assistant',
          text: meta.errorInfo,
          error: meta.errorInfo,
          time: {
            created: root.updatedAt,
            decodeStart: root.updatedAt,
            completed: root.updatedAt,
          },
        }
      : stats.last_message;

  const activity = buildActivitySpanFromUnifiedMessages(
    unifiedMessages,
    root.updatedAt,
    root.createdAt,
  );
  // subagent 活跃时间以自身 wire 为准；root.state.updatedAt 在 swarm 运行期间往往不刷新
  const time_updated = activity.last_active_at_iso
    ? new Date(activity.last_active_at_iso).getTime()
    : root.updatedAt;
  const time_created = activity.first_active_at_iso
    ? new Date(activity.first_active_at_iso).getTime()
    : root.createdAt;

  return {
    id: meta.virtualSessionId,
    project_id: root.workDir,
    parent_id: meta.parentSessionId,
    spawn_group_id: meta.toolCallId || undefined,
    slug: meta.virtualSessionId,
    directory: path.join(root.sessionDir, 'agents', meta.agentDir),
    title,
    version: 'unknown',
    share_url: undefined,
    summary_additions: stats.editDiffs.additions,
    summary_deletions: stats.editDiffs.deletions,
    summary_files: stats.editDiffs.filesChanged,
    summary_diffs: undefined,
    revert: undefined,
    permission: undefined,
    time_created,
    time_updated,
    time_compacting: stats.time_compacting,
    compact_count: stats.compact_count,
    time_archived: undefined,
    workspace_id: undefined,
    project_name: undefined,
    project_worktree: root.workDir,
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
    lastTokenInfo: stats.lastTokenInfo,
    max_context_tokens: stats.max_context_tokens,
    last_message,
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
    source: 'kimi',
  };
}

export async function convertKimiSession(
  session: KimiSessionItem,
  preloadedMessages?: KimiMessageItem[],
): Promise<UnifiedSessionInfo> {
  const { stats, unifiedMessages, pricing } = await getKimiSessionStats(session, preloadedMessages);
  if ((stats.fallbackCount ?? 0) > 0) {
    debugFallback(`[convertKimiSession] 时间字段回退汇总 sessionId=${session.sessionId} fallbackCount=${stats.fallbackCount}/${unifiedMessages.length}`);
  }
  const session_status = checkSessionStatus(unifiedMessages);
  const activity = buildActivitySpanFromUnifiedMessages(
    unifiedMessages,
    session.updatedAt,
    session.createdAt,
  );

  return {
    id: session.sessionId,
    project_id: session.workDir,
    parent_id: undefined,
    slug: session.sessionId,
    directory: session.sessionDir,
    title: session.title,
    version: 'unknown',
    share_url: undefined,
    summary_additions: stats.editDiffs.additions,
    summary_deletions: stats.editDiffs.deletions,
    summary_files: stats.editDiffs.filesChanged,
    summary_diffs: undefined,
    revert: undefined,
    permission: undefined,
    time_created: session.createdAt,
    time_updated: session.updatedAt,
    time_compacting: stats.time_compacting,
    compact_count: stats.compact_count,
    time_archived: undefined,
    workspace_id: undefined,
    project_name: undefined,
    project_worktree: session.workDir,

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
    lastTokenInfo: stats.lastTokenInfo,
    max_context_tokens: stats.max_context_tokens,
    last_message: stats.last_message,
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

    source: 'kimi',
  };
}

export async function getKimiSessionDetail(sessionId: string, sessionDir: string): Promise<UnifiedSessionDetail | null> {
  const parsed = parseKimiVirtualSessionId(sessionId);
  const sessions = await listKimiCodeSessions();
  const root = sessions.find(s => s.sessionId === parsed.rootSessionId);
  if (!root) {
    return null;
  }
  const dir = sessionDir || root.sessionDir;

  if (parsed.agentDir) {
    const metas = await listKimiSubagentsFromMainWire(dir, parsed.rootSessionId);
    const meta = metas.find(m => m.agentDir === parsed.agentDir);
    if (!meta) return null;
    const messages = await listKimiCodeMessages({ sessionId, sessionDir: dir });
    let fallbackCount = 0;
    const unifiedMessages = messages.map(msg => convertKimiMessage(msg, sessionId, () => fallbackCount++));
    if (fallbackCount > 0) {
      debugFallback(`[getKimiSessionDetail] 时间字段回退汇总 sessionId=${sessionId} fallbackCount=${fallbackCount}/${messages.length}`);
    }
    const pricing = calculateSessionPricingFromUnifiedMessages(unifiedMessages);
    const info = await convertKimiSubagentSession(root, meta, messages);
    return {
      info: { ...info, pricing },
      messages: unifiedMessages,
      editDiffs: calculateEditDiffsFromKimiMessages(unifiedMessages),
      pricing,
    };
  }

  const messages = await listKimiCodeMessages({ sessionId: parsed.rootSessionId, sessionDir: dir });
  let fallbackCount = 0;
  const unifiedMessages = messages.map(msg => convertKimiMessage(msg, parsed.rootSessionId, () => fallbackCount++));
  if (fallbackCount > 0) {
    debugFallback(`[getKimiSessionDetail] 时间字段回退汇总 sessionId=${parsed.rootSessionId} fallbackCount=${fallbackCount}/${messages.length}`);
  }
  const editDiffs = calculateEditDiffsFromKimiMessages(unifiedMessages);
  const pricing = calculateSessionPricingFromUnifiedMessages(unifiedMessages);
  const info = await convertKimiSession(root, messages);

  return {
    info: { ...info, pricing },
    messages: unifiedMessages,
    editDiffs,
    pricing,
  };
}
