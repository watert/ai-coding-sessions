/**
 * Codex → OpenCode 转换
 */

import dayjs from 'dayjs';
import {
  listCodexSessions,
  listCodexMessages,
  getCodexSessionUsageSummary,
  type CodexSessionItem,
  type CodexMessageItem,
} from './codex-code';
import { checkSessionStatus } from './opencode';
import { calculateSessionPricingFromUnifiedMessages, type SessionPricing } from '../pricing';
import type { UnifiedSessionInfo, UnifiedSessionDetail, UnifiedMessage } from './types';
import type { BashSignals } from '../core';
import { classifyBashCommands, extractBashCommands, EMPTY_BASH_SIGNALS } from './bash-signals';
import { inferDeliverableSignals } from './deliverable-signals';
import { maxContextFromUnifiedMessages, sanitizeUserTextParts } from './utils';
import { buildActivitySpanFromUnifiedMessages } from './usage-by-day';
import {
  createTimingLists,
  pushAssistantTimingSample,
  summarizeTimingLists,
} from '../lib/timing-stats';

function convertCodexUsageToTokens(usage: CodexMessageItem['usage']): any {
  if (!usage) return undefined;
  const tokens: any = {
    total: usage.total || usage.input + usage.cacheRead + usage.output,
    input: usage.input,
    output: usage.output,
    reasoning: usage.reasoning || 0,
  };
  if (usage.cacheRead > 0) {
    tokens.cache = { read: usage.cacheRead, write: 0 };
  }
  return tokens;
}

