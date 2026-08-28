/**
 * Grok 数据源转换：把 Grok Build CLI 本地数据转成 UnifiedSessionInfo/UnifiedMessage。
 *
 * usage 通路 (issue #16):
 * - token：优先 turn_completed.usage 真实分项
 * - 成本：优先 wire costUsdTicks（与 CLI / xAI 账单一致）；无 ticks 时走静态表
 *   - grok-4.5 静态表含 <200k / ≥200k 分档；分档用「平均单 call prompt」，勿用 turn 累加
 * - 旧 session 无 usage → context 快照估算（标 usage_source=estimate）
 */

import dayjs from 'dayjs';
import { diffLines } from 'diff';
import {
  listGrokCodeSessions,
  listGrokCodeMessages,
  getGrokSessionUsageSummary,
  splitGrokContextTokens,
  grokSumAssistantContextTokens,
  normalizeGrokModelId,
  collectGrokModelsUsed,
  buildGrokTrendsFromTurns,
  ticksToUsd,
  deriveGrokCompactionStats,
  isGrokCompactionText,
  isGrokContinuationSummary,
  type GrokSessionItem,
  type GrokMessageItem,
  type GrokSessionUsageSummary,
  type GrokPromptUsageModel,
  type GrokRealUsage,
} from './grok-code';
import { checkSessionStatus } from './opencode';
import {
  calculateMessageCost,
  calculateSessionPricingFromUnifiedMessages,
  type SessionPricing,
  type SessionPricingDetail,
} from '../pricing';
import { getUsdToCnyRate } from '../pricing';
import type { TokenTrendPoint } from '../core';
import { groupMessagesByUser } from '../core';
import type { UnifiedSessionInfo, UnifiedSessionDetail, UnifiedMessage } from './types';
import { inferDeliverableSignals } from './deliverable-signals';
import { classifyBashCommands, extractBashCommands } from './bash-signals';
import { maxContextFromUnifiedMessages, sanitizeUserTextParts, buildLastTokenInfo } from './utils';
import { buildActivitySpanFromUnifiedMessages, type UsageByDay } from './usage-by-day';
import {
  createTimingLists,
  pushAssistantTimingSample,
  summarizeTimingLists,
  type TimingSummary,
} from '../lib/timing-stats';

/** Grok 写文件类工具（与 deliverable-signals 对齐） */
const GROK_EDIT_TOOLS = new Set([
  'search_replace',
  'str_replace',
  'write',
  'write_file',
  'edit_file',
  'edit',
  'apply_patch',
]);

function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

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

/**
 * 从 write / search_replace 等 tool input 统计 editDiffs。
 * Grok 无 filediff metadata，靠 args 行 diff。
 */
