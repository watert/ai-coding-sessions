/**
 * Session 消息协议、getOverallStats / Token 趋势（前后端共用）
 * 架构说明: docs/ai-coding-architecture.md（仓库根目录）
 */
import _ from "lodash";
import {
  AI_MODEL_PRICING_TABLE, USD_TO_CNY_RATE,
  calculateCost, tierLabel,
  type ModelPricing,
} from './model-pricing';

export {
  AI_MODEL_PRICING_TABLE, DEFAULT_AI_MODEL_PRICING_ID, USD_TO_CNY_RATE,
  calculateCost, calculateCostForMessage, findPriceTier,
  type CostResult, type ModelPriceTier, type ModelPricing,
} from './model-pricing';

export { stripOpencodeUserPromptInjection } from './opencode-user-prompt';

export interface OpenCodeSessionInfo {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  title: string;
  version: string;
  summary: { additions: number; deletions: number; files: number; };
  time_created?: number;
  time_updated?: number;
  project_name?: string;
  project_worktree?: string;
}

export interface OpenCodeMessageInfo {
  role: "user" | "assistant";
  time: { created: number; completed?: number; };
  summary?: { diffs: unknown[]; };
  error?: string;
  agent?: string;
  model?: { providerID: string; modelID: string; };
  id: string;
  sessionID: string;
  parentID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  path?: { cwd: string; root: string; };
  cost?: number;
  tokens?: {
    total: number; input: number; output: number; reasoning?: number;
    cache?: { read: number; write: number; };
    // 与计费 total 区分：请求上下文窗口。
    // - OpenCode/Kimi: total ≈ input + cacheRead
    // - Grok: total = updates 窗口快照；input/cacheRead 可能是本步计费分项（勿相加当窗口）
    context?: { total: number; input: number; cacheRead: number; };
  };
  finish?: number;
  session_status?: 'in-progress' | 'done' | 'error' | 'aborted' | 'unknown';
  /** thinking effort（Kimi 等）：on / low / high / max */
  thinkingEffort?: string;
}

export interface OpenCodePart {
  type: string;
  id: string;
  sessionID: string;
  messageID: string;
  text?: string;
  snapshot?: string;
  time?: { start?: number; end?: number; };
  callID?: string;
  tool?: string;
  state?: {
    status: string; input?: Record<string, unknown>; output?: unknown; title?: string;
    metadata?: Record<string, unknown>; time?: { start?: number; end?: number; };
  };
  reason?: string;
}