function convertCodexMessage(
  msg: CodexMessageItem,
  sessionId: string,
  onFallback?: (msgId: string, streamDurationMs: number, latencyMs: number, timestamp: number) => void,
): UnifiedMessage {
  const timestamp = msg.timestamp;
  const streamDurationMs = msg.streamDurationMs || 0;
  const latencyMs = msg.latencyMs || 0;
  const decodeStart = streamDurationMs > 0 ? timestamp - streamDurationMs : timestamp;
  const created = latencyMs > 0 ? decodeStart - latencyMs : decodeStart;

  if ((streamDurationMs <= 0 || latencyMs <= 0) && onFallback && msg.role === 'assistant') {
    onFallback(msg.uuid, streamDurationMs, latencyMs, timestamp);
  }

  const messageInfo: any = {
    id: msg.uuid,
    sessionID: sessionId,
    role: msg.role,
    time: {
      created,
      decodeStart,
      completed: timestamp,
    },
    parentID: msg.parentID,
    path: { cwd: '', root: '' },
  };

  if (msg.model) {
    // Codex model 可能是 MiniMax-M3 / mimo-v2.5-pro / opencode-go/mimo-v2.5-pro
    if (msg.model.includes('/')) {
      const parts = msg.model.split('/');
      messageInfo.model = { providerID: parts[0], modelID: parts.slice(1).join('/') };
    } else {
      messageInfo.model = { providerID: 'codex', modelID: msg.model };
    }
  }

  if (msg.usage) {
    messageInfo.tokens = convertCodexUsageToTokens(msg.usage);
    // last_token_usage.total_tokens 即当时 context 规模
    messageInfo.tokens.context = {
      total: msg.usage.input + msg.usage.cacheRead,
      input: msg.usage.input,
      cacheRead: msg.usage.cacheRead,
    };
  }

  if (msg.role === 'assistant' && messageInfo.tokens) {
    const { input = 0, output = 0 } = messageInfo.tokens;
    const tps: { prefill?: number; decode?: number } = {};
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

  const parts: any[] = [];
  if (msg.parts && msg.parts.length > 0) {
    // part id 确定性生成（messageID + 下标 / callID），轮询重拉不漂移
    msg.parts.forEach((p, i) => {
      if (p.type === 'text') {
        parts.push({
          type: 'text',
          id: `${msg.uuid}-p${i}`,
          sessionID: sessionId,
          messageID: msg.uuid,
          text: p.text,
        });
      } else if (p.type === 'reasoning') {
        parts.push({
          type: 'reasoning',
          id: `${msg.uuid}-p${i}`,
          sessionID: sessionId,
          messageID: msg.uuid,
          text: p.text,
          state: p.state || 'done',
        });
      } else if (p.type === 'tool') {
        parts.push({
          type: 'tool',
          id: `${msg.uuid}-tool-${p.callID || i}`,
          sessionID: sessionId,
          messageID: msg.uuid,
          tool: p.tool,
          callID: p.callID,
          state: {
            status: p.state?.status || 'completed',
            input: p.state?.input || {},
            output: p.state?.output,
            title: p.state?.title,
          },
        });
      }
    });
  } else {
    if (msg.text) {
      parts.push({
        type: 'text',
        id: `${msg.uuid}-text`,
        sessionID: sessionId,
        messageID: msg.uuid,
        text: msg.text,
      });
    }
    if (msg.thinking) {
      parts.push({
        type: 'reasoning',
        id: `${msg.uuid}-reasoning`,
        sessionID: sessionId,
        messageID: msg.uuid,
        text: msg.thinking,
        state: 'done',
      });
    }
    for (const tc of msg.toolCalls) {
      parts.push({
        type: 'tool',
        id: `${msg.uuid}-tool-${tc.toolCallId}`,
        sessionID: sessionId,
        messageID: msg.uuid,
        tool: tc.name,
        callID: tc.toolCallId,
        state: {
          status: tc.result !== undefined ? 'completed' : 'calling',
          input: tc.args,
          output: tc.result,
          title: tc.name,
        },
      });
    }
  }

  return { info: messageInfo, parts };
}

/** 供测试 / 宿主复用：从 codex tool parts 统计 editDiffs */
export function calculateEditDiffsFromCodexMessages(messages: UnifiedMessage[]): {
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
      // Codex 常用 exec_command / apply_patch 等
      if (!['edit', 'write', 'apply_patch', 'exec_command'].includes(name)) continue;

      const input = part.state?.input || {};
      const output = part.state?.output;
      const resultText = typeof output === 'object' ? JSON.stringify(output) : String(output || '');

      let filePath = (input.path as string) || (input.filePath as string) || (part.state?.title as string) || '';
      let additions = 0;
      let deletions = 0;

      if (name === 'write' && input.content) {
        additions = String(input.content).split('\n').length;
      }

      const diffMatch = resultText.match(/\+\d+\s*\/\s*-\d+/);
      if (diffMatch) {
        const [a, d] = diffMatch[0].split('/').map((s) => parseInt(s.replace(/[+\s-]/g, ''), 10));
        if (!isNaN(a)) additions = a;
        if (!isNaN(d)) deletions = d;
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

async function getCodexSessionStats(
  session: CodexSessionItem,
  preloadedMessages?: CodexMessageItem[],
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
  messages: CodexMessageItem[];
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
    const messages = preloadedMessages || await listCodexMessages({
      sessionId: session.sessionId,
      rolloutPath: session.rolloutPath,
    });
    stats.total_messages = messages.length;

    const models = new Set<string>();
    const textParts: any[] = [];
    const timingLists = createTimingLists();
    if (session.model) models.add(session.model);

    for (const msg of messages) {
      if (msg.role === 'user') stats.total_user_messages++;
      stats.total_tool_calls += msg.toolCalls.length;
      for (const part of msg.parts || []) {
        if (part.type !== 'tool') continue;
        if (part.state?.status === 'completed') stats.total_tool_calls_success++;
        else if (['failed', 'error'].includes(part.state?.status)) stats.total_tool_calls_failed++;
      }

      if (msg.usage) {
        stats.total_input += msg.usage.input || 0;
        stats.total_output += msg.usage.output || 0;
        stats.total_cache_read += msg.usage.cacheRead || 0;
        stats.total_reasoning += msg.usage.reasoning || 0;
      }

      if (msg.model) models.add(msg.model);

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
          inputTokens: (msg.usage?.input || 0) + (msg.usage?.cacheRead || 0),
        });
      }
    }

    // 若消息级 usage 全空，回退 jsonl 汇总 / sqlite tokens_used
    if (stats.total_input + stats.total_output + stats.total_cache_read === 0) {
      try {
        const summary = await getCodexSessionUsageSummary(session.sessionId);
        stats.total_input = summary.input;
        stats.total_output = summary.output;
        stats.total_cache_read = summary.cacheRead;
        stats.total_reasoning = summary.reasoning;
        if (summary.model) models.add(summary.model);
      } catch {
        if (session.tokensUsed) {
          stats.total_tokens = session.tokensUsed;
        }
      }
    }

    stats.total_tokens = stats.total_input + stats.total_cache_read + stats.total_output;
    if (stats.total_tokens === 0 && session.tokensUsed) {
      stats.total_tokens = session.tokensUsed;
    }
    stats.models_used = Array.from(models).join(',') || session.model || '';

    const timingSummary = summarizeTimingLists(timingLists);

    let fallbackCount = 0;
    const unifiedMessages = messages.map((msg) =>
      convertCodexMessage(msg, session.sessionId, () => fallbackCount++),
    );
    stats.editDiffs = calculateEditDiffsFromCodexMessages(unifiedMessages);
    stats.bashSignals = classifyBashCommands(extractBashCommands(unifiedMessages));
    const pricing = calculateSessionPricingFromUnifiedMessages(unifiedMessages);

    let userParts = sanitizeUserTextParts(textParts.filter((p) => p.role === 'user'));
    userParts = userParts.filter((r, i) => {
      const prevText = i > 0 ? userParts[i - 1].text : '';
      return prevText !== r.text;
    });

    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    let last_message_tokens: number | undefined;
    let last_message: any | undefined;
    if (lastMsg) {
      try {
        const converted = convertCodexMessage(lastMsg, session.sessionId);
        last_message = converted.info;
        last_message_tokens = converted.info.tokens?.total;
      } catch {
        // ignore
      }
    }

    return {
      stats: {
        ...stats,
        total_user_messages: userParts.length || stats.total_user_messages,
        fallbackCount,
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
    console.warn(`[ai-coding-stats] 获取 Codex session 统计失败: ${session.sessionId}`, e);
    return { stats, messages: [], unifiedMessages: [], pricing: { usd: 0, cny: 0 } };
  }
}

export async function convertCodexSession(
  session: CodexSessionItem,
  preloadedMessages?: CodexMessageItem[],
): Promise<UnifiedSessionInfo> {
  const { stats, unifiedMessages, pricing } = await getCodexSessionStats(session, preloadedMessages);
  if ((stats.fallbackCount ?? 0) > 0) {
    console.warn(
      `[convertCodexSession] 时间字段回退汇总 sessionId=${session.sessionId} fallbackCount=${stats.fallbackCount}/${unifiedMessages.length}`,
    );
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
    parent_id: session.parentId,
    slug: session.sessionId,
    directory: session.sessionDir,
    title: session.title,
    version: session.cliVersion || 'unknown',
    share_url: undefined,
    summary_additions: stats.editDiffs.additions,
    summary_deletions: stats.editDiffs.deletions,
    summary_files: stats.editDiffs.filesChanged,
    summary_diffs: undefined,
    revert: undefined,
    permission: undefined,
    time_created: session.createdAt,
    time_updated: session.updatedAt,
    time_compacting: undefined,
    time_archived: session.archived ? session.updatedAt : undefined,
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

    source: 'codex',
  };
}

export async function getCodexSessionDetail(sessionId: string): Promise<UnifiedSessionDetail | null> {
  const sessions = await listCodexSessions();
  const session = sessions.find((s) => s.sessionId === sessionId);
  if (!session) return null;

  const messages = await listCodexMessages({
    sessionId,
    rolloutPath: session.rolloutPath,
  });
  let fallbackCount = 0;
  const unifiedMessages = messages.map((msg) =>
    convertCodexMessage(msg, sessionId, () => fallbackCount++),
  );
  if (fallbackCount > 0) {
    console.warn(
      `[getCodexSessionDetail] 时间字段回退汇总 sessionId=${sessionId} fallbackCount=${fallbackCount}/${messages.length}`,
    );
  }
  const editDiffs = calculateEditDiffsFromCodexMessages(unifiedMessages);
  const pricing = calculateSessionPricingFromUnifiedMessages(unifiedMessages);
  const info = await convertCodexSession(session, messages);

  return {
    info: { ...info, pricing },
    messages: unifiedMessages,
    editDiffs,
    pricing,
  };
}
