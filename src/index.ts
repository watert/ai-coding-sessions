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
export * from './sources/opencode';

export * from './sources/claude-source';
export * from './sources/codex-source';
export * from './sources/grok-source';
export * from './sources/kimi-source';
export * from './sources/zcode-source';
export * from './sources/workbuddy-source';

export {
  initAiCodingStats,
  closeAiCodingStats,
  listSessions,
  getSessionDetail,
  OpenCodeSessionInfoSchema,
  OpenCodeMessageSchema,
  OpenCodeSessionExportSchema,
} from './sources/index';

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
} from './store';