export function calculateEditDiffsFromGrokMessages(messages: UnifiedMessage[]): {
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
      if (part.type !== 'tool' && !(part as any).tool) continue;
      const name = String((part as any).tool || '').toLowerCase();
      if (!GROK_EDIT_TOOLS.has(name)) continue;

      const state = typeof (part as any).state === 'object' && (part as any).state != null
        ? (part as any).state
        : {};
      const input = (state.input || (part as any).input || {}) as Record<string, unknown>;
      const filePath = String(
        input.file_path || input.filePath || input.path || input.target_file || state.title || '',
      );

      let additions = 0;
      let deletions = 0;

      if (name === 'write' || name === 'write_file') {
        const content = input.content != null ? String(input.content) : '';
        additions = countLines(content);
      } else if (
        name === 'search_replace'
        || name === 'str_replace'
        || name === 'edit'
        || name === 'edit_file'
      ) {
        const oldStr = String(input.old_string ?? input.oldString ?? input.old_str ?? '');
        const newStr = String(input.new_string ?? input.newString ?? input.new_str ?? '');
        if (oldStr || newStr) {
          const d = calculateLineDiff(oldStr, newStr);
          additions = d.additions;
          deletions = d.deletions;
        }
      } else if (name === 'apply_patch') {
        const patch = String(input.patch || input.diff || input.input || '');
        for (const line of patch.split('\n')) {
          if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
          else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
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

// ==================== Grok 数据源转换 ====================

/** wire / chat_history tool status → OpenCode part.state.status（soft fail 在 grok-code 已降为 completed） */
function mapGrokToolPartStatus(tc: {
  result?: unknown;
  status?: string;
  errorSeverity?: string;
}): string {
  const s = (tc.status || '').toLowerCase();
  // 双保险：若仍带 soft + failed，不计入 hard fail
  if ((s === 'failed' || s === 'error') && tc.errorSeverity === 'soft') return 'completed';
  if (s === 'completed' || s === 'success' || s === 'done') return 'completed';
  if (s === 'failed') return 'failed';
  if (s === 'error') return 'error';
  // in_progress 流式输出时可能已有 partial result，不能靠 result 判完成
  if (s === 'in_progress' || s === 'pending' || s === 'running' || s === 'calling') return 'calling';
  // 无 wire status：chat_history tool_result 写入后 result 有值（含空串）
  return tc.result !== undefined ? 'completed' : 'calling';
}

function convertGrokMessage(msg: GrokMessageItem, sessionId: string): UnifiedMessage {
  const ts = msg.timestamp || Date.now();
  const done = msg.completedAt != null && msg.completedAt >= ts ? msg.completedAt : undefined;
  const hasTools = (msg.toolCalls || []).length > 0;
  const isCompaction = !!(
    msg.compaction
    || isGrokCompactionText(msg.text)
    || (msg.role === 'user' && isGrokContinuationSummary(msg.text))
  );
  // Grok wire 无 finishReason：有 tool_calls 的 step 等价 tool-calls（turn 可能仍继续）
  // 否则 stop。有墙钟 completedAt 时写入 time.completed（trace duration）；
  // 无 completedAt 的 tool-calls 仍不写 completed，避免误判 session done。
  // compact 合成消息视为已结束（stop）。
  const finish = msg.role === 'assistant'
    ? (isCompaction ? 'stop' : hasTools ? 'tool-calls' : 'stop')
    : undefined;
  const time: { created: number; completed?: number } = { created: ts };
  if (done != null) {
    time.completed = done;
  } else if (finish !== 'tool-calls') {
    time.completed = ts;
  }
  const info: any = {
    role: msg.role,
    time,
    id: msg.uuid,
    sessionID: sessionId,
    parentID: msg.parentID,
    modelID: msg.model,
    providerID: 'xai',
    ...(finish ? { finish } : {}),
    ...(isCompaction ? { compaction: true } : {}),
    ...(msg.timeSource ? { timeSource: msg.timeSource } : {}),
    // 有 message.realUsage 用真实分项（含 0 占位：进行中 turn 不计费）；否则 context 快照估算
    tokens: (() => {
      const ctx = msg.contextTokens ?? 0;
      if (msg.realUsage) {
        const { input, output, cached, reasoning } = msg.realUsage;
        const total = input + output + cached;
        return {
          total,
          input,
          output,
          reasoning,
          cache: { read: cached, write: 0 },
          // context.total 优先窗口快照；分项用本步计费（窗口 cache 占比未知）
          context: {
            total: ctx || (input + cached),
            input,
            cacheRead: cached,
          },
        };
      }
      const split = splitGrokContextTokens(ctx);
      return {
        total: split.total,
        input: split.input,
        output: split.output,
        reasoning: split.reasoning,
        cache: { read: split.cacheRead, write: 0 },
        context: { total: ctx, input: split.input, cacheRead: split.cacheRead },
      };
    })(),
  };
  if (msg.model) {
    // provider 统一 xai；model 已在 listGrokCodeMessages 归一（grok-4.5-build→grok-4.5）
    info.model = { providerID: 'xai', modelID: msg.model };
    info.providerID = 'xai';
    info.modelID = msg.model;
  }
  const parts: any[] = [];
  const structured = msg.parts && msg.parts.length > 0;
  if (structured) {
    let partIdx = 0;
    for (const p of msg.parts!) {
      if (p.type === 'text' && p.text) {
        parts.push({
          type: 'text',
          id: `${msg.uuid}-p-${partIdx++}`,
          sessionID: sessionId,
          messageID: msg.uuid,
          text: p.text,
        });
      } else if (p.type === 'reasoning' && p.text) {
        parts.push({
          type: 'reasoning',
          id: `${msg.uuid}-p-${partIdx++}`,
          sessionID: sessionId,
          messageID: msg.uuid,
          text: p.text,
          state: p.state || 'done',
        });
      }
    }
  } else {
  if (msg.text) {
    parts.push({
      type: 'text',
      id: msg.uuid + '-text',
      sessionID: sessionId,
      messageID: msg.uuid,
      text: msg.text,
    });
  }
  if (msg.thinking) {
    parts.push({
      type: 'reasoning',
      id: msg.uuid + '-reason',
      sessionID: sessionId,
      messageID: msg.uuid,
      text: msg.thinking,
      state: 'done',
    });
  }
  }
  (msg.toolCalls || []).forEach((tc, idx) => {
    const status = mapGrokToolPartStatus(tc);
    const meta: Record<string, unknown> = {};
    if (tc.errorKind) meta.errorKind = tc.errorKind;
    if (tc.errorSeverity) meta.errorSeverity = tc.errorSeverity;
    const toolTime = tc.startMs != null
      ? {
        start: tc.startMs,
        end: tc.endMs != null && tc.endMs >= tc.startMs ? tc.endMs : tc.startMs,
      }
      : undefined;
    parts.push({
      type: 'tool',
      id: msg.uuid + '-tool-' + idx,
      sessionID: sessionId,
      messageID: msg.uuid,
      tool: tc.name,
      callID: tc.toolCallId,
      ...(toolTime ? { time: toolTime } : {}),
      state: {
        status,
        input: tc.args,
        output: tc.result,
        title: tc.name,
        // hard fail：供 tool-error-stats 取 error 文本
        ...((status === 'failed' || status === 'error') && tc.result != null
          ? { error: tc.result }
          : {}),
        ...(Object.keys(meta).length ? { metadata: meta } : {}),
      },
    });
  });
  return { info, parts } as UnifiedMessage;
}

function buildGrokListExtras(
  messages: GrokMessageItem[],
  sessionId: string,
): {
  userParts: Array<{ role: string; text: string; tool: string; duration: number; startTime: number; endTime: number }>;
  totalUserTurns: number;
  avgMsgsPerUserMsg: number;
  textParts: Array<{ role: string; text: string; tool: string; duration: number; startTime: number; endTime: number }>;
} {
  const realUserMsgs = messages.filter(
    (m) => m.role === 'user'
      && m.text.includes('<user_query>')
      && !m.compaction
      && !isGrokContinuationSummary(m.text),
  );
  let userParts = realUserMsgs.map((m) => ({
    role: 'user' as const,
    text: m.text.replace(/<\/?user_query>/g, '').trim() || m.text.slice(0, 200),
    tool: '',
    duration: 0,
    startTime: m.timestamp,
    endTime: m.timestamp,
  }));
  userParts = sanitizeUserTextParts(userParts);
  userParts = userParts.filter((r, i) => (i > 0 ? userParts[i - 1].text !== r.text : true));

  const unified = messages.map((m) => convertGrokMessage(m, sessionId));
  const grouped = groupMessagesByUser(unified as Parameters<typeof groupMessagesByUser>[0]);
  const turnCounts = Object.values(grouped)
    .filter((g) => {
      const t = g.userMsg.parts?.find((p: any) => p.type === 'text')?.text || '';
      return t.includes('<user_query>');
    })
    .map((g) => g.msgs.length);
  const totalUserTurns = turnCounts.length || userParts.length;
  const assistantInTurns = turnCounts.reduce((a, b) => a + b, 0);
  const avgMsgsPerUserMsg = totalUserTurns > 0
    ? Number((assistantInTurns / totalUserTurns).toFixed(1))
    : 0;

  const textParts: Array<{ role: string; text: string; tool: string; duration: number; startTime: number; endTime: number }> = [];
  for (const m of messages) {
    if (m.compaction || isGrokCompactionText(m.text)) continue;
    if (m.role === 'assistant' && (m.text || m.thinking)) {
      textParts.push({
        role: 'assistant',
        text: [m.text, m.thinking].filter(Boolean).join('\n'),
        tool: '',
        duration: 0,
        startTime: m.timestamp,
        endTime: m.timestamp,
      });
    }
  }

  return { userParts, totalUserTurns, avgMsgsPerUserMsg, textParts };
}

/** 列表用: 仅 summary.json，不读 chat_history.jsonl */
function convertGrokSessionFromSummary(session: GrokSessionItem): UnifiedSessionInfo {
  const totalMessages = session.numChatMessages ?? session.numMessages ?? 0;
  return {
    id: session.sessionId,
    project_id: session.workDir,
    parent_id: session.parentId ?? undefined,
    slug: session.sessionId,
    directory: session.workDir,
    title: session.title,
    version: 'grok-build',
    time_created: session.createdAt,
    time_updated: session.updatedAt,
    total_messages: totalMessages,
    total_user_messages: 0,
    total_tool_calls: 0,
    total_tool_calls_success: 0,
    total_tool_calls_failed: 0,
    total_tokens: 0,
    total_input: 0,
    total_output: 0,
    models_used: normalizeGrokModelId(session.modelId) || 'unknown',
    last_active_at_iso: dayjs(session.updatedAt).toISOString(),
    last_active_at: dayjs(session.updatedAt).toISOString(),
    session_status: 'done',
    pricing: { usd: 0, cny: 0 },
    source: 'grok',
  } as UnifiedSessionInfo;
}

/**
 * 从 turn_completed.usage 聚合 session Performance。
 * TTFT 用 updates 实测（streamStartMs → 该流首 chunk），每次模型流调用一条样本；
 * 无实测样本的旧 turn 退化为整段 apiDurationMs 占位过 filter。
 * decode 吞吐 = 累计 output / apiDurationMs；每 turn 一条样本，与其它 source 的 per-assistant 均值语义接近。
 */
export function timingFromGrokRealUsage(real: GrokRealUsage): TimingSummary {
  const lists = createTimingLists();
  for (const turn of real.turns || []) {
    const durationMs = turn.apiDurationMs || 0;
    if (durationMs <= 0) continue;
    const outputTokens = turn.outputTokens || 0;
    const ttfts = (turn.ttftMsList || []).filter((v) => Number.isFinite(v) && v > 0);
    const latencyMs = ttfts.length > 0
      ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length)
      : Math.min(durationMs, 299_999);
    pushAssistantTimingSample(lists, {
      latencyMs,
      outputTokens,
      decodeDurationMs: durationMs,
      // 不传 inputTokens：turn 级 input 与单次流 TTFT 不匹配，prefill tps 无意义
    });
  }
  return summarizeTimingLists(lists);
}

type GrokSliceCost = {
  usd: number;
  cny: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
};

/**
 * 单次 usage 切片计价。
 * - 有 costUsdTicks → 以 ticks 为准（与 CLI 一致）；input/output/cache 分项按表价比例缩放
 * - 无 ticks → 静态表；分档用平均单 call prompt（防 turn 累加误触发 ≥200k）
 */
export function costGrokUsageSlice(opts: {
  modelId: string;
  input: number;
  output: number;
  cacheRead: number;
  costUsdTicks?: number | null;
  modelCalls?: number;
}): GrokSliceCost {
  const modelCalls = Math.max(1, opts.modelCalls || 1);
  const prompt = (opts.input || 0) + (opts.cacheRead || 0);
  const avgPrompt = prompt / modelCalls;
  const table = calculateMessageCost({
    providerID: 'xai',
    modelID: opts.modelId,
    tokens: {
      input: opts.input || 0,
      output: opts.output || 0,
      cacheRead: opts.cacheRead || 0,
      cacheWrite: 0,
    },
    contextTokens: avgPrompt,
  });

  const ticksUsd = ticksToUsd(opts.costUsdTicks);
  if (ticksUsd != null && ticksUsd >= 0) {
    if (table.totalCost > 0) {
      const s = ticksUsd / table.totalCost;
      return {
        usd: ticksUsd,
        cny: table.cny * s,
        // 各分项成本在 MessageCostResult 里是可选的；缺失按 0 计，避免算出 NaN
        inputCost: (table.inputCost ?? 0) * s,
        outputCost: (table.outputCost ?? 0) * s,
        cacheReadCost: (table.cacheReadCost ?? 0) * s,
        cacheWriteCost: (table.cacheWriteCost ?? 0) * s,
      };
    }
    const rate = getUsdToCnyRate();
    return {
      usd: ticksUsd,
      cny: ticksUsd * rate,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
    };
  }

  return {
    usd: table.totalCost,
    cny: table.cny,
    inputCost: table.inputCost ?? 0,
    outputCost: table.outputCost ?? 0,
    cacheReadCost: table.cacheReadCost ?? 0,
    cacheWriteCost: table.cacheWriteCost ?? 0,
  };
}

/**
 * 真实 usage → SessionPricing。
 * 优先按 turn/modelUsage 切片累加（ticks 优先）；无 turns 时退回 modelUsage 汇总。
 */
function pricingFromGrokRealUsage(usage: GrokSessionUsageSummary): SessionPricing | null {
  if (usage.usageSource !== 'real') return null;
  const byModel = new Map<string, SessionPricingDetail>();

  const pushDetail = (
    modelId: string,
    input: number,
    output: number,
    cacheRead: number,
    costUsdTicks?: number | null,
    modelCalls?: number,
  ) => {
    const cost = costGrokUsageSlice({
      modelId,
      input,
      output,
      cacheRead,
      costUsdTicks,
      modelCalls,
    });
    const key = `xai/${modelId}`;
    const existing = byModel.get(key);
    if (existing) {
      existing.input += input;
      existing.output += output;
      existing.cacheRead += cacheRead;
      existing.usd += cost.usd;
      existing.cny += cost.cny;
      existing.inputCost = (existing.inputCost || 0) + cost.inputCost;
      existing.outputCost = (existing.outputCost || 0) + cost.outputCost;
      existing.cacheReadCost = (existing.cacheReadCost || 0) + cost.cacheReadCost;
      existing.cacheWriteCost = (existing.cacheWriteCost || 0) + cost.cacheWriteCost;
    } else {
      byModel.set(key, {
        modelKey: key,
        input,
        output,
        cacheRead,
        cacheWrite: 0,
        usd: cost.usd,
        cny: cost.cny,
        inputCost: cost.inputCost,
        outputCost: cost.outputCost,
        cacheReadCost: cost.cacheReadCost,
        cacheWriteCost: cost.cacheWriteCost,
      });
    }
  };

  const turns = usage.real?.turns || [];
  if (turns.length > 0) {
    for (const turn of turns) {
      const models = Object.entries(turn.modelUsage || {});
      if (models.length > 0) {
        for (const [mid, mu] of models) {
          const cacheRead = mu.cachedReadTokens || 0;
          const input = Math.max(0, (mu.inputTokens || 0) - cacheRead);
          const output = mu.outputTokens || 0;
          const modelId = normalizeGrokModelId(mid) || mid;
          pushDetail(modelId, input, output, cacheRead, mu.costUsdTicks, mu.modelCalls);
        }
      } else {
        const cacheRead = turn.cachedReadTokens || 0;
        const input = Math.max(0, (turn.inputTokens || 0) - cacheRead);
        const output = turn.outputTokens || 0;
        pushDetail('unknown', input, output, cacheRead, turn.costUsdTicks, turn.modelCalls);
      }
    }
  } else {
    const models = usage.modelUsage || {};
    const modelKeys = Object.keys(models);
    if (modelKeys.length > 0) {
      for (const mid of modelKeys) {
        const m: GrokPromptUsageModel = models[mid];
        const cacheRead = m.cachedReadTokens || 0;
        const input = Math.max(0, (m.inputTokens || 0) - cacheRead);
        const output = m.outputTokens || 0;
        const modelId = normalizeGrokModelId(mid) || mid;
        pushDetail(modelId, input, output, cacheRead, m.costUsdTicks, m.modelCalls);
      }
    } else if ((usage.total || 0) > 0 || (usage.input + usage.output + usage.cacheRead) > 0) {
      pushDetail(
        'unknown',
        usage.input,
        usage.output,
        usage.cacheRead,
        usage.costUsdTicks,
      );
    }
  }

  const details = Array.from(byModel.values());
  if (!details.length) return null;

  // session 级 ticks 优先（与 CLI 汇总一致；防切片累加浮点差）
  const sessionTicksUsd = ticksToUsd(usage.costUsdTicks ?? usage.real?.costUsdTicks);
  let usd = details.reduce((s, d) => s + d.usd, 0);
  let cny = details.reduce((s, d) => s + d.cny, 0);
  if (sessionTicksUsd != null && sessionTicksUsd >= 0 && usd > 0
    && Math.abs(sessionTicksUsd - usd) / Math.max(sessionTicksUsd, usd) > 1e-6) {
    const s = sessionTicksUsd / usd;
    usd = sessionTicksUsd;
    cny *= s;
    for (const d of details) {
      d.usd *= s;
      d.cny *= s;
      d.inputCost = (d.inputCost || 0) * s;
      d.outputCost = (d.outputCost || 0) * s;
      d.cacheReadCost = (d.cacheReadCost || 0) * s;
      d.cacheWriteCost = (d.cacheWriteCost || 0) * s;
    }
  }

  return { usd, cny, details };
}

function grokSessionInfoWithMessages(
  session: GrokSessionItem,
  messages: GrokMessageItem[],
  usage?: GrokSessionUsageSummary,
): UnifiedSessionInfo {
  const listExtras = buildGrokListExtras(messages, session.sessionId);
  const totalTool = messages.reduce((n, m) => n + (m.toolCalls?.length || 0), 0);
  const finalCtx = usage?.estimate?.finalContextTokens ?? 0;
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const lastCtx = lastAssistant?.contextTokens ?? finalCtx;
  const lastUnified = lastAssistant ? convertGrokMessage(lastAssistant, session.sessionId) : undefined;

  const unifiedMessages = messages.map(m => convertGrokMessage(m, session.sessionId));

  // session total：真实 usage 优先，否则 context 累加估算
  let total_tokens: number;
  let total_input: number;
  let total_output: number;
  let total_cache_read: number;
  let total_reasoning: number;
  let pricing: SessionPricing;

  // Performance：仅 real usage 有 apiDurationMs；TTFT 来自 streamStartMs→首 chunk 实测
  let timing: TimingSummary | undefined;
  if (usage?.usageSource === 'real') {
    total_tokens = usage.total;
    total_input = usage.input;
    total_output = usage.output;
    total_cache_read = usage.cacheRead;
    total_reasoning = usage.reasoning ?? 0;
    pricing = pricingFromGrokRealUsage(usage)
      ?? calculateSessionPricingFromUnifiedMessages(unifiedMessages);
    if (usage.real) {
      timing = timingFromGrokRealUsage(usage.real);
    }
  } else {
    const rawTotal = grokSumAssistantContextTokens(messages) || usage?.total || 0;
    const split = splitGrokContextTokens(rawTotal);
    total_tokens = split.total;
    total_input = split.input;
    total_output = split.output;
    total_cache_read = split.cacheRead;
    total_reasoning = split.reasoning;
    pricing = calculateSessionPricingFromUnifiedMessages(unifiedMessages);
  }

  // 从 parts 状态统计 tool 成功/失败
  let toolSuccess = 0;
  let toolFailed = 0;
  for (const um of unifiedMessages) {
    for (const part of um.parts || []) {
      if (part.type !== 'tool') continue;
      const status = (part as any).state?.status;
      if (status === 'completed') toolSuccess++;
      else if (status && ['failed', 'error'].includes(status)) toolFailed++;
    }
  }

  const models_used = collectGrokModelsUsed(messages, {
    sessionModelId: session.modelId,
    modelUsageKeys: usage?.modelUsage ? Object.keys(usage.modelUsage) : undefined,
  });

  const compactStats = deriveGrokCompactionStats(messages, session.sessionDir);
  const editDiffs = calculateEditDiffsFromGrokMessages(unifiedMessages);

  return {
    ...convertGrokSessionFromSummary(session),
    models_used,
    total_messages: messages.length,
    total_user_messages: listExtras.totalUserTurns,
    total_tool_calls: totalTool,
    total_tool_calls_success: toolSuccess,
    total_tool_calls_failed: toolFailed,
    total_tokens,
    total_input,
    total_output,
    total_cache_read,
    total_cache_write: 0,
    total_reasoning,
    last_message_tokens: lastCtx || undefined,
    max_context_tokens: maxContextFromUnifiedMessages(unifiedMessages) || undefined,
    last_message: lastUnified?.info,
    lastTokenInfo: buildLastTokenInfo(unifiedMessages),
    userParts: listExtras.userParts.length ? listExtras.userParts : undefined,
    textParts: listExtras.textParts.length ? listExtras.textParts : undefined,
    avg_msgs_per_user_msg: listExtras.avgMsgsPerUserMsg > 0 ? listExtras.avgMsgsPerUserMsg : undefined,
    project_worktree: session.workDir,
    pricing,
    usage_source: usage?.usageSource ?? 'estimate',
    // real token + 静态表计价视为完整；estimate token 拆分则 partial
    cost_is_partial: usage?.usageSource !== 'real',
    cost_missing_calls: undefined,
    avg_tps: timing?.avg_tps,
    assistant_tps_list: timing?.assistant_tps_list,
    avg_latency_ms: timing?.avg_latency_ms,
    latency_list: timing?.latency_list,
    editDiffs,
    summary_additions: editDiffs.additions,
    summary_deletions: editDiffs.deletions,
    summary_files: editDiffs.filesChanged,
    ...compactStats,
  };
}

async function getGrokSessionStats(session: GrokSessionItem, messages?: GrokMessageItem[]) {
  return getGrokSessionUsageSummary(session.sessionDir, messages, session.subagentMeta);
}

/** updates.jsonl timestamp 多为 unix 秒；>1e12 视为 ms */
function grokTsToMs(ts?: number | null, fallbackMs?: number): number {
  if (ts != null && Number.isFinite(ts) && ts > 0) {
    return ts < 1e12 ? ts * 1000 : ts;
  }
  return fallbackMs ?? Date.now();
}

type DayModelAgg = {
  modelKey: string;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
  cny: number;
};

/**
 * 用 turn_completed 真实 usage 按日聚合。
 * tokens 来自 wire；成本与 session pricing 同源（ticks 优先）。
 * message 级 usage_by_day 会严重低估（缺 cache / 仅 context 快照），不能用于 trend。
 */
export function buildUsageByDayFromGrokRealUsage(
  real: GrokRealUsage,
  fallbackMs?: number,
): UsageByDay[] {
  const byDay = new Map<string, {
    tokens: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    usd: number;
    cny: number;
    byModel: Map<string, DayModelAgg>;
  }>();

  const ensureDay = (date: string) => {
    let d = byDay.get(date);
    if (!d) {
      d = {
        tokens: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        usd: 0,
        cny: 0,
        byModel: new Map(),
      };
      byDay.set(date, d);
    }
    return d;
  };

  const addModel = (
    day: ReturnType<typeof ensureDay>,
    modelId: string,
    input: number,
    output: number,
    cacheRead: number,
    costUsdTicks?: number | null,
    modelCalls?: number,
  ) => {
    const modelKey = `xai/${modelId}`;
    const cost = costGrokUsageSlice({
      modelId,
      input,
      output,
      cacheRead,
      costUsdTicks,
      modelCalls,
    });
    const tokens = input + output + cacheRead;
    const usd = cost.usd;
    const cny = cost.cny;
    day.tokens += tokens;
    day.input += input;
    day.output += output;
    day.cacheRead += cacheRead;
    day.usd += usd;
    day.cny += cny;
    const m = day.byModel.get(modelKey) || {
      modelKey,
      tokens: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      usd: 0,
      cny: 0,
    };
    m.tokens += tokens;
    m.input += input;
    m.output += output;
    m.cacheRead += cacheRead;
    m.usd += usd;
    m.cny += cny;
    day.byModel.set(modelKey, m);
  };

  for (const turn of real.turns || []) {
    const date = dayjs(grokTsToMs(turn.timestamp, fallbackMs)).format('YYYY-MM-DD');
    const day = ensureDay(date);
    const models = Object.entries(turn.modelUsage || {});

    if (models.length > 0) {
      for (const [mid, mu] of models) {
        const cacheRead = mu.cachedReadTokens || 0;
        const input = Math.max(0, (mu.inputTokens || 0) - cacheRead);
        const output = mu.outputTokens || 0;
        const modelId = normalizeGrokModelId(mid) || mid;
        addModel(day, modelId, input, output, cacheRead, mu.costUsdTicks, mu.modelCalls);
      }
    } else {
      const cacheRead = turn.cachedReadTokens || 0;
      const input = Math.max(0, (turn.inputTokens || 0) - cacheRead);
      const output = turn.outputTokens || 0;
      addModel(day, 'unknown', input, output, cacheRead, turn.costUsdTicks, turn.modelCalls);
    }
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, agg]) => ({
      date,
      tokens: agg.tokens,
      input: agg.input,
      output: agg.output,
      cacheRead: agg.cacheRead,
      cacheWrite: agg.cacheWrite,
      usd: agg.usd,
      cny: agg.cny,
      byModel: Array.from(agg.byModel.values()),
    }));
}

