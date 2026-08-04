/**
 * AI Coding Stats 统一类型定义
 */

import type { OpenCodeMessage } from './opencode';
import type { SessionPricing } from '../pricing';
import type { BashSignals, DeliverableSignals } from '../core';

/**
 * 统一的 Session 信息 (基于 OpenCode 协议，添加 source 字段)
 */
export interface UnifiedSessionInfo {
  id: string;
  project_id: string;
  parent_id?: string | null;
  /**
   * subagent 并发轮次分组键：
   * - OpenCode: 父 session 中 task 工具所在 message_id（同 message 多 task = 一轮并发）
   * - Kimi: Agent/AgentSwarm 的 toolCallId（同 id 多 agent = 一轮并发）
   */
  spawn_group_id?: string;
  slug: string;
  directory: string;
  title: string;
  version: string;
  share_url?: string | null;
  summary_additions?: number | null;
  summary_deletions?: number | null;
  summary_files?: number | null;
  summary_diffs?: string | null;
  revert?: string | null;
  permission?: string | null;
  time_created: number;
  time_updated: number;
  time_compacting?: number | null;
  time_archived?: number | null;
  workspace_id?: string | null;
  project_name?: string | null;
  project_worktree?: string | null;

  // 来自 SessionListItem 的统计字段
  total_messages?: number;
  total_user_messages?: number;
  total_tool_calls?: number;
  total_tool_calls_success?: number;
  total_tool_calls_failed?: number;
  total_tokens?: number;
  total_input?: number;
  total_output?: number;
  total_reasoning?: number;
  total_cache_read?: number;
  total_cache_write?: number;
  last_active_at?: string;
  /** 最后活跃时间 ISO 8601，供前端 dayjs 解析 */
  last_active_at_iso?: string;
  models_used?: string;
  session_status?: 'in-progress' | 'done' | 'error' | 'aborted' | 'unknown';
  last_message_tokens?: number;
  /** session 内最大 context window（input+cacheRead；compact 前峰值） */
  max_context_tokens?: number;
  /** 本 session compact 次数（assistant 摘要 / Kimi [Context Compacted]） */
  compact_count?: number;
  last_message?: any;
  lastTokenInfo?: { input: number; cacheRead: number; output: number; reasoning: number; total: number };
  textParts?: any[];
  userParts?: any[];
  avg_tps?: number;
  avg_latency_ms?: number;
  avg_prefill_tps?: number;
  assistant_tps_list?: number[];
  latency_list?: number[];
  prefill_tps_list?: number[];
  editDiffs?: { additions: number; deletions: number; filesChanged: number; files?: string[] };
  /** Bash/Shell 工具调用嗅探信号（纯代码执行，非 LLM） */
  bashSignals?: BashSignals;
  /** issue/comment/doc/analysis/decision 等交付物嗅探信号（纯代码执行，非 LLM） */
  deliverableSignals?: DeliverableSignals;
  avg_msgs_per_user_msg?: number;

  /** 根据实际模型价格计算出的会话成本（USD/CNY） */
  pricing?: SessionPricing;

  /**
   * token/cost 数据来源：
   * - real: 日志含真实 usage（如 grok turn_completed.usage）
   * - estimate: 估算（如 grok context 快照拆分）
   * - 缺省: 其它 source 视为 real
   */
  usage_source?: 'real' | 'estimate';

  /** cancel/timeout/error 导致 usage 可能截断 */
  usage_is_incomplete?: boolean;
  /** cost 未上报或部分上报（估算 / 缺 ticks） */
  cost_is_partial?: boolean;
  /** 缺 cost 的 model call 数（有则暴露） */
  cost_missing_calls?: number;

  /** 首次活动时间 ISO（message 最早时间） */
  first_active_at_iso?: string;
  /** 跨自然日数（含首尾），>=2 表示跨天 */
  span_days?: number;
  /** 按 message 时间切日的 token/成本（日统计用） */
  usage_by_day?: Array<{
    date: string;
    tokens: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    usd: number;
    cny: number;
    byModel?: Array<{
      modelKey: string;
      tokens: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      usd: number;
      cny: number;
    }>;
  }>;

  /**
   * 分模型用量明细（缓存列 / 无 pricing 路径）
   * API 层用此字段现算 AUTO pricing
   */
  usage_by_model?: Array<{
    provider?: string;
    model?: string;
    modelKey?: string;
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    tokens?: number;
  }>;

  source: 'claude' | 'opencode' | 'kimi' | 'grok' | 'codex' | 'zcode' | 'workbuddy' | 'cursor'; // 数据来源标识
}

/**
 * 统一的 Message 信息 (基于 OpenCode 协议)
 */
export type UnifiedMessage = OpenCodeMessage;

/**
 * 统一的 Session 详情
 */
export interface UnifiedSessionDetail {
  info: UnifiedSessionInfo;
  messages: UnifiedMessage[];
  editDiffs: {
    additions: number;
    deletions: number;
    filesChanged: number;
    files?: string[];
  };
  /** 按消息实际模型汇总的成本，与列表项 pricing 语义一致 */
  pricing?: SessionPricing;
  /**
   * 预计算 trend（如 Grok 从 updates turn 序列，含 compact 前）。
   * 有则详情页优先于 getOverallStats(messages) 的 prompt 桶趋势。
   */
  trends?: import('ai-coding-sessions/core').TokenTrendPoint[];
}

// ==================== 接口参数定义 ====================

export interface ListSessionsOptions {
  source?: 'claude' | 'opencode' | 'kimi' | 'grok' | 'codex' | 'zcode' | 'workbuddy' | 'cursor' | 'all'; // 默认 'all'
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  projectId?: string; // 按项目过滤
  models?: string[]; // 按使用的模型过滤
}

export interface ListSessionsResult {
  sessions: UnifiedSessionInfo[];
  total: number;
  bySource: {
    claude: number;
    opencode: number;
    kimi: number;
    grok: number;
    codex: number;
    zcode: number;
    workbuddy: number;
    cursor: number;
  };
  lastUpdatedAt?: Date;
}

export interface GetSessionDetailOptions {
  sessionId: string;
  source: 'claude' | 'opencode' | 'kimi' | 'grok' | 'codex' | 'zcode' | 'workbuddy' | 'cursor';
}
