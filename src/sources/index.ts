/**
 * AI Coding Stats 统一服务（listSessions / getSessionDetail / init）
 * 多数据源对齐 OpenCode 协议；详情含按实际模型的 pricing
 * 架构说明: docs/ai-coding-architecture.md
 */

import dayjs from 'dayjs';
import { listClaudeCodeSessions } from './claude-code';
import {
  listKimiCodeSessions,
  listKimiSubagentsFromMainWire,
} from './kimi-code';
import { listGrokCodeSessions } from './grok-code';
import { listCodexSessions, closeCodexDb } from './codex-code';
import { listZcodeSessions, closeZcodeDb, initZcodeDb } from './zcode-code';
import { listWorkbuddySessions, closeWorkbuddyDb, initWorkbuddyDb } from './workbuddy-code';
import { listCursorSessions, closeCursorDb, initCursorDb } from './cursor-code';
import {
  initOpencodeDb,
  closeOpencodeDb,
  getSessionList as getOpencodeSessionList,
  getSessionDetail as getOpencodeSessionDetail,
  checkSessionStatus,
  OpenCodeSessionInfoSchema,
  OpenCodeMessageSchema,
  OpenCodeSessionExportSchema,
} from './opencode';
import { ensureModelsDevData, calculateSessionPricingFromUnifiedMessages } from '../pricing';
import { withConcurrencyLimit } from './utils';
import { filterActivityOverlap, filterTimestampInRange, getSessionActivityBounds } from '../lib/date-utils';
import { convertClaudeSession, getClaudeSessionDetail } from './claude-source';
import { convertKimiSession, convertKimiSubagentSession, getKimiSessionDetail } from './kimi-source';
import { convertGrokSession, getGrokSessionDetail } from './grok-source';
import { convertCodexSession, getCodexSessionDetail } from './codex-source';
import { convertZcodeSession, getZcodeSessionDetail } from './zcode-source';
import { convertWorkbuddySession, getWorkbuddySessionDetail } from './workbuddy-source';
import { convertCursorSession, getCursorSessionDetail } from './cursor-source';
import type {
  UnifiedSessionInfo,
  UnifiedSessionDetail,
  ListSessionsOptions,
  ListSessionsResult,
  GetSessionDetailOptions,
} from './types';

// ==================== 统一接口实现 ====================

let initialized = false;

/**
 * 初始化服务
 */
export async function initAiCodingStats(): Promise<void> {
  if (initialized) return;

  // 初始化 OpenCode 数据库
  try {
    await initOpencodeDb();
  } catch (e) {
    console.warn('[ai-coding-stats] OpenCode 数据库初始化失败:', e);
    // 不抛出错误，因为可能只需要使用 Claude Code 数据源
  }

  try {
    await initZcodeDb();
  } catch (e) {
    console.warn('[ai-coding-stats] ZCode 数据库初始化失败:', e);
  }

  try {
    await initWorkbuddyDb();
  } catch (e) {
    console.warn('[ai-coding-stats] WorkBuddy 数据库初始化失败:', e);
  }

  try {
    await initCursorDb();
  } catch (e) {
    console.warn('[ai-coding-stats] Cursor state.vscdb 初始化失败:', e);
  }

  // 预加载 models.dev 价格数据（失败不影响主流程）
  try {
    await ensureModelsDevData();
  } catch (e) {
    console.warn('[ai-coding-stats] 价格数据初始化失败:', e);
  }

  initialized = true;
}

/**
 * 清理资源
 */
export function closeAiCodingStats(): void {
  closeOpencodeDb();
  closeCodexDb();
  closeZcodeDb();
  closeWorkbuddyDb();
  closeCursorDb();
  initialized = false;
}

/**
 * 列出 Sessions
 */