/**
 * first_active 基准：Grok summary.created_at 可能是会话目录预创建/隔天使用的时间，
 * 早于真实活动（示例：created 08-17、全部消息 08-18，导致列表虚报「跨 2 天」）。
 * 有消息时优先首条消息墙钟；空会话/无有效消息时间才回退 createdAt。
 */
function resolveGrokFirstActiveMs(
  unifiedMessages: UnifiedMessage[],
  createdMs: number,
): number {
  let first = 0;
  for (const m of unifiedMessages) {
    const t = m.info?.time?.created;
    if (Number.isFinite(t) && t > 0 && (first === 0 || t < first)) first = t;
  }
  return first || createdMs;
}

export async function convertGrokSession(session: GrokSessionItem): Promise<UnifiedSessionInfo> {
  const messages = await listGrokCodeMessages({ sessionId: session.sessionId, sessionDir: session.sessionDir });
  const usage = await getGrokSessionStats(session, messages);
  const unifiedMessages = messages.map(m => convertGrokMessage(m, session.sessionId));
  const session_status = checkSessionStatus(unifiedMessages);
  const activity = buildActivitySpanFromUnifiedMessages(
    unifiedMessages,
    session.updatedAt,
    session.createdAt,
  );
  // last_active：summary 心跳会漂，优先 updates 最后 turn 墙钟；message 级墙钟见 attachGrokWallClockTimestamps
  const createdMs = session.createdAt || 0;
  let lastActivityMs = session.createdAt; // fallback：创建时间
  if (usage?.usageSource === 'real' && usage.real?.turns?.length) {
    const lastTurn = usage.real.turns[usage.real.turns.length - 1];
    if (lastTurn.timestamp) {
      lastActivityMs = grokTsToMs(lastTurn.timestamp, session.createdAt);
    }
  } else if (usage?.estimate?.turns?.length) {
    const lastEs = usage.estimate.turns[usage.estimate.turns.length - 1];
    if (lastEs.turnStartMs) lastActivityMs = lastEs.turnStartMs;
  }

  // real usage：按 turn 切日（与 session total/pricing 同源）；message 估算会低估
  const realByDay = usage?.usageSource === 'real' && usage.real?.turns?.length
    ? buildUsageByDayFromGrokRealUsage(
      usage.real,
      lastActivityMs || Date.parse(activity.last_active_at_iso),
    )
    : null;
  const usage_by_day = realByDay && realByDay.length > 0 ? realByDay : activity.usage_by_day;

  const firstActivityMs = resolveGrokFirstActiveMs(unifiedMessages, createdMs);
  const first_active_at_iso = firstActivityMs ? new Date(firstActivityMs).toISOString() : activity.first_active_at_iso;
  const last_active_at_iso = new Date(lastActivityMs).toISOString();
  const span_days = firstActivityMs && lastActivityMs
    ? Math.max(1, dayjs(lastActivityMs).startOf('day').diff(dayjs(firstActivityMs).startOf('day'), 'day') + 1)
    : activity.span_days;

  return {
    ...grokSessionInfoWithMessages(session, messages, usage),
    session_status,
    usage_is_incomplete: session_status === 'aborted' || session_status === 'error' || session_status === 'in-progress',
    first_active_at_iso,
    last_active_at_iso,
    last_active_at: last_active_at_iso,
    time_updated: lastActivityMs,
    span_days,
    usage_by_day,
    bashSignals: classifyBashCommands(extractBashCommands(unifiedMessages)),
    deliverableSignals: inferDeliverableSignals({ messages: unifiedMessages }),
  };
}