export interface OpenCodeMessage {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

export interface SessionExportPricing {
  usd: number;
  cny: number;
  details?: Array<{
    modelKey: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    usd: number;
    cny: number;
    inputCost?: number;
    outputCost?: number;
    cacheReadCost?: number;
    cacheWriteCost?: number;
  }>;
}

export interface OpenCodeSessionExport {
  info: OpenCodeSessionInfo;
  messages: OpenCodeMessage[];
  editDiffs: { additions: number; deletions: number; filesChanged: number; files?: string[] };
  bashSignals?: BashSignals;
  deliverableSignals?: DeliverableSignals;
  pricing?: SessionExportPricing;
}

/** 交付物嗅探信号（纯规则执行，非 LLM） */
export interface DeliverableSignals {
  issue: number;
  comment: number;
  doc: number;
  analysis: number;
  decision: number;
  config: number;
  categories: Array<'issue' | 'comment' | 'doc' | 'analysis' | 'decision' | 'config'>;
  evidence: { tool: number; file: number; text: number };
  toolCalls: { gh: number; write: number; edit: number };
  /** 任一交付物类别命中，包含纯文本推断。 */
  hasDeliverable: boolean;
  /** 至少有工具调用或文件路径证据。 */
  hasStrongSignal: boolean;
}

/** Bash/Shell 工具调用嗅探信号（纯代码执行，非 LLM） */
export interface BashSignals {
  bashCount: number;
  tests: number;
  build: number;
  git: number;
  pkg: number;
  /** gh issue/pr/release/workflow 等，覆盖 issue/comment/PR 信号 */
  gh: number;
  deploy: number;
  lint: number;
  destructive: number;
  /** 跑解释器/运行器（node/bun/python/deno + npm|yarn|pnpm run），代码执行信号 */
  script: number;
  /** 检索/定位（grep/rg/find/ag 等），信息收集信号 */
  search: number;
  /** 文件系统读写/变换（ls/cat/sed/awk/cp/mv 等），非交付物信号 */
  io: number;
  /** 数据库/数据查询（sqlite3/psql/mongosh/mysql 等），数据探查信号 */
  data: number;
  /** 网络请求（curl/wget 等），外部交互信号 */
  http: number;
  /** 浏览器自动化（agent-browser/chrome-devtools/playwright 等） */
  browser: number;
  categories: Array<'tests' | 'build' | 'git' | 'pkg' | 'gh' | 'deploy' | 'lint' | 'destructive' | 'script' | 'search' | 'io' | 'data' | 'http' | 'browser'>;
  /** 是否产生运维/交付类动作（git/gh/deploy/pkg/test/build/script），复盘防误判 */
  hasOpsSignal: boolean;
}

export interface CostByTier {
  tierLabel: string; currency: 'USD' | 'CNY'; maxContext?: number;
  messageCount: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; totalCost: number; inputCost: number;
  outputCost: number; cacheReadCost: number; cacheWriteCost: number;
}

export interface ModelUsage {
  modelID: string; providerID: string; messageCount: number;
  totalTokens: number; inputTokens: number; outputTokens: number;
  reasoningTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  msgPercent: number; tokenPercent: number; totalSteps: number;
  avgStepsPerMsg: number; stepPercent: number; avgMsgsPerUserMsg: number;
  toolCount: number; toolPercent: number;
  totalCost: number; inputCost: number; outputCost: number;
  cacheReadCost: number; cacheWriteCost: number;
  costByTier: CostByTier[];
  costEstimates: { modelID: string; totalCost: number; inputCost: number; outputCost: number; cacheReadCost: number; cacheWriteCost: number; }[];
}

export interface ToolUsage { tool: string; count: number; percent: number; }

export interface LastMessageInfo {
  role: "user" | "assistant"; modelID: string;
  totalTokens: number; inputTokens: number; outputTokens: number;
  reasoningTokens?: number; cacheReadTokens: number; cacheWriteTokens: number;
}

/** 趋势点成本拆分（USD，与 calculateCost / session.pricing.details 一致） */
export interface TokenTrendCostBreakdown {
  input: number;
  output: number;
  /** 计费口径不单独收 reasoning；保留字段供展示兼容，恒为 0 */
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface TokenTrendPoint {
  userMsgId: string; startTime: number; endTime: number;
  startTokens: { total: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; };
  endTokens: { total: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; };
  delta: { total: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; };
  msgCount: number; // 该轮 user message 对应的 assistant message 数量
  /** 该轮末请求上下文窗口；优先 tokens.context.total（Grok 窗口快照） */
  contextSize: number;
  /** 本轮增量成本（预计算后填充，AUTO 与实际 session.pricing 对齐） */
  deltaCost?: TokenTrendCostBreakdown;
  /** 累计至本轮末的成本 */
  endCost?: TokenTrendCostBreakdown;
}

export interface TokenStats {
  totalTokens: number; inputTokens: number; outputTokens: number;
  reasoningTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  messageCount: number; cacheRate: number;
  msgAvgTotal: number; msgAvgInput: number; msgAvgOutput: number;
  msgAvgReasoning: number; msgAvgCacheRead: number; msgAvgCacheWrite: number;
  models: ModelUsage[]; totalSteps: number; avgStepsPerMsg: number;
  avgMsgsPerUserMsg: number; toolCount: number; tools: ToolUsage[];
  totalCost: number; inputCost: number; outputCost: number;
  cacheReadCost: number; cacheWriteCost: number;
  costByTier: CostByTier[];
  costEstimates: { modelID: string; totalCost: number; inputCost: number; outputCost: number; cacheReadCost: number; cacheWriteCost: number; }[];
  lastMessage?: LastMessageInfo;
  contextMessage?: LastMessageInfo;
  trends?: TokenTrendPoint[];
}

export interface GroupedTokenStats { [sessionId: string]: TokenStats; }

/**
 * 解析单条消息的 context window 规模。
 * 优先 context.total（Grok 等窗口快照）；勿对 Grok 用 input+cacheRead（那是计费分项，可远大于窗口）。
 */
export function resolveMessageContextSize(tokens?: {
  total?: number;
  input?: number;
  cache?: { read?: number };
  context?: { total?: number; input?: number; cacheRead?: number };
} | null): number {
  if (!tokens) return 0;
  if (tokens.context) {
    if (typeof tokens.context.total === 'number' && tokens.context.total > 0) {
      return tokens.context.total;
    }
    return (tokens.context.input || 0) + (tokens.context.cacheRead || 0);
  }
  return (tokens.input || 0) + (tokens.cache?.read || 0);
}

export function groupMessagesByUser(messages: OpenCodeMessage[]): Record<string, { userMsg: OpenCodeMessage; msgs: OpenCodeMessage[] }> {
  const result: Record<string, { userMsg: OpenCodeMessage; msgs: OpenCodeMessage[] }> = {};
  const msgMap = _.keyBy(messages, (m) => m.info?.id);
  const userMsgs = messages.filter((m) => m.info?.role === "user");
  userMsgs.forEach((userMsg) => {
    const uid = userMsg.info?.id;
    if (!uid) return;
    const relatedMsgs: OpenCodeMessage[] = [];
    messages.forEach((msg) => {
      if (msg.info?.role !== "assistant") return;
      const seen = new Set<string>();
      let current: OpenCodeMessage | undefined = msg;
      while (current?.info) {
        const cid = current.info.id;
        if (cid) {
          if (seen.has(cid)) break; // parentID 环 → 否则 while 卡死详情页
          seen.add(cid);
        }
        if (current.info.parentID === uid) {
          relatedMsgs.push(msg);
          break;
        }
        if (!current.info.parentID) break;
        current = msgMap[current.info.parentID];
      }
    });
    result[uid] = { userMsg, msgs: relatedMsgs };
  });
  return result;
}

export function extractTokenStatsFromMessage(msg: OpenCodeMessage): Partial<TokenStats> & { modelKey?: string; tools: string[] } {
  const tokens = msg.info.tokens;
  const modelID = msg.info.modelID || msg.info.model?.modelID || "unknown";
  const providerID = msg.info.providerID || msg.info.model?.providerID || "unknown";
  const tools: string[] = msg.parts.filter((part) => part.tool).map((part) => part.tool!);
  return {
    totalTokens: tokens?.total || 0, inputTokens: tokens?.input || 0,
    outputTokens: tokens?.output || 0, reasoningTokens: tokens?.reasoning || 0,
    cacheReadTokens: tokens?.cache?.read || 0, cacheWriteTokens: tokens?.cache?.write || 0,
    modelKey: `${providerID}/${modelID}`, tools: tools as any,
  };
}

export function mergeTokenStats(stats: (Partial<TokenStats> & { modelKey?: string; tools?: string[] })[]): TokenStats {
  const init = { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const merged = stats.reduce((acc, s) => ({
    totalTokens: acc.totalTokens + (s.totalTokens || 0),
    inputTokens: acc.inputTokens + (s.inputTokens || 0),
    outputTokens: acc.outputTokens + (s.outputTokens || 0) - (s.reasoningTokens || 0),
    reasoningTokens: acc.reasoningTokens + (s.reasoningTokens || 0),
    cacheReadTokens: acc.cacheReadTokens + (s.cacheReadTokens || 0),
    cacheWriteTokens: acc.cacheWriteTokens + (s.cacheWriteTokens || 0),
  }), init);
  const totalTokens = merged.totalTokens;
  const messageCount = stats.length;
  const msgDivisor = messageCount > 0 ? messageCount : 1;
  const allTools: string[] = stats.flatMap((s) => s.tools || []);
  const toolCount = allTools.length;
  const toolGroups = _.groupBy(allTools, (tool) => tool);
  const toolUsages: ToolUsage[] = _.map(toolGroups, (group, tool) => ({
    tool, count: group.length, percent: toolCount > 0 ? group.length / toolCount : 0,
  })).sort((a, b) => b.count - a.count);
  const modelGroups = _.groupBy(stats.filter((s) => s.modelKey), (s) => s.modelKey!);
  const modelUsages: ModelUsage[] = _.map(modelGroups, (group, key) => {
    const [providerID, modelID] = key.split("/");
    const mCount = group.length;
    const mTotal = _.sumBy(group, (g) => g.totalTokens || 0);
    const mToolCount = group.flatMap((g) => g.tools || []).length;
    const mInputTokens = _.sumBy(group, (g) => g.inputTokens || 0);
    const mOutputTokens = _.sumBy(group, (g) => g.outputTokens || 0);
    const mCacheReadTokens = _.sumBy(group, (g) => g.cacheReadTokens || 0);
    const mCacheWriteTokens = _.sumBy(group, (g) => g.cacheWriteTokens || 0);
    const costEstimates = AI_MODEL_PRICING_TABLE.map((pricing) => {
      const result = calculateCost(pricing, mInputTokens, mOutputTokens, mCacheReadTokens, mCacheWriteTokens);
      return { modelID: pricing.id, totalCost: result.totalCost, inputCost: result.inputCost, outputCost: result.outputCost, cacheReadCost: result.cacheReadCost, cacheWriteCost: result.cacheWriteCost };
    });
    const defaultPricing = AI_MODEL_PRICING_TABLE[0];
    const defaultResult = calculateCost(defaultPricing, mInputTokens, mOutputTokens, mCacheReadTokens, mCacheWriteTokens);
    return {
      modelID: modelID || "unknown", providerID: providerID || "unknown", messageCount: mCount, totalTokens: mTotal,
      inputTokens: mInputTokens, outputTokens: mOutputTokens,
      reasoningTokens: _.sumBy(group, (g) => g.reasoningTokens || 0),
      cacheReadTokens: mCacheReadTokens, cacheWriteTokens: mCacheWriteTokens,
      msgPercent: mCount / msgDivisor, tokenPercent: totalTokens > 0 ? mTotal / totalTokens : 0,
      totalSteps: mCount, avgStepsPerMsg: mTotal / (mCount || 1), stepPercent: mCount / msgDivisor,
      avgMsgsPerUserMsg: mCount / (mCount || 1), toolCount: mToolCount,
      toolPercent: toolCount > 0 ? mToolCount / toolCount : 0,
      totalCost: defaultResult.totalCost, inputCost: defaultResult.inputCost, outputCost: defaultResult.outputCost,
      cacheReadCost: defaultResult.cacheReadCost, cacheWriteCost: defaultResult.cacheWriteCost,
      costByTier: [{ tierLabel: tierLabel(defaultResult.tier), currency: defaultResult.tier.currency || 'USD',
        maxContext: defaultResult.tier.maxContext === Infinity ? undefined : defaultResult.tier.maxContext,
        messageCount: mCount, inputTokens: mInputTokens, outputTokens: mOutputTokens, cacheReadTokens: mCacheReadTokens,
        totalCost: defaultResult.totalCost, inputCost: defaultResult.inputCost, outputCost: defaultResult.outputCost,
        cacheReadCost: defaultResult.cacheReadCost, cacheWriteCost: defaultResult.cacheWriteCost }],
      costEstimates,
    };
  }).sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    totalTokens, inputTokens: merged.inputTokens, outputTokens: merged.outputTokens,
    reasoningTokens: merged.reasoningTokens, cacheReadTokens: merged.cacheReadTokens, cacheWriteTokens: merged.cacheWriteTokens,
    messageCount, cacheRate: totalTokens > 0 ? merged.cacheReadTokens / totalTokens : 0,
    msgAvgTotal: totalTokens / msgDivisor, msgAvgInput: merged.inputTokens / msgDivisor, msgAvgOutput: merged.outputTokens / msgDivisor,
    msgAvgReasoning: merged.reasoningTokens / msgDivisor, msgAvgCacheRead: merged.cacheReadTokens / msgDivisor, msgAvgCacheWrite: merged.cacheWriteTokens / msgDivisor,
    models: modelUsages, totalSteps: messageCount, avgStepsPerMsg: totalTokens / msgDivisor, avgMsgsPerUserMsg: 0,
    toolCount, tools: toolUsages,
    totalCost: _.sumBy(modelUsages, (m) => m.totalCost), inputCost: _.sumBy(modelUsages, (m) => m.inputCost),
    outputCost: _.sumBy(modelUsages, (m) => m.outputCost), cacheReadCost: _.sumBy(modelUsages, (m) => m.cacheReadCost),
    cacheWriteCost: _.sumBy(modelUsages, (m) => m.cacheWriteCost),
    costEstimates: AI_MODEL_PRICING_TABLE.map((pricing) => {
      const result = calculateCost(pricing, merged.inputTokens, merged.outputTokens, merged.cacheReadTokens, merged.cacheWriteTokens);
      return { modelID: pricing.id, totalCost: result.totalCost, inputCost: result.inputCost, outputCost: result.outputCost, cacheReadCost: result.cacheReadCost, cacheWriteCost: result.cacheWriteCost };
    }),
    costByTier: [],
  };
}

export function analyzeMessagesBySession(messages: OpenCodeMessage[]): GroupedTokenStats {
  const grouped = _.groupBy(messages, (m) => m.info.sessionID);
  return _.mapValues(grouped, (msgs) => {
    const stats = msgs.map((m) => extractTokenStatsFromMessage(m));
    return mergeTokenStats(stats);
  });
}

/**
 * 用 session 总账（pricing.details / total_*）校正 getOverallStats。
 * 场景：grok 等 message 级 token 低估（缺 turn cache），但 session.pricing 有真实分项。
 * 保留 trends / messageCount / tools；覆盖 token 合计与 cost 拆分供 Cost Distribution。
 */
export function reconcileTokenStatsWithSessionPricing(
  stats: TokenStats,
  sessionPricing?: SessionExportPricing | null,
  sessionTotals?: {
    total_tokens?: number;
    total_input?: number;
    total_output?: number;
    total_cache_read?: number;
    total_cache_write?: number;
    total_reasoning?: number;
  } | null,
): TokenStats {
  const details = sessionPricing?.details;
  const hasDetails = !!(details && details.length > 0);
  const hasTotals = !!(sessionTotals && (
    (sessionTotals.total_tokens || 0) > 0
    || (sessionTotals.total_input || 0) + (sessionTotals.total_output || 0) + (sessionTotals.total_cache_read || 0) > 0
  ));
  if (!hasDetails && !hasTotals) return stats;

  let inputTokens = stats.inputTokens;
  let outputTokens = stats.outputTokens;
  let cacheReadTokens = stats.cacheReadTokens;
  let cacheWriteTokens = stats.cacheWriteTokens;
  let reasoningTokens = stats.reasoningTokens;
  let totalTokens = stats.totalTokens;
  let inputCost = stats.inputCost;
  let outputCost = stats.outputCost;
  let cacheReadCost = stats.cacheReadCost;
  let cacheWriteCost = stats.cacheWriteCost;
  let totalCost = stats.totalCost;
  let models = stats.models;

  if (hasDetails) {
    inputTokens = details!.reduce((s, d) => s + (d.input || 0), 0);
    outputTokens = details!.reduce((s, d) => s + (d.output || 0), 0);
    cacheReadTokens = details!.reduce((s, d) => s + (d.cacheRead || 0), 0);
    cacheWriteTokens = details!.reduce((s, d) => s + (d.cacheWrite || 0), 0);
    totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

    const hasBreakdown = details!.some(
      d => d.inputCost != null || d.outputCost != null || d.cacheReadCost != null || d.cacheWriteCost != null,
    );
    if (hasBreakdown) {
      inputCost = details!.reduce((s, d) => s + (d.inputCost || 0), 0);
      outputCost = details!.reduce((s, d) => s + (d.outputCost || 0), 0);
      cacheReadCost = details!.reduce((s, d) => s + (d.cacheReadCost || 0), 0);
      cacheWriteCost = details!.reduce((s, d) => s + (d.cacheWriteCost || 0), 0);
      totalCost = sessionPricing!.usd ?? (inputCost + outputCost + cacheReadCost + cacheWriteCost);
    } else if (sessionPricing) {
      totalCost = sessionPricing.usd;
      const denom = totalTokens || 1;
      inputCost = totalCost * (inputTokens / denom);
      outputCost = totalCost * (outputTokens / denom);
      cacheReadCost = totalCost * (cacheReadTokens / denom);
      cacheWriteCost = totalCost * (cacheWriteTokens / denom);
    }

    models = details!.map((d) => {
      const parts = d.modelKey.split('/');
      const providerID = parts.length > 1 ? parts[0] : 'unknown';
      const modelID = parts.length > 1 ? parts.slice(1).join('/') : d.modelKey;
      const mTok = d.input + d.output + d.cacheRead + d.cacheWrite;
      const prev = stats.models.find(
        m => m.modelID === modelID
          || m.modelID.toLowerCase() === modelID.toLowerCase()
          || `${m.providerID}/${m.modelID}`.toLowerCase() === d.modelKey.toLowerCase(),
      );
      const mInputCost = d.inputCost ?? (mTok > 0 ? d.usd * (d.input / mTok) : 0);
      const mOutputCost = d.outputCost ?? (mTok > 0 ? d.usd * (d.output / mTok) : 0);
      const mCacheReadCost = d.cacheReadCost ?? (mTok > 0 ? d.usd * (d.cacheRead / mTok) : 0);
      const mCacheWriteCost = d.cacheWriteCost ?? (mTok > 0 ? d.usd * (d.cacheWrite / mTok) : 0);
      return {
        modelID,
        providerID,
        messageCount: prev?.messageCount ?? 0,
        totalTokens: mTok,
        inputTokens: d.input,
        outputTokens: d.output,
        reasoningTokens: prev?.reasoningTokens ?? 0,
        cacheReadTokens: d.cacheRead,
        cacheWriteTokens: d.cacheWrite,
        msgPercent: prev?.msgPercent ?? 0,
        tokenPercent: totalTokens > 0 ? (mTok / totalTokens) * 100 : 0,
        totalSteps: prev?.totalSteps ?? 0,
        avgStepsPerMsg: prev?.avgStepsPerMsg ?? 0,
        stepPercent: prev?.stepPercent ?? 0,
        avgMsgsPerUserMsg: prev?.avgMsgsPerUserMsg ?? 0,
        toolCount: prev?.toolCount ?? 0,
        toolPercent: prev?.toolPercent ?? 0,
        totalCost: d.usd,
        inputCost: mInputCost,
        outputCost: mOutputCost,
        cacheReadCost: mCacheReadCost,
        cacheWriteCost: mCacheWriteCost,
        costByTier: prev?.costByTier ?? [],
        costEstimates: prev?.costEstimates ?? stats.costEstimates,
      } satisfies ModelUsage;
    });
  } else if (hasTotals) {
    inputTokens = sessionTotals!.total_input ?? inputTokens;
    outputTokens = sessionTotals!.total_output ?? outputTokens;
    cacheReadTokens = sessionTotals!.total_cache_read ?? cacheReadTokens;
    cacheWriteTokens = sessionTotals!.total_cache_write ?? cacheWriteTokens;
    reasoningTokens = sessionTotals!.total_reasoning ?? reasoningTokens;
    totalTokens = sessionTotals!.total_tokens
      ?? (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens);
    if (sessionPricing) {
      totalCost = sessionPricing.usd;
      const denom = totalTokens || 1;
      inputCost = totalCost * (inputTokens / denom);
      outputCost = totalCost * (outputTokens / denom);
      cacheReadCost = totalCost * (cacheReadTokens / denom);
      cacheWriteCost = totalCost * (cacheWriteTokens / denom);
    }
  }

  const msgDivisor = Math.max(1, stats.messageCount);
  return {
    ...stats,
    totalTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheRate: totalTokens > 0 ? cacheReadTokens / totalTokens : 0,
    msgAvgTotal: totalTokens / msgDivisor,
    msgAvgInput: inputTokens / msgDivisor,
    msgAvgOutput: outputTokens / msgDivisor,
    msgAvgReasoning: reasoningTokens / msgDivisor,
    msgAvgCacheRead: cacheReadTokens / msgDivisor,
    msgAvgCacheWrite: cacheWriteTokens / msgDivisor,
    totalCost,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    models,
  };
}

export function getOverallStats(messages: OpenCodeMessage[]): TokenStats {
  if (!Array.isArray(messages) || messages.length === 0) {
    console.warn('[getOverallStats] messages 为空或格式错误，无法生成 trends', messages);
  }
  const hasTokenInfo = messages.some(m => m?.info?.tokens && typeof m.info.tokens.total === 'number');
  if (messages.length > 0 && !hasTokenInfo) {
    console.warn('[getOverallStats] messages 中未找到有效的 tokens 信息，trends 将为空', messages[0]);
  }
  const userMsgMap = groupMessagesByUser(messages);
  const userMsgCount = Object.keys(userMsgMap).length;
  if (messages.length > 0 && userMsgCount === 0) {
    console.warn('[getOverallStats] 未按 user message 分组成功，请检查 info.role / info.id 字段');
  }
  const allStats: TokenStats[] = [];
  const userModelMap = new Map<string, { msgCount: number; userMsgCount: number }>();
  const trends: TokenTrendPoint[] = [];
  let cumulativeTokens = { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

  Object.values(userMsgMap).forEach(({ userMsg, msgs }) => {
    // 无 assistant 的 user 不进 trend（Grok compact 前残留 query / continuation 摘要会占坑，
    // 按 prompts 数对齐时还会把 estimate/real 的末尾 high-context 轮挤掉）
    if (!msgs.length) return;

    const stats = msgs.map((m) => extractTokenStatsFromMessage(m));
    const merged = mergeTokenStats(stats);
    allStats.push(merged);
    const startTokens = { ...cumulativeTokens };
    const delta = {
      total: merged.totalTokens, input: merged.inputTokens, output: merged.outputTokens,
      reasoning: merged.reasoningTokens, cacheRead: merged.cacheReadTokens, cacheWrite: merged.cacheWriteTokens,
    };
    cumulativeTokens = {
      total: cumulativeTokens.total + delta.total, input: cumulativeTokens.input + delta.input,
      output: cumulativeTokens.output + delta.output, reasoning: cumulativeTokens.reasoning + delta.reasoning,
      cacheRead: cumulativeTokens.cacheRead + delta.cacheRead, cacheWrite: cumulativeTokens.cacheWrite + delta.cacheWrite,
    };
    const endTokens = { ...cumulativeTokens };
    // 该轮最终上下文窗口: 取最后一条有 tokens 的 assistant（优先 context.total）
    // 桶内峰值更贴近「本轮 high context」（末条若 compact 后回落会偏低时取 max）
    let contextSize = 0;
    for (const m of msgs) {
      const c = resolveMessageContextSize(m.info.tokens);
      if (c > contextSize) contextSize = c;
    }
    const startTime = userMsg.info.time.created;
    const endTime = msgs.length > 0 ? Math.max(...msgs.map(m => m.info.time.completed || m.info.time.created)) : startTime;
    trends.push({ userMsgId: userMsg.info.id, startTime, endTime, startTokens, endTokens, delta, msgCount: msgs.length, contextSize });
    const modelKeys = new Set<string>();
    msgs.forEach((msg) => {
      const modelKey = `${msg.info.providerID || "unknown"}/${msg.info.modelID || "unknown"}`;
      modelKeys.add(modelKey);
      const existing = userModelMap.get(modelKey) || { msgCount: 0, userMsgCount: 0 };
      existing.msgCount++;
      userModelMap.set(modelKey, existing);
    });
    modelKeys.forEach((modelKey) => {
      const existing = userModelMap.get(modelKey) || { msgCount: 0, userMsgCount: 0 };
      existing.userMsgCount++;
      userModelMap.set(modelKey, existing);
    });
  });

  const init = { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCount: 0 };
  const merged = allStats.reduce((acc, s) => ({
    totalTokens: acc.totalTokens + s.totalTokens, inputTokens: acc.inputTokens + s.inputTokens,
    outputTokens: acc.outputTokens + s.outputTokens, reasoningTokens: acc.reasoningTokens + s.reasoningTokens,
    cacheReadTokens: acc.cacheReadTokens + s.cacheReadTokens, cacheWriteTokens: acc.cacheWriteTokens + s.cacheWriteTokens,
    toolCount: acc.toolCount + s.toolCount,
  }), init);
  const totalTokens = merged.totalTokens;
  const messageCount = allStats.reduce((sum, s) => sum + s.messageCount, 0);
  const toolCount = merged.toolCount;
  const msgDivisor = messageCount > 0 ? messageCount : 1;
  const allTools = allStats.flatMap((s) => s.tools);
  const toolGroups = _.groupBy(allTools, (t) => t.tool);
  const toolUsages: ToolUsage[] = _.map(toolGroups, (group, tool) => ({
    tool, count: _.sumBy(group, (t) => t.count), percent: toolCount > 0 ? _.sumBy(group, (t) => t.count) / toolCount : 0,
  })).sort((a, b) => b.count - a.count);
  const modelGroups = _.groupBy(allStats.flatMap((s) => s.models), (m) => `${m.providerID}/${m.modelID}`);
  const modelUsages: ModelUsage[] = _.map(modelGroups, (group, key) => {
    const [providerID, modelID] = key.split("/");
    const mCount = _.sumBy(group, (g) => g.messageCount);
    const mTotal = _.sumBy(group, (g) => g.totalTokens);
    const mToolCount = _.sumBy(group, (g) => g.toolCount);
    const modelUserStats = userModelMap.get(`${providerID}/${modelID}`) || { msgCount: 0, userMsgCount: 0 };
    const mInputTokens = _.sumBy(group, (g) => g.inputTokens);
    const mOutputTokens = _.sumBy(group, (g) => g.outputTokens);
    const mCacheReadTokens = _.sumBy(group, (g) => g.cacheReadTokens);
    const mCacheWriteTokens = _.sumBy(group, (g) => g.cacheWriteTokens);
    const costEstimates = AI_MODEL_PRICING_TABLE.map((pricing) => {
      const result = calculateCost(pricing, mInputTokens, mOutputTokens, mCacheReadTokens, mCacheWriteTokens);
      return { modelID: pricing.id, totalCost: result.totalCost, inputCost: result.inputCost, outputCost: result.outputCost, cacheReadCost: result.cacheReadCost, cacheWriteCost: result.cacheWriteCost };
    });
    const defaultPricing = AI_MODEL_PRICING_TABLE[0];
    const defaultResult = calculateCost(defaultPricing, mInputTokens, mOutputTokens, mCacheReadTokens, mCacheWriteTokens);
    const mergedCostByTier: CostByTier[] = [];
    group.forEach((g) => {
      (g.costByTier || []).forEach((tier) => {
        const existing = mergedCostByTier.find(t => t.tierLabel === tier.tierLabel);
        if (existing) {
          existing.messageCount += tier.messageCount; existing.inputTokens += tier.inputTokens;
          existing.outputTokens += tier.outputTokens; existing.cacheReadTokens += tier.cacheReadTokens;
          existing.totalCost += tier.totalCost; existing.inputCost += tier.inputCost;
          existing.outputCost += tier.outputCost; existing.cacheReadCost += tier.cacheReadCost;
          existing.cacheWriteCost += tier.cacheWriteCost;
        } else { mergedCostByTier.push({ ...tier }); }
      });
    });
    return {
      modelID: modelID || "unknown", providerID: providerID || "unknown", messageCount: mCount, totalTokens: mTotal,
      inputTokens: mInputTokens, outputTokens: mOutputTokens,
      reasoningTokens: _.sumBy(group, (g) => g.reasoningTokens),
      cacheReadTokens: mCacheReadTokens, cacheWriteTokens: mCacheWriteTokens,
      msgPercent: mCount / msgDivisor, tokenPercent: totalTokens > 0 ? mTotal / totalTokens : 0,
      totalSteps: mCount, avgStepsPerMsg: mTotal / (mCount || 1), stepPercent: mCount / msgDivisor,
      avgMsgsPerUserMsg: modelUserStats.msgCount / (modelUserStats.userMsgCount || 1),
      toolCount: mToolCount, toolPercent: toolCount > 0 ? mToolCount / toolCount : 0,
      totalCost: defaultResult.totalCost, inputCost: defaultResult.inputCost, outputCost: defaultResult.outputCost,
      cacheReadCost: defaultResult.cacheReadCost, cacheWriteCost: defaultResult.cacheWriteCost,
      costByTier: mergedCostByTier, costEstimates,
    };
  }).sort((a, b) => b.totalTokens - a.totalTokens);

  let lastMessage: LastMessageInfo | undefined;
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.info.tokens) {
      const tokens = lastMsg.info.tokens;
      lastMessage = {
        role: lastMsg.info.role, modelID: lastMsg.info.modelID || lastMsg.info.model?.modelID || "unknown",
        totalTokens: tokens.total, inputTokens: tokens.input, outputTokens: tokens.output,
        reasoningTokens: tokens.reasoning, cacheReadTokens: tokens.cache?.read || 0, cacheWriteTokens: tokens.cache?.write || 0,
      };
    }
  }
  let contextMessage: LastMessageInfo | undefined;
  if (messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const tokens = msg.info.tokens;
      if (!tokens) continue;
      const contextTotal = resolveMessageContextSize(tokens);
      if (contextTotal <= 0 && !(tokens.total > 0)) continue;
      const ctx = tokens.context;
      // 展示分项：有 context.total 时 total 用窗口；input/cache 仍用 context 分项（可能与 total 不一致，见 Grok）
      const contextInput = ctx ? (ctx.input || 0) : tokens.input;
      const contextCacheRead = ctx ? (ctx.cacheRead || 0) : (tokens.cache?.read || 0);
      contextMessage = {
        role: msg.info.role, modelID: msg.info.modelID || msg.info.model?.modelID || "unknown",
        totalTokens: contextTotal > 0 ? contextTotal : (contextInput + contextCacheRead),
        inputTokens: contextInput, outputTokens: tokens.output,
        reasoningTokens: tokens.reasoning, cacheReadTokens: contextCacheRead, cacheWriteTokens: tokens.cache?.write || 0,
      };
      break;
    }
  }
  const allCostByTier: CostByTier[] = [];
  allStats.forEach((s) => {
    (s.costByTier || []).forEach((tier) => {
      const existing = allCostByTier.find(t => t.tierLabel === tier.tierLabel);
      if (existing) {
        existing.messageCount += tier.messageCount; existing.inputTokens += tier.inputTokens;
        existing.outputTokens += tier.outputTokens; existing.cacheReadTokens += tier.cacheReadTokens;
        existing.totalCost += tier.totalCost; existing.inputCost += tier.inputCost;
        existing.outputCost += tier.outputCost; existing.cacheReadCost += tier.cacheReadCost; existing.cacheWriteCost += tier.cacheWriteCost;
      } else { allCostByTier.push({ ...tier }); }
    });
  });
  const result: TokenStats = {
    totalTokens, inputTokens: merged.inputTokens, outputTokens: merged.outputTokens,
    reasoningTokens: merged.reasoningTokens, cacheReadTokens: merged.cacheReadTokens, cacheWriteTokens: merged.cacheWriteTokens,
    messageCount, cacheRate: totalTokens > 0 ? merged.cacheReadTokens / totalTokens : 0,
    msgAvgTotal: totalTokens / msgDivisor, msgAvgInput: merged.inputTokens / msgDivisor, msgAvgOutput: merged.outputTokens / msgDivisor,
    msgAvgReasoning: merged.reasoningTokens / msgDivisor, msgAvgCacheRead: merged.cacheReadTokens / msgDivisor, msgAvgCacheWrite: merged.cacheWriteTokens / msgDivisor,
    models: modelUsages, totalSteps: userMsgCount, avgStepsPerMsg: totalTokens / (userMsgCount || 1),
    avgMsgsPerUserMsg: messageCount / (userMsgCount || 1), toolCount, tools: toolUsages,
    totalCost: _.sumBy(modelUsages, (m) => m.totalCost), inputCost: _.sumBy(modelUsages, (m) => m.inputCost),
    outputCost: _.sumBy(modelUsages, (m) => m.outputCost), cacheReadCost: _.sumBy(modelUsages, (m) => m.cacheReadCost),
    cacheWriteCost: _.sumBy(modelUsages, (m) => m.cacheWriteCost), costByTier: allCostByTier,
    costEstimates: AI_MODEL_PRICING_TABLE.map((pricing) => {
      const costResult = calculateCost(pricing, merged.inputTokens, merged.outputTokens, merged.cacheReadTokens, merged.cacheWriteTokens);
      return { modelID: pricing.id, totalCost: costResult.totalCost, inputCost: costResult.inputCost, outputCost: costResult.outputCost, cacheReadCost: costResult.cacheReadCost, cacheWriteCost: costResult.cacheWriteCost };
    }),
    lastMessage, contextMessage, trends,
  };
  if (messages.length > 0 && (!result.trends || result.trends.length === 0)) {
    console.warn('[getOverallStats] 生成的 trends 为空，请检查 message.info.tokens 是否存在');
  }
  return result;
}