export async function listSessions(
  options?: ListSessionsOptions
): Promise<ListSessionsResult> {
  const {
    source = 'all',
    startDate,
    endDate,
    projectId,
    models,
  } = options || {};

  const sessions: UnifiedSessionInfo[] = [];
  let claudeCount = 0;
  let opencodeCount = 0;
  let kimiCount = 0;
  let grokCount = 0;
  let codexCount = 0;
  let zcodeCount = 0;
  let workbuddyCount = 0;
  let cursorCount = 0;

  const dateRange = { startDate, endDate };
  /** 预筛：last_active >= start（放宽，精确重叠在 convert 后） */
  const prefilterByLastActive = (timestamp: number) => {
    if (!startDate) return true;
    return filterTimestampInRange(timestamp, { startDate, endDate: undefined });
  };
  /** convert 后精确过滤：用 message 级 first/last_active，勿用可能被刷新的 time_updated */
  const filterBySessionOverlap = (s: {
    first_active_at_iso?: string;
    last_active_at_iso?: string;
    time_created?: number;
    time_updated?: number;
  }) => {
    const { firstMs, lastMs } = getSessionActivityBounds(s);
    return filterActivityOverlap(firstMs, lastMs, dateRange);
  };

  // 处理项目过滤
  const filterByProject = (projectId: string | undefined): (s: UnifiedSessionInfo) => boolean => {
    if (!projectId) return () => true;
    return (s) => s.project_id === projectId;
  };

  // 处理模型过滤
  const targetModelSet = models && models.length > 0 ? new Set(models) : null;
  const filterByModels = (s: { models_used?: string }): boolean => {
    if (!targetModelSet) return true;
    const used = (s.models_used || '').split(',').map(m => m.trim()).filter(Boolean);
    return used.some(id => targetModelSet.has(id));
  };

  // 各数据源并行抓取，单个源失败不影响其它源
  const tasks: Promise<void>[] = [];

  if (source === 'claude' || source === 'all') {
    tasks.push((async () => {
      const claudeSessions = await listClaudeCodeSessions();
      const filteredClaudeSessions = claudeSessions.filter(s => prefilterByLastActive(s.timestamp));

      // 限制并发，避免同时加载大量 session 消息导致内存尖峰
      const filteredClaude = (await withConcurrencyLimit(
        filteredClaudeSessions,
        convertClaudeSession,
        3,
      )).filter(filterByModels).filter(filterBySessionOverlap);

      sessions.push(...filteredClaude);
      claudeCount = filteredClaude.length;
    })().catch(e => {
      console.warn('[ai-coding-stats] Claude Code sessions 获取失败:', e);
    }));
  }

  if (source === 'opencode' || source === 'all') {
    tasks.push((async () => {
      const { list: opencodeSessions } = getOpencodeSessionList(startDate, endDate, true);
      const filteredOpencode = opencodeSessions
        .filter(s => filterByProject(projectId)(s as any))
        .filter(filterByModels)
        .map((s: any): UnifiedSessionInfo => {
          const lastMs = s.session_time_updated
            ?? (s.last_active_at_iso ? new Date(s.last_active_at_iso).getTime() : 0);
          const firstMs = s.session_time_created
            ?? (s.first_active_at_iso ? new Date(s.first_active_at_iso).getTime() : lastMs);
          return {
          id: s.session_id,
          project_id: s.project_id,
          parent_id: s.parent_id ?? undefined,
          spawn_group_id: s.spawn_group_id ?? undefined,
          slug: s.session_id,
          directory: s.session_dir,
          title: s.session_title,
          version: 'unknown',
          time_created: firstMs,
          time_updated: lastMs,
          project_name: s.project_name,
          project_worktree: s.project_worktree,
          summary_additions: s.editDiffs?.additions,
          summary_deletions: s.editDiffs?.deletions,
          summary_files: s.editDiffs?.filesChanged,

          // 新增的统计字段
          total_messages: s.total_messages,
          total_user_messages: s.total_user_messages,
          total_tool_calls: s.total_tool_calls,
          total_tool_calls_success: s.total_tool_calls_success,
          total_tool_calls_failed: s.total_tool_calls_failed,
          total_tokens: s.total_tokens,
          total_input: s.total_input,
          total_output: s.total_output,
          total_reasoning: s.total_reasoning,
          total_cache_read: s.total_cache_read,
          last_active_at_iso: s.last_active_at_iso,
          last_active_at: s.last_active_at_iso || s.last_active_at,
          first_active_at_iso: s.first_active_at_iso,
          span_days: s.span_days,
          usage_by_day: s.usage_by_day,
          models_used: s.models_used,
          last_message_tokens: s.last_message_tokens,
          max_context_tokens: s.max_context_tokens || undefined,
          compact_count: s.compact_count || undefined,
          time_compacting: s.time_compacting || undefined,
          last_message: s.last_message,
          lastTokenInfo: s.lastTokenInfo,
          textParts: s.textParts,
          userParts: s.userParts,
          avg_tps: s.avg_tps,
          avg_latency_ms: s.avg_latency_ms,
          avg_prefill_tps: s.avg_prefill_tps,
          assistant_tps_list: s.assistant_tps_list,
          latency_list: s.latency_list,
          prefill_tps_list: s.prefill_tps_list,
          editDiffs: s.editDiffs,
          bashSignals: s.bashSignals,
          deliverableSignals: s.deliverableSignals,
          pricing: s.pricing,

          source: 'opencode',
        };
        });

      sessions.push(...filteredOpencode);
      opencodeCount = filteredOpencode.length;
    })().catch(e => {
      console.warn('[ai-coding-stats] OpenCode sessions 获取失败:', e);
    }));
  }

  if (source === 'kimi' || source === 'all') {
    tasks.push((async () => {
      const kimiSessions = await listKimiCodeSessions();
      const filteredKimiSessions = kimiSessions.filter(s => prefilterByLastActive(s.updatedAt));
      // 并发转换 Kimi sessions, 限制并发数避免 IO 尖峰
      const kimiExpanded = await withConcurrencyLimit(
        filteredKimiSessions,
        async (s) => {
          const results: UnifiedSessionInfo[] = [];
          results.push(await convertKimiSession(s));
          const subagents = await listKimiSubagentsFromMainWire(s.sessionDir, s.sessionId);
          for (const meta of subagents) {
            results.push(await convertKimiSubagentSession(s, meta));
          }
          return results;
        },
        3,
      );
      const flatKimiExpanded = kimiExpanded.flat().filter(filterByModels).filter(filterBySessionOverlap);
      sessions.push(...flatKimiExpanded);
      kimiCount = flatKimiExpanded.length;
    })().catch(e => {
      console.warn('[ai-coding-stats] Kimi Code sessions 获取失败:', e);
    }));
  }

  if (source === 'grok' || source === 'all') {
    tasks.push((async () => {
      const grokSessions = await listGrokCodeSessions();
      const filtered = grokSessions.filter(s => prefilterByLastActive(s.updatedAt));
      const converted = (await withConcurrencyLimit(
        filtered,
        convertGrokSession,
        3,
      )).filter(filterByModels).filter(filterBySessionOverlap);
      sessions.push(...converted);
      grokCount = converted.length;
    })().catch(e => {
      console.warn('[ai-coding-stats] Grok sessions 获取失败:', e);
    }));
  }

  if (source === 'codex' || source === 'all') {
    tasks.push((async () => {
      const codexSessions = await listCodexSessions();
      const filtered = codexSessions.filter(s => prefilterByLastActive(s.updatedAt));
      const converted = (await withConcurrencyLimit(
        filtered,
        convertCodexSession,
        3,
      )).filter(filterByModels).filter(filterBySessionOverlap);
      sessions.push(...converted);
      codexCount = converted.length;
    })().catch(e => {
      console.warn('[ai-coding-stats] Codex sessions 获取失败:', e);
    }));
  }

  if (source === 'zcode' || source === 'all') {
    tasks.push((async () => {
      const zcodeSessions = await listZcodeSessions();
      const filtered = zcodeSessions.filter(s => prefilterByLastActive(s.updatedAt));
      const converted = (await withConcurrencyLimit(
        filtered,
        convertZcodeSession,
        3,
      )).filter(filterByModels).filter(filterBySessionOverlap);
      sessions.push(...converted);
      zcodeCount = converted.length;
    })().catch(e => {
      console.warn('[ai-coding-stats] ZCode sessions 获取失败:', e);
    }));
  }

  if (source === 'workbuddy' || source === 'all') {
    tasks.push((async () => {
      const wbSessions = await listWorkbuddySessions();
      const filtered = wbSessions.filter(s => prefilterByLastActive(s.updatedAt));
      const converted = (await withConcurrencyLimit(
        filtered,
        convertWorkbuddySession,
        3,
      )).filter(filterByModels).filter(filterBySessionOverlap);
      sessions.push(...converted);
      workbuddyCount = converted.length;
    })().catch(e => {
      console.warn('[ai-coding-stats] WorkBuddy sessions 获取失败:', e);
    }));
  }

  if (source === 'cursor' || source === 'all') {
    tasks.push((async () => {
      const cursorSessions = await listCursorSessions();
      const filtered = cursorSessions.filter(s => prefilterByLastActive(s.updatedAt));
      const converted = (await withConcurrencyLimit(
        filtered,
        convertCursorSession,
        3,
      )).filter(filterByModels).filter(filterBySessionOverlap);
      sessions.push(...converted);
      cursorCount = converted.length;
    })().catch(e => {
      console.warn('[ai-coding-stats] Cursor sessions 获取失败:', e);
    }));
  }

  await Promise.all(tasks);

  // 按时间排序 (最新的在前)
  sessions.sort((a, b) => b.time_updated - a.time_updated);

  return {
    sessions,
    total: sessions.length,
    bySource: {
      claude: claudeCount,
      opencode: opencodeCount,
      kimi: kimiCount,
      grok: grokCount,
      codex: codexCount,
      zcode: zcodeCount,
      workbuddy: workbuddyCount,
      cursor: cursorCount,
    },
    lastUpdatedAt: new Date(),
  };
}