/** turn 趋势补全 deltaCost/endCost（ticks 优先，与 session pricing 同源） */
function enrichGrokTurnTrendsWithCost(
  raw: ReturnType<typeof buildGrokTrendsFromTurns>,
): TokenTrendPoint[] {
  let endCost = {
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0,
  };
  return raw.map((t) => {
    const modelID = t.modelId || 'grok-4.5';
    // turn 级 usage 已是多 call 累加；无 modelCalls 时用 prompt 总分档会偏高，有 ticks 则不受影响
    const cost = costGrokUsageSlice({
      modelId: modelID,
      input: t.delta.input,
      output: t.delta.output,
      cacheRead: t.delta.cacheRead,
      costUsdTicks: t.costUsdTicks,
      // msgCount 来自 turn.modelCalls
      modelCalls: t.msgCount || 1,
    });
    const deltaCost = {
      input: cost.inputCost,
      output: cost.outputCost,
      reasoning: 0,
      cacheRead: cost.cacheReadCost,
      cacheWrite: cost.cacheWriteCost,
      total: cost.usd,
    };
    endCost = {
      input: endCost.input + deltaCost.input,
      output: endCost.output + deltaCost.output,
      reasoning: 0,
      cacheRead: endCost.cacheRead + deltaCost.cacheRead,
      cacheWrite: endCost.cacheWrite + deltaCost.cacheWrite,
      total: endCost.total + deltaCost.total,
    };
    const { costUsdTicks: _t, modelId: _m, ...point } = t;
    return {
      ...point,
      deltaCost,
      endCost: { ...endCost },
    } satisfies TokenTrendPoint;
  });
}

