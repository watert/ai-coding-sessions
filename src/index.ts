/**
 * Node 主入口：sources list/detail + store 缓存 + pricing hooks
 * 同构层请用 `ai-coding-sessions/core`
 */

export * from './pricing';

export * from './lib/sqlite';
export * from './lib/jsonl-cache';
export * from './lib/date-utils';
export * from './lib/timing-stats';

export * from './sources/types';
export * from './sources/utils';
export * from './sources/usage-by-day';
export * from './sources/bash-signals';
export * from './sources/deliverable-signals';
export * from './sources/tool-error-soft';

export * from './sources/claude-code';
export * from './sources/claude-main-chain';
export * from './sources/codex-code';
export * from './sources/grok-code';
export * from './sources/kimi-code';
export * from './sources/zcode-code';
export * from './sources/workbuddy-code';
export * from './sources/cursor-code';
export * from './sources/opencode';

export * from './sources/claude-source';
export * from './sources/codex-source';
export * from './sources/grok-source';
export * from './sources/kimi-source';
export * from './sources/zcode-source';
export * from './sources/workbuddy-source';
export * from './sources/cursor-source';

export {
  initAiCodingStats,
  closeAiCodingStats,
  listSessions,
  getSessionDetail as getSessionDetailLive,
  OpenCodeSessionInfoSchema,
  OpenCodeMessageSchema,
  OpenCodeSessionExportSchema,
} from './sources/index';

import {
  getSessionDetail as getSessionDetailLiveFn,
} from './sources/index';
import type { GetSessionDetailOptions, UnifiedSessionDetail } from './sources/types';
import { overlaySessionDetail } from './store/session-title';
import { initStoreDb, isStoreDbReady } from './store/db';

/** live detail + 缓存 custom_title overlay（显式 init，避免误开默认库） */
export async function getSessionDetail(
  options: GetSessionDetailOptions,
): Promise<UnifiedSessionDetail | null> {
  const detail = await getSessionDetailLiveFn(options);
  if (!detail) return null;
  if (!isStoreDbReady()) {
    try {
      await initStoreDb();
    } catch {
      return detail;
    }
  }
  return overlaySessionDetail(detail);
}

// M3 store：sync / queryCached / meta / listRefs
export {
  SCHEMA_VERSION,
  ALL_SOURCES,
  isSourceId,
  resolveStorePaths,
  initStoreDb,
  closeStoreDb,
  getStoreDb,
  getStorePaths,
  loadMeta,
  saveMeta,
  emptyMeta,
  listRefs,
  syncSessions,
  reconcileSessions,
  ensureFresh,
  queryCached,
  getCachedSession,
  getSessionPrompts,
  queryUsageByDay,
  upsertSession,
  markOrphans,
  countStats,
  contentFingerprint,
  extractUsageByModel,
  extractPrompts,
  stripPricingForPayload,
  buildTraceSteps,
  shapeDetailMessages,
  summarizeTraceTools,
  summarizeTraceTurns,
  collectToolErrors,
  formatTraceMarkdown,
  formatTraceJsonl,
  inferTraceFormat,
  extractStepTiming,
  summarizeSessionTimingFromMessages,
  computeCliStats,
  clipSessionToDateRange,
  clipSessionsToDateRange,
  isRootSession,
  toDayKey,
  // P0 handoff / resolve
  buildHandoff,
  formatHandoffMarkdown,
  resolveSessionRef,
  filterSessionsByCwd,
  matchesCwd,
  normalizeCwd,
  sessionIdFromPath,
  sessionPathCandidates,
  isWeakTitle,
  normalizeCustomTitle,
  overlaySessionFields,
  getCustomTitle,
  applyCustomTitle,
  applyCustomTitles,
  overlaySessionDetail,
  setSessionTitle,
  isStoreDbReady,
} from './store';

export type {
  SourceId,
  UsageByModelEntry,
  SessionPromptRow,
  CachedSessionRow,
  StorePaths,
  StoreMeta,
  SourceSyncMeta,
  SessionRef,
  ListRefsOptions,
  SyncOptions,
  SyncResult,
  SyncSourceResult,
  QueryCachedOptions,
  TitleReviewEntry,
  TitleReviewOptions,
  TraceBuildOptions,
  TraceStep,
  TraceTurn,
  TraceToolRow,
  ToolErrorRow,
  StepTiming,
  DetailShapeOptions,
  CollectToolErrorsOptions,
  TraceExportMeta,
  TraceExportFormat,
  CliStatsResult,
  StatsTokenBucket,
  StatsQuality,
  ModelStatRow,
  ToolFailSnapshot,
  ToolFailTopSession,
  ComputeCliStatsOptions,
  SessionHandoff,
  HandoffWarning,
  BuildHandoffOptions,
  ResolveResult,
  ResolveMatchKind,
  SetSessionTitleResult,
} from './store';