const emptyTrendCost = (): TokenTrendCostBreakdown => ({
  input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0,
});

function addTrendCost(a: TokenTrendCostBreakdown, b: TokenTrendCostBreakdown): TokenTrendCostBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}

function costResultToTrend(c: { inputCost: number; outputCost: number; cacheReadCost: number; cacheWriteCost: number; totalCost: number }): TokenTrendCostBreakdown {
  return {
    input: c.inputCost,
    output: c.outputCost,
    reasoning: 0,
    cacheRead: c.cacheReadCost,
    cacheWrite: c.cacheWriteCost,
    total: c.totalCost,
  };
}

function isZeroTablePricing(p?: Pick<ModelPricing, 'inputPrice' | 'outputPrice'> | null): boolean {
  if (!p) return true;
  return (p.inputPrice ?? 0) === 0 && (p.outputPrice ?? 0) === 0;
}

/** 从定价候选中优先取非零价（规避 models.dev 免费/占位 0 价脏数据） */
function pickNonZeroPricing(candidates: ModelPricing[]): ModelPricing | undefined {
  if (!candidates.length) return undefined;
  return candidates.find((c) => !isZeroTablePricing(c)) || candidates[0];
}

/** 从 pricing table 粗匹配模型单价（详情页 AUTO 兜底；精确匹配见后端 findPricing） */
export function resolvePricingFromTable(
  table: ModelPricing[] | undefined,
  providerID?: string,
  modelID?: string,
): ModelPricing | undefined {
  if (!table?.length || !modelID) return undefined;
  const p = (providerID || '').toLowerCase();
  const m = modelID.toLowerCase();
  const modelOnly = m.includes('/') ? m.split('/').pop()! : m;
  const keys = [
    p && m ? `${p}/${m}` : '',
    p && modelOnly ? `${p}/${modelOnly}` : '',
    m,
    modelOnly,
  ].filter(Boolean);

  let zeroHit: ModelPricing | undefined;
  for (const key of keys) {
    const hits = table.filter((x) => x.id.toLowerCase() === key);
    const picked = pickNonZeroPricing(hits);
    if (picked && !isZeroTablePricing(picked)) return picked;
    if (!zeroHit && picked) zeroHit = picked;
  }

  const suffixHits = table.filter((x) => {
    const id = x.id.toLowerCase();
    return id.endsWith(`/${modelOnly}`) || id === modelOnly;
  });
  const suffixPick = pickNonZeroPricing(suffixHits);
  if (suffixPick && !isZeroTablePricing(suffixPick)) return suffixPick;
  return suffixPick || zeroHit;
}