export async function getGrokSessionDetail(sessionId: string): Promise<UnifiedSessionDetail | null> {
  const sessions = await listGrokCodeSessions();
  const session = sessions.find(s => s.sessionId === sessionId);
  if (!session) return null;

  const messages = await listGrokCodeMessages({ sessionId, sessionDir: session.sessionDir });
  const usage = await getGrokSessionStats(session, messages);
  const unifiedMessages = messages.map(m => convertGrokMessage(m, sessionId));
  const editDiffs = calculateEditDiffsFromGrokMessages(unifiedMessages);
  const session_status = checkSessionStatus(unifiedMessages);
  // last_active：summary 心跳会漂，优先 updates 最后 turn 墙钟
  const createdMs = session.createdAt || 0;
  let lastActivityMs = session.createdAt;
  if (usage?.usageSource === 'real' && usage.real?.turns?.length) {
    const lastTurn = usage.real.turns[usage.real.turns.length - 1];
    if (lastTurn.timestamp) {
      lastActivityMs = grokTsToMs(lastTurn.timestamp, session.createdAt);
    }
  } else if (usage?.estimate?.turns?.length) {
    const lastEs = usage.estimate.turns[usage.estimate.turns.length - 1];
    if (lastEs.turnStartMs) lastActivityMs = lastEs.turnStartMs;
  }
  const info: UnifiedSessionInfo = {
    ...grokSessionInfoWithMessages(session, messages, usage),
    session_status,
    bashSignals: classifyBashCommands(extractBashCommands(unifiedMessages)),
    deliverableSignals: inferDeliverableSignals({ messages: unifiedMessages }),
    usage_is_incomplete: session_status === 'aborted' || session_status === 'error' || session_status === 'in-progress',
  };
  // first_active：createdAt 可能为预创建，有消息时优先首条消息墙钟（与 convertGrokSession 同策略）
  const firstActivityMs = resolveGrokFirstActiveMs(unifiedMessages, createdMs);
  info.first_active_at_iso = new Date(firstActivityMs).toISOString();
  info.last_active_at_iso = new Date(lastActivityMs).toISOString();
  info.last_active_at = info.last_active_at_iso;
  info.span_days = Math.max(1, dayjs(lastActivityMs).startOf('day').diff(dayjs(firstActivityMs).startOf('day'), 'day') + 1);

  // 完整 turn 趋势（compact 前后，不依赖 chat_history prompt 桶）
  const trends = enrichGrokTurnTrendsWithCost(
    buildGrokTrendsFromTurns(usage.real, usage.estimate),
  );

  return {
    info,
    messages: unifiedMessages,
    editDiffs,
    pricing: info.pricing,
    trends: trends.length ? trends : undefined,
  };
}