/**
 * 获取 Session 详情
 */
export async function getSessionDetail(
  options: GetSessionDetailOptions
): Promise<UnifiedSessionDetail | null> {
  const { sessionId, source } = options;

  if (source === 'claude') {
    // 对于 Claude Code，需要先找到对应的 session 以获取 project 信息
    const sessions = await listClaudeCodeSessions();
    const session = sessions.find(s => s.sessionId === sessionId);

    if (!session) {
      return null;
    }

    return getClaudeSessionDetail(sessionId, session.project);
  } else if (source === 'kimi') {
    return getKimiSessionDetail(sessionId, '');
  } else if (source === 'grok') {
    return getGrokSessionDetail(sessionId);
  } else if (source === 'codex') {
    return getCodexSessionDetail(sessionId);
  } else if (source === 'zcode') {
    return getZcodeSessionDetail(sessionId);
  } else if (source === 'workbuddy') {
    return getWorkbuddySessionDetail(sessionId);
  } else if (source === 'cursor') {
    return getCursorSessionDetail(sessionId);
  } else {
    // OpenCode 直接透传
    const detail = getOpencodeSessionDetail(sessionId);
    if (!detail) {
      console.warn(`[ai-coding-stats] OpenCode session not found: ${sessionId}`);
      return null;
    }

    const pricing = calculateSessionPricingFromUnifiedMessages(detail.messages);
    return {
      ...detail,
      info: {
        ...detail.info,
        source: 'opencode',
        pricing,
      },
      pricing,
    };
  }
}

// ==================== 导出 Schema ====================

export {
  OpenCodeSessionInfoSchema,
  OpenCodeMessageSchema,
  OpenCodeSessionExportSchema,
};

// Re-export types
export type {
  UnifiedSessionInfo,
  UnifiedSessionDetail,
  ListSessionsOptions,
  ListSessionsResult,
  GetSessionDetailOptions,
} from './types';