type ModelUnitRates = {
  input: number; output: number; cacheRead: number; cacheWrite: number;
};

/** 用 session.pricing.details 反推每 token 单价(USD)，使趋势合计与实际成本一致 */
function buildUnitRatesFromSessionPricing(sessionPricing?: SessionExportPricing | null): Map<string, ModelUnitRates> {
  const map = new Map<string, ModelUnitRates>();
  sessionPricing?.details?.forEach((d) => {
    const rates: ModelUnitRates = {
      input: d.input > 0 ? (d.inputCost ?? 0) / d.input : 0,
      output: d.output > 0 ? (d.outputCost ?? 0) / d.output : 0,
      cacheRead: d.cacheRead > 0 ? (d.cacheReadCost ?? 0) / d.cacheRead : 0,
      cacheWrite: d.cacheWrite > 0 ? (d.cacheWriteCost ?? 0) / d.cacheWrite : 0,
    };
    // details 无分项成本时，按总 usd 均摊到有 token 的类型（退化兜底）
    if (!d.inputCost && !d.outputCost && !d.cacheReadCost && !d.cacheWriteCost && d.usd > 0) {
      const denom = d.input + d.output + d.cacheRead + d.cacheWrite;
      if (denom > 0) {
        const unit = d.usd / denom;
        rates.input = d.input > 0 ? unit : 0;
        rates.output = d.output > 0 ? unit : 0;
        rates.cacheRead = d.cacheRead > 0 ? unit : 0;
        rates.cacheWrite = d.cacheWrite > 0 ? unit : 0;
      }
    }
    const key = d.modelKey.toLowerCase();
    map.set(key, rates);
    const only = key.split('/').pop();
    if (only && only !== key) map.set(only, rates);
  });
  return map;
}

