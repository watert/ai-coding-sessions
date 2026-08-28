/**
 * Claude Code → OpenCode 转换
 */

import _ from 'lodash';
import dayjs from 'dayjs';
import {
  listClaudeCodeSessions,
  listClaudeCodeMessages,
  getProjectPath,
  type ClaudeSessionItem,
  type MsgItem,
} from './claude-code';
import { checkSessionStatus } from './opencode';
import { calculateSessionPricingFromUnifiedMessages, type SessionPricing } from '../pricing';
import type { UnifiedSessionInfo, UnifiedSessionDetail, UnifiedMessage } from './types';
import type { BashSignals } from '../core';
import { classifyBashCommands, extractBashCommands, EMPTY_BASH_SIGNALS } from './bash-signals';
import { inferDeliverableSignals } from './deliverable-signals';
import { asToolPartState, maxContextFromUnifiedMessages, sanitizeUserTextParts } from './utils';
import { buildActivitySpanFromUnifiedMessages } from './usage-by-day';
import {
  createTimingLists,
  pushAssistantTimingSample,
  summarizeTimingLists,
} from '../lib/timing-stats';

// ==================== Claude Code → OpenCode 转换 ====================

/** 从 messages cwd 中提取最频繁的真实工作目录绝对路径 */
function extractProjectWorktree(messages: MsgItem[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    if (!msg.cwd) continue;
    counts.set(msg.cwd, (counts.get(msg.cwd) || 0) + 1);
  }
  if (counts.size === 0) return fallback;
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * 获取 Claude Code session 的统计信息
 */
async function getClaudeSessionStats(
  session: ClaudeSessionItem
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
  messages: MsgItem[];
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
    const messages = await listClaudeCodeMessages({
      project: session.project,
      sessionId: session.sessionId,
    });

    stats.total_messages = messages.length;
    const models = new Set<string>();
    const allParts: any[] = [];
    const projectPath = session.projectPath || getProjectPath(session.project);

    const timingLists = createTimingLists();
    let lastUserMsgTime: number | null = null;
    let hasAssistantForUser = false;

    for (const msg of messages) {
      const msgTime = new Date(msg.timestamp).getTime();

      if (msg.type === 'user') {
        stats.total_user_messages++;
        lastUserMsgTime = msgTime;
        hasAssistantForUser = false;
      } else if (msg.type === 'assistant' && lastUserMsgTime && !hasAssistantForUser) {
        const latencyMs = msgTime - lastUserMsgTime;
        pushAssistantTimingSample(timingLists, {
          latencyMs,
          outputTokens: msg.message?.usage?.output_tokens || 0,
          inputTokens: msg.message?.usage?.input_tokens || 0,
        });
        hasAssistantForUser = true;
      }

      // 统计 tokens
      if (msg.message?.usage) {
        const usage = msg.message.usage;
        stats.total_input += usage.input_tokens || 0;
        stats.total_output += usage.output_tokens || 0;
        stats.total_reasoning += 0; // Claude Code 没有单独的 reasoning token
        stats.total_cache_read += usage.cache_read_input_tokens || 0;
        stats.total_cache_write += usage.cache_creation_input_tokens || 0;
        // total_tokens 与 opencode 语义对齐：input + cache_read + output
        stats.total_tokens += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.output_tokens || 0);
      }

      // 统计模型
      if (msg.message?.model) {
        models.add(msg.message.model);
      }

      // 收集 parts
      const parts = convertContentToParts(msg.message.content, msg.type);
      for (const part of parts) {
        part.sessionID = session.sessionId;
        part.messageID = msg.uuid;
        allParts.push(part);

        // 统计工具调用
        if (part.type === 'tool') {
          stats.total_tool_calls++;
          // Claude Code 日志没有明确的失败状态，统一视为成功
          stats.total_tool_calls_success++;
        }
      }
    }

    stats.models_used = Array.from(models).join(',');

    const timingSummary = summarizeTimingLists(timingLists);

    const unifiedMessages = messages.map(msg =>
      convertClaudeMessage(msg, session.sessionId, projectPath)
    );
    stats.editDiffs = calculateEditDiffsFromClaudeMessages(unifiedMessages);
    stats.bashSignals = classifyBashCommands(extractBashCommands(allParts));

    const pricing = calculateSessionPricingFromUnifiedMessages(unifiedMessages);

    // 处理 textParts 和 userParts
    const textParts: any[] = [];
    for (const msg of messages) {
      const parts = convertContentToParts(msg.message.content, msg.type);
      for (const part of parts) {
        if (part.type === 'text') {
          textParts.push({
            role: msg.type,
            text: part.text || '',
            tool: '',
            duration: 0,
            startTime: new Date(msg.timestamp).getTime(),
            endTime: new Date(msg.timestamp).getTime(),
          });
        }
      }
    }

    let userParts = sanitizeUserTextParts(textParts.filter(part => part.role === 'user'));
    userParts = userParts.filter((r, i) => {
      const { text = '' } = r;
      if (text === '[Request interrupted by user]') return false;
      if (text.startsWith('<task-notification>')) return false;
      const prevText = i > 0 ? userParts[i - 1].text : '';
      return prevText !== r.text;
    });

    // 获取最后一条消息
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    let last_message_tokens: number | undefined;
    let last_message: any | undefined;
    if (lastMsg) {
      try {
        const converted = convertClaudeMessage(lastMsg, session.sessionId, projectPath);
        last_message = converted.info;
        last_message_tokens = converted.info.tokens?.total;
      } catch (e) {
        // 忽略
      }
    }

    return {
      stats: {
        ...stats,
        total_user_messages: userParts.length,
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
    // console.warn(`[ai-coding-stats] 获取 Claude session 统计失败: ${session.sessionId}`, e);
    return { stats, messages: [], unifiedMessages: [], pricing: { usd: 0, cny: 0 } };
  }
}

/**
 * 将 Claude Code Session 转换为统一格式
 */
export async function convertClaudeSession(
  session: ClaudeSessionItem
): Promise<UnifiedSessionInfo> {
  // 从 project 字段提取项目路径 (可能是编码后的)
  const projectPath = session.projectPath || session.project;

  // 获取统计信息（同时复用已解析的消息，避免再次读取文件）
  const { stats, messages, unifiedMessages, pricing } = await getClaudeSessionStats(session);
  const session_status = checkSessionStatus(unifiedMessages);
  const projectWorktree = extractProjectWorktree(messages, session.project);
  const activity = buildActivitySpanFromUnifiedMessages(
    unifiedMessages,
    session.timestamp,
    session.timestamp,
  );

  return {
    id: session.sessionId,
    project_id: session.project,
    parent_id: undefined,
    slug: session.sessionId,
    directory: projectPath,
    title: session.display,
    version: 'unknown',
    share_url: undefined,
    summary_additions: stats.editDiffs.additions,
    summary_deletions: stats.editDiffs.deletions,
    summary_files: stats.editDiffs.filesChanged,
    summary_diffs: undefined,
    revert: undefined,
    permission: undefined,
    time_created: new Date(activity.first_active_at_iso).getTime(),
    time_updated: new Date(activity.last_active_at_iso).getTime(),
    time_compacting: undefined,
    time_archived: undefined,
    workspace_id: undefined,
    project_name: undefined,
    project_worktree: projectWorktree,

    // 统计字段
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
    max_context_tokens: stats.max_context_tokens || undefined,
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

    source: 'claude',
  };
}

/**
 * 将 Claude Code 的 usage 转换为 OpenCode 的 tokens 格式
 */
function convertUsageToTokens(usage: any): any {
  if (!usage) return undefined;

  const tokens: any = {
    total: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
  };

  // 处理缓存 token
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;

  if (cacheRead > 0 || cacheWrite > 0) {
    tokens.cache = {
      read: cacheRead,
      write: cacheWrite,
    };
  }

  return tokens;
}

/**
 * 将 Claude Code Message 的 content 转换为 OpenCode 的 parts 格式
 */
function convertContentToParts(content: any, messageRole: string): any[] {
  if (typeof content === 'string') {
    // 纯文本内容
    return [{
      type: 'text',
      // 稳定 id：轮询重拉保持一致
      id: 'p0',
      sessionID: '', // 需要在外部设置
      messageID: '', // 需要在外部设置
      text: content,
    }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const parts: any[] = [];

  // 直接处理所有 content 项，不尝试跨消息配对（part id 用下标 / 原生 id 稳定化）
  content.forEach((item, i) => {
    if (item.type === 'text') {
      parts.push({
        type: 'text',
        id: `p${i}`,
        sessionID: '',
        messageID: '',
        text: item.text,
      });
    } else if (item.type === 'tool_use') {
      parts.push({
        id: item.id || `p${i}`, // 原生 tool_use id 稳定；兜底用下标
        toolUseId: item.id, // 保存原始 tool_use id 用于配对
        sessionID: '',
        messageID: '',
        type: 'tool',
        tool: item.name,
        time: {
          start: Date.now(),
          end: Date.now(),
        },
        state: {
          status: 'completed',
          input: item.input,
        },
      });
    } else if (item.type === 'tool' && item.tool === 'tool_result') {
      // 尝试找到对应的 tool_use part
      const matchedPart = parts.find(p => p.type === 'tool' && p.toolUseId === item.tool_use_id);
      // if (matchedPart) {
        // 找到配对，设置 output
        matchedPart.state.output = item.content;
      // } else {
        // 找不到配对，还是作为独立 part 处理
        parts.push({
          type: 'tool',
          id: `tool_result-${item.tool_use_id || i}`,
          sessionID: '',
          messageID: '',
          tool: 'tool_result',
          time: {
            start: Date.now(),
            end: Date.now(),
          },
          state: {
            status: 'completed',
            output: item.content,
          },
        });
      // }
    } else if (item.type === 'thinking') {
      parts.push({
        type: 'text',
        id: `p${i}`,
        sessionID: '',
        messageID: '',
        text: `<thinking>${item.thinking}</thinking>`,
      });
    }
  });

  // 为所有 parts 设置 sessionID 和 messageID
  for (const part of parts) {
    part.sessionID = ''; // 需要在外部设置
    part.messageID = ''; // 需要在外部设置
  }

  return parts;
}

/**
 * 将 Claude Code Message 转换为统一格式
 */
function convertClaudeMessage(msg: MsgItem, sessionId: string, projectPath: string): UnifiedMessage {
  const timestamp = new Date(msg.timestamp).getTime();

  const messageInfo: any = {
    id: msg.uuid,
    sessionID: sessionId,
    role: msg.type,
    time: {
      created: timestamp,
    },
    parentID: msg.parentUuid || undefined,
    path: {
      cwd: msg.cwd,
      root: projectPath,
    },
  };

  // 处理 model
  if (msg.message.model) {
    // 尝试从 model 字符串中提取 providerID 和 modelID
    const modelParts = msg.message.model.split('/');
    if (modelParts.length >= 2) {
      messageInfo.model = {
        providerID: modelParts[0],
        modelID: modelParts.slice(1).join('/'),
      };
    } else {
      messageInfo.model = {
        providerID: 'unknown',
        modelID: msg.message.model,
      };
    }
  }

  // 处理 tokens
  if (msg.message.usage) {
    messageInfo.tokens = convertUsageToTokens(msg.message.usage);
  }

  // 处理 parts
  const parts = convertContentToParts(msg.message.content, msg.type);
  for (const part of parts) {
    part.sessionID = sessionId;
    part.messageID = msg.uuid;
  }
  // if (!parts?.length) {
  //   console.log('parts is empty', msg);
  // }

  return {
    info: messageInfo,
    parts,
  };
}

/**
 * 获取 Claude Code Session 详情
 */
export async function getClaudeSessionDetail(sessionId: string, project: string): Promise<UnifiedSessionDetail | null> {
  const sessions = await listClaudeCodeSessions();
  const session = sessions.find(s => s.sessionId === sessionId);

  if (!session) {
    return null;
  }

  const messages = await listClaudeCodeMessages({ project, sessionId });
  const projectPath = session.projectPath || getProjectPath(project);

  let unifiedMessages: UnifiedMessage[] = messages.map(msg =>
    convertClaudeMessage(msg, sessionId, projectPath)
  );
  const merged: UnifiedMessage[] = [];
  for (const msg of unifiedMessages) {
    const prevMsg = merged[merged.length - 1];
    if (!prevMsg) {
      merged.push(msg);
      continue;
    }
    const isPrevUserRole = prevMsg.info.role === 'user';
    if (isPrevUserRole) {
      merged.push(msg);
      continue;
    }

    const mergeTokens = (tokens: any, prevTokens: any = prevMsg?.info?.tokens): any => {
      return _.mapValues(prevTokens, (value: any, key: string) => {
        if (typeof value === 'number') {
          return (value || 0) + (tokens?.[key] || 0);
        } else {
          return mergeTokens(value, tokens?.[key]);
        }
      });
    };
    const { parts } = msg;
    if (!parts.length) {
      continue;
    }
    if (parts.length === 1 && parts[0]?.type === 'tool') {
      prevMsg.parts.push(parts[0]);
      prevMsg.info.tokens = mergeTokens(msg.info?.tokens || { input: 0, output: 0, total: 0 });
      continue;
    }
    merged.push(msg);
  }
  unifiedMessages = merged;

  const editDiffs = calculateEditDiffsFromClaudeMessages(unifiedMessages);
  const pricing = calculateSessionPricingFromUnifiedMessages(unifiedMessages);
  const info = await convertClaudeSession(session);

  return {
    info: { ...info, pricing },
    messages: unifiedMessages,
    editDiffs,
    pricing,
  };
}

/**
 * 从 Claude Code messages 计算 edit diffs
 */
function calculateEditDiffsFromClaudeMessages(messages: UnifiedMessage[]): {
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
      if (['edit', 'write'].includes(part.tool || '')) {
        let additions = _.get(part, 'state.metadata.filediff.additions', 0);
        let deletions = _.get(part, 'state.metadata.filediff.deletions', 0);
        let filePath = (_.get(part, 'state.metadata.filediff.path', '') as string) ||
                         (_.get(part, 'state.input.path', '') as string) ||
                         (_.get(part, 'state.title', '') as string);
        if (part.tool === 'write') {
          filePath = filePath || _.get(part, 'state.input.filePath', '') as string;
          if (!additions) {
            const { content = '' }: any = asToolPartState(part.state)?.input || {};
            additions = content.split('\n').length;
          }
        }
        totalAdditions += additions;
        totalDeletions += deletions;
        if (filePath) filesChanged.add(filePath);
      }
    }
  }

  return {
    additions: totalAdditions,
    deletions: totalDeletions,
    filesChanged: filesChanged.size,
    files: [...filesChanged],
  };
}