function messageTokens(msg: OpenCodeMessage) {
  const t = msg.info.tokens;
  return {
    input: t?.input || 0,
    output: t?.output || 0,
    reasoning: t?.reasoning || 0,
    cacheRead: t?.cache?.read || 0,
    cacheWrite: t?.cache?.write || 0,
  };
}

/**
 * 为 trends 填充 deltaCost / endCost，使 Cost 趋势与「实际成本」一致：
 * - AUTO：优先用 sessionPricing.details 反推单价（合计=后端 pricing）
 * - 非 AUTO：用固定 pricing 对每轮 token 计价（output 不含 reasoning，含 cacheWrite）
 */
export function enrichTokenTrendsWithCost(
  messages: OpenCodeMessage[],
  trends: TokenTrendPoint[],
  options: {
    pricing?: ModelPricing | null;
    sessionPricing?: SessionExportPricing | null;
    pricingTable?: ModelPricing[];
    usdToCnyRate?: number;
  } = {},
): TokenTrendPoint[] {
  if (!trends?.length) return trends || [];
  const { pricing, sessionPricing, pricingTable, usdToCnyRate = USD_TO_CNY_RATE } = options;
  const userMap = groupMessagesByUser(messages);
  const unitRates = !pricing ? buildUnitRatesFromSessionPricing(sessionPricing) : null;
  const useAutoRates = !pricing && unitRates && unitRates.size > 0;

  let cumulative = emptyTrendCost();
  return trends.map((point) => {
    const group = userMap[point.userMsgId];
    const msgs = group?.msgs || [];
    let delta = emptyTrendCost();

    if (msgs.length) {
      // 按消息原始 tokens 计价（与后端 calculateMessageCost 一致：output 不扣 reasoning）
      msgs.forEach((msg) => {
        if (msg.info.role !== 'assistant') return;
        const tok = messageTokens(msg);
        if (!(tok.input || tok.output || tok.cacheRead || tok.cacheWrite)) return;
        const modelID = msg.info.modelID || msg.info.model?.modelID || '';
        const providerID = msg.info.providerID || msg.info.model?.providerID || '';
        const modelKey = `${providerID}/${modelID}`.toLowerCase();
        const modelOnly = (modelID.split('/').pop() || modelID).toLowerCase();
        const ctx = tok.input + tok.cacheRead;

        if (pricing) {
          delta = addTrendCost(
            delta,
            costResultToTrend(
              calculateCost(pricing, tok.input, tok.output, tok.cacheRead, tok.cacheWrite, ctx, usdToCnyRate),
            ),
          );
          return;
        }

        if (useAutoRates) {
          const rates = unitRates!.get(modelKey) || unitRates!.get(modelOnly);
          if (!rates) return;
          const input = tok.input * rates.input;
          const output = tok.output * rates.output;
          const cacheRead = tok.cacheRead * rates.cacheRead;
          const cacheWrite = tok.cacheWrite * rates.cacheWrite;
          delta = addTrendCost(delta, {
            input, output, reasoning: 0, cacheRead, cacheWrite,
            total: input + output + cacheRead + cacheWrite,
          });
          return;
        }

        const eff = resolvePricingFromTable(pricingTable, providerID, modelID)
          || resolvePricingFromTable(pricingTable, undefined, modelID);
        if (!eff) return;
        delta = addTrendCost(
          delta,
          costResultToTrend(
            calculateCost(eff, tok.input, tok.output, tok.cacheRead, tok.cacheWrite, ctx, usdToCnyRate),
          ),
        );
      });
    } else if (pricing) {
      // 无消息时退回 trend bucket
      const bucket = point.delta;
      const ctx = bucket.input + bucket.cacheRead;
      delta = costResultToTrend(
        calculateCost(pricing, bucket.input, bucket.output, bucket.cacheRead, bucket.cacheWrite, ctx, usdToCnyRate),
      );
    }

    cumulative = addTrendCost(cumulative, delta);
    return { ...point, deltaCost: delta, endCost: { ...cumulative } };
  });
}

export function formatTokenStats(stats: TokenStats): string {
  const lines = [
    `## 消息统计`,
    `- **总消息数**: ${stats.messageCount}`,
    `- **用户消息数**: ${stats.totalSteps}`,
    `- **平均每用户消息**: ${stats.avgMsgsPerUserMsg.toFixed(2)}`,
    ``,
    `## Token 统计`,
    `- **总 Tokens**: ${stats.totalTokens.toLocaleString()}`,
    `- 输入: ${stats.inputTokens.toLocaleString()}`,
    `- 输出: ${stats.outputTokens.toLocaleString()}`,
    `- 推理: ${stats.reasoningTokens.toLocaleString()}`,
    `- 缓存读取: ${stats.cacheReadTokens.toLocaleString()}`,
    `- 缓存写入: ${stats.cacheWriteTokens.toLocaleString()}`,
    `- **缓存命中率**: ${(stats.cacheRate * 100).toFixed(2)}%`,
    ``,
    `### 平均每消息`,
    `- 总计: ${stats.msgAvgTotal.toFixed(0)}`,
    `- 输入: ${stats.msgAvgInput.toFixed(0)}`,
    `- 输出: ${stats.msgAvgOutput.toFixed(0)}`,
    `- 推理: ${stats.msgAvgReasoning.toFixed(0)}`,
    `- 缓存读取: ${stats.msgAvgCacheRead.toFixed(0)}`,
    `- 缓存写入: ${stats.msgAvgCacheWrite.toFixed(0)}`,
    ``,
    `## 成本统计`,
    `**估算模型**: ${AI_MODEL_PRICING_TABLE[0].name}`,
    ``,
    `- **总成本**: US$${stats.totalCost.toFixed(2)} (=CN¥${(stats.totalCost * USD_TO_CNY_RATE).toFixed(2)})`,
    `- 输入: US$${stats.inputCost.toFixed(2)} (=CN¥${(stats.inputCost * USD_TO_CNY_RATE).toFixed(2)})`,
    `- 输出: US$${stats.outputCost.toFixed(2)} (=CN¥${(stats.outputCost * USD_TO_CNY_RATE).toFixed(2)})`,
    `- 缓存读取: US$${stats.cacheReadCost.toFixed(2)} (=CN¥${(stats.cacheReadCost * USD_TO_CNY_RATE).toFixed(2)})`,
    `- 缓存写入: US$${stats.cacheWriteCost.toFixed(2)} (=CN¥${(stats.cacheWriteCost * USD_TO_CNY_RATE).toFixed(2)})`,
    ``,
    `### 各模型成本预估`,
    ...stats.costEstimates.map((est) => `- ${est.modelID}: US$${est.totalCost.toFixed(2)} (=CN¥${(est.totalCost * USD_TO_CNY_RATE).toFixed(2)})`),
    ``,
    `## 模型详情 (${stats.models.length})`,
    ...stats.models.map((m) =>
      [
        ``,
        `### ${m.providerID}/${m.modelID}`,
        `- **消息数**: ${m.messageCount} (${(m.msgPercent * 100).toFixed(1)}%)`,
        `- **平均每用户消息**: ${m.avgMsgsPerUserMsg.toFixed(2)}`,
        `- **Tokens**: ${m.totalTokens.toLocaleString()} (${(m.tokenPercent * 100).toFixed(1)}%)`,
        `  - 输入: ${m.inputTokens.toLocaleString()}`,
        `  - 输出: ${m.outputTokens.toLocaleString()}`,
        `  - 推理: ${m.reasoningTokens.toLocaleString()}`,
        ``,
        `#### 成本明细 (估算模型: ${AI_MODEL_PRICING_TABLE[0].name})`,
        `- 总成本: US$${m.totalCost.toFixed(2)} (=CN¥${(m.totalCost * USD_TO_CNY_RATE).toFixed(2)})`,
        `- 输入: US$${m.inputCost.toFixed(2)} (=CN¥${(m.inputCost * USD_TO_CNY_RATE).toFixed(2)})`,
        `- 输出: US$${m.outputCost.toFixed(2)} (=CN¥${(m.outputCost * USD_TO_CNY_RATE).toFixed(2)})`,
        `- 缓存读取: US$${m.cacheReadCost.toFixed(2)} (=CN¥${(m.cacheReadCost * USD_TO_CNY_RATE).toFixed(2)})`,
        `- 缓存写入: US$${m.cacheWriteCost.toFixed(2)} (=CN¥${(m.cacheWriteCost * USD_TO_CNY_RATE).toFixed(2)})`,
        ``,
        `#### 各模型成本预估`,
        ...m.costEstimates.map((est) => `- ${est.modelID}: US$${est.totalCost.toFixed(2)} (=CN¥${(est.totalCost * USD_TO_CNY_RATE).toFixed(2)})`),
        ``,
        `- **工具调用**: ${m.toolCount} (${(m.toolPercent * 100).toFixed(1)}%)`,
      ].join("\n")
    ),
    ``,
    `## 工具统计 (${stats.tools.length})`,
    `- **总调用次数**: ${stats.toolCount}`,
    ``,
    ...stats.tools.map((t) => `- ${t.tool}: ${t.count} (${(t.percent * 100).toFixed(1)}%)`),
  ];

  if (stats.lastMessage) {
    const lastMsg = stats.lastMessage;
    lines.push(``);
    lines.push(`## 最后消息 Token 情况`);
    lines.push(`- **角色**: ${lastMsg.role}`);
    lines.push(`- **模型**: ${lastMsg.modelID}`);
    lines.push(`- **总 Tokens**: ${lastMsg.totalTokens.toLocaleString()}`);
    lines.push(`- 输入: ${lastMsg.inputTokens.toLocaleString()}`);
    lines.push(`- 输出: ${lastMsg.outputTokens.toLocaleString()}`);
    if (lastMsg.reasoningTokens) { lines.push(`- 推理: ${lastMsg.reasoningTokens.toLocaleString()}`); }
    lines.push(`- 缓存读取: ${lastMsg.cacheReadTokens.toLocaleString()}`);
    lines.push(`- 缓存写入: ${lastMsg.cacheWriteTokens.toLocaleString()}`);
  }
  return lines.join("\n");
}
