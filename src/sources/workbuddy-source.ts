/**
 * WorkBuddy → OpenCode 统一协议转换
 * 主数据: ~/.workbuddy/workbuddy.db + projects/<hash>/<sessionId>.jsonl
 * per-call token/credit: providerData.rawUsage
 */

import path from 'path';
import {
  listWorkbuddySessions,
  getWorkbuddySession,
  readWorkbuddyJsonl,
  readWorkbuddySubagentJsonl,
  tokensFromRawUsage,
  normalizeWorkbuddyModel,
  listWorkbuddyWorkspacePaths,
  listWorkbuddySubagentsFromMainJsonl,
  parseWorkbuddyVirtualSessionId,
  parseWorkbuddyAgentIdFromResult,
  buildWorkbuddySubagentSessionId,
  findWorkbuddySubagentJsonlPath,
  type WorkbuddySessionItem,
  type WorkbuddyJsonlEvent,
  type WorkbuddyRawUsage,
  type WorkbuddySubagentMeta,
} from './workbuddy-code';import { checkSessionStatus } from './opencode';
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

// ==================== 文本提取 ====================

/** WorkBuddy 用户消息常被 system-reminder 包裹，优先取 <user_query> */
function extractUserQuery(raw: string): string {
  if (!raw) return '';
  const re = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi;
  const chunks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const t = (m[1] || '').trim();
    if (t) chunks.push(t);
  }
  if (chunks.length) return chunks.join('\n\n');
  // 无 user_query 时去掉 system-reminder 块
  const stripped = raw.replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, '').trim();
  return stripped || raw;
}

function extractTextFromContent(content: any, opts?: { userQueryOnly?: boolean }): string {
  if (!content) return '';
  if (typeof content === 'string') {
    return opts?.userQueryOnly ? extractUserQuery(content) : content;
  }
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (!c) continue;
    if (typeof c === 'string') {
      parts.push(c);
      continue;
    }
    if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text' || c.type === 'reasoning_text') {
      if (c.text) parts.push(String(c.text));
    } else if (c.text) {
      parts.push(String(c.text));
    }
  }
  const joined = parts.join('\n');
  return opts?.userQueryOnly ? extractUserQuery(joined) : joined;
}

function extractReasoningText(ev: WorkbuddyJsonlEvent): string {
  if (ev.rawContent) {
    const t = extractTextFromContent(ev.rawContent);
    if (t) return t;
  }
  const t = extractTextFromContent(ev.content);
  if (t) return t;
  const pd = ev.providerData;
  if (pd?.reasoning && typeof pd.reasoning === 'string') return pd.reasoning;
  return '';
}

function parseArgs(raw: string | Record<string, any> | undefined): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

// ==================== JSONL → UnifiedMessages ====================

/**
 * 将 jsonl 事件流转为 OpenCode 风格 messages。
 * 分组：user message 独立；assistant 按 providerData.messageId 聚合
 * （reasoning + assistant text + function_call + result = 一次 sub-LLM-call）
 */
export function convertWorkbuddyEventsToMessages(
  sessionId: string,
  events: WorkbuddyJsonlEvent[],
  fallbackCwd?: string,
  fallbackModel?: string,
): UnifiedMessage[] {
  type ToolPending = {
    callId: string;
    name: string;
    input: Record<string, any>;
    id: string;
    timestamp?: number;
  };
  type AsstGroup = {
    messageId: string;
    ts: number;
    model?: string;
    requestModelName?: string;
    reasoningTexts: string[];
    textParts: string[];
    tools: ToolPending[];
    results: Map<string, { status: string; output: any; timestamp?: number; agentId?: string }>;
    rawUsage?: WorkbuddyRawUsage;
    cwd?: string;
    /** 事件层 parentId（常指向 reasoning / 上一条），用于回链 user */
    eventParentId?: string;
  };

  const messages: UnifiedMessage[] = [];
  const asstById = new Map<string, AsstGroup>();
  const asstOrder: string[] = [];
  /** callId → messageId */
  const callToMsg = new Map<string, string>();

  const ensureAsst = (messageId: string, ev: WorkbuddyJsonlEvent): AsstGroup => {
    let g = asstById.get(messageId);
    if (!g) {
      const pd = ev.providerData || {};
      g = {
        messageId,
        ts: ev.timestamp || 0,
        model: pd.model || pd.requestModelId,
        requestModelName: pd.requestModelName,
        reasoningTexts: [],
        textParts: [],
        tools: [],
        results: new Map(),
        cwd: ev.cwd,
        eventParentId: ev.parentId,
      };
      asstById.set(messageId, g);
      asstOrder.push(messageId);
    } else {
      if (ev.timestamp && (!g.ts || ev.timestamp < g.ts)) g.ts = ev.timestamp;
      const pd = ev.providerData || {};
      if (!g.model && (pd.model || pd.requestModelId)) g.model = pd.model || pd.requestModelId;
      if (!g.requestModelName && pd.requestModelName) g.requestModelName = pd.requestModelName;
      if (!g.cwd && ev.cwd) g.cwd = ev.cwd;
      // 优先保留更靠上的 parent（reasoning 常 parent→user）
      if (!g.eventParentId && ev.parentId) g.eventParentId = ev.parentId;
    }
    return g;
  };

  // id → 事件，用于 parent 链回 user
  const eventById = new Map<string, WorkbuddyJsonlEvent>();
  for (const ev of events) {
    if (ev.id) eventById.set(ev.id, ev);
  }

  const resolveUserParentId = (startParentId: string | undefined, fallbackUserId?: string): string | undefined => {
    let cur = startParentId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const ev = eventById.get(cur);
      if (!ev) break;
      if (ev.type === 'message' && ev.role === 'user') return ev.id || cur;
      cur = ev.parentId;
    }
    return fallbackUserId;
  };

  // 先扫一遍：user 立即入列（保持时间序用占位），assistant 聚合
  type Pending =
    | { kind: 'user'; id: string; ts: number; text: string; cwd?: string }
    | { kind: 'asst'; messageId: string; order: number };

  const pending: Pending[] = [];
  let asstSeq = 0;

  for (const ev of events) {
    const type = ev.type;
    if (type === 'file-history-snapshot' || type === 'ai-title') continue;

    if (type === 'message' && ev.role === 'user') {
      const text = extractTextFromContent(ev.content, { userQueryOnly: true });
      pending.push({
        kind: 'user',
        id: ev.id || `user-${ev.timestamp || pending.length}`,
        ts: ev.timestamp || 0,
        text,
        cwd: ev.cwd,
      });
      continue;
    }

    const pd = ev.providerData || {};
    const messageId = pd.messageId || (type === 'message' && ev.role === 'assistant' ? ev.id : undefined);
    if (!messageId) continue;

    const g = ensureAsst(messageId, ev);
    if (pd.rawUsage) g.rawUsage = pd.rawUsage;

    if (type === 'reasoning') {
      const t = extractReasoningText(ev);
      if (t) g.reasoningTexts.push(t);
    } else if (type === 'message' && ev.role === 'assistant') {
      const t = extractTextFromContent(ev.content);
      if (t) g.textParts.push(t);
      // 首次见到 assistant message 时记入顺序
      if (!pending.some((p) => p.kind === 'asst' && p.messageId === messageId)) {
        pending.push({ kind: 'asst', messageId, order: asstSeq++ });
      }
    } else if (type === 'function_call') {
      const callId = ev.callId || ev.id || `call-${g.tools.length}`;
      callToMsg.set(callId, messageId);
      g.tools.push({
        callId,
        name: ev.name || 'unknown',
        input: parseArgs(ev.arguments),
        id: ev.id || callId,
        timestamp: ev.timestamp,
      });
      if (!pending.some((p) => p.kind === 'asst' && p.messageId === messageId)) {
        pending.push({ kind: 'asst', messageId, order: asstSeq++ });
      }
    } else if (type === 'function_call_result') {
      const callId = ev.callId || ev.parentId || '';
      const mid = callToMsg.get(callId) || messageId;
      const target = asstById.get(mid) || g;
      let outputText = '';
      if (ev.output) {
        if (typeof ev.output === 'string') outputText = ev.output;
        else if (ev.output.text) outputText = String(ev.output.text);
        else outputText = JSON.stringify(ev.output);
      } else if (pd.toolResult?.content) {
        outputText = String(pd.toolResult.content);
      }
      const agentId = parseWorkbuddyAgentIdFromResult(ev);
      target.results.set(callId, {
        status: ev.status || 'completed',
        output: outputText,
        timestamp: ev.timestamp,
        agentId,
      });
    }
  }

  // 若有仅出现在 function_call 的 asst group 未进 pending，补上
  for (const mid of asstOrder) {
    if (!pending.some((p) => p.kind === 'asst' && p.messageId === mid)) {
      pending.push({ kind: 'asst', messageId: mid, order: asstSeq++ });
    }
  }

  const buildUser = (p: Extract<Pending, { kind: 'user' }>): UnifiedMessage => ({
    info: {
      id: p.id,
      sessionID: sessionId,
      role: 'user',
      time: { created: p.ts },
      path: { cwd: p.cwd || fallbackCwd || '', root: '' },
    } as any,
    parts: p.text
      ? [{ id: `${p.id}-text`, type: 'text', text: p.text, sessionID: sessionId, messageID: p.id } as any]
      : [],
  });

  const buildAsst = (messageId: string, parentID?: string): UnifiedMessage => {
    const g = asstById.get(messageId)!;
    const model = normalizeWorkbuddyModel(g.model || fallbackModel, g.requestModelName);
    const tok = tokensFromRawUsage(g.rawUsage);
    const created = g.ts || 0;
    const resolvedParent =
      parentID
      || resolveUserParentId(g.eventParentId);

    const parts: any[] = [];
    let partIdx = 0;

    for (const r of g.reasoningTexts) {
      parts.push({
        id: `${messageId}-r${partIdx++}`,
        type: 'reasoning',
        text: r,
        sessionID: sessionId,
        messageID: messageId,
      });
    }
    for (const t of g.textParts) {
      parts.push({
        id: `${messageId}-t${partIdx++}`,
        type: 'text',
        text: t,
        sessionID: sessionId,
        messageID: messageId,
      });
    }

    // 按 callId 去重 tools（同一 call 可能重复）
    const seenCalls = new Set<string>();
    const rootId = parseWorkbuddyVirtualSessionId(sessionId).rootSessionId;
    for (const tool of g.tools) {
      if (seenCalls.has(tool.callId)) continue;
      seenCalls.add(tool.callId);
      const result = g.results.get(tool.callId);
      const status = result?.status === 'failed' || result?.status === 'error'
        ? 'error'
        : result
          ? 'completed'
          : 'completed';
      const toolNameNorm = (tool.name || '').toLowerCase().replace(/[_-]/g, '');
      let metadata: Record<string, any> | undefined;
      if (toolNameNorm === 'agent') {
        const agentId = result?.agentId
          || parseWorkbuddyAgentIdFromResult({ output: result?.output });
        if (agentId) {
          const virtualSessionId = buildWorkbuddySubagentSessionId(rootId, agentId);
          const outcome = status === 'error' ? 'failed' : result ? 'completed' : 'started';
          metadata = {
            kind: 'agent',
            sessionId: virtualSessionId,
            agents: [{
              agentDir: agentId,
              item: String(tool.input?.description || '').trim() || undefined,
              outcome,
              virtualSessionId,
            }],
            summary: {
              completed: outcome === 'completed' ? 1 : 0,
              failed: outcome === 'failed' ? 1 : 0,
              aborted: 0,
              started: outcome === 'started' ? 1 : 0,
              total: 1,
            },
          };
        }
      }
      parts.push({
        id: tool.id,
        type: 'tool',
        tool: tool.name,
        callID: tool.callId,
        sessionID: sessionId,
        messageID: messageId,
        state: {
          status,
          input: tool.input,
          output: result?.output,
          title: tool.input?.description || tool.name,
          time: tool.timestamp
            ? { start: tool.timestamp, end: result?.timestamp || tool.timestamp }
            : undefined,
          ...(metadata ? { metadata } : {}),
        },
      });
    }

    const messageInfo: any = {
      id: messageId,
      sessionID: sessionId,
      role: 'assistant',
      parentID: resolvedParent,
      time: { created, completed: created },
      path: { cwd: g.cwd || fallbackCwd || '', root: '' },
      model,
      providerID: model.providerID,
      modelID: model.modelID,
    };

    if (tok) {
      messageInfo.tokens = {
        total: tok.total,
        input: tok.input,
        output: tok.output,
        reasoning: tok.reasoning,
        cache: { read: tok.cacheRead, write: tok.cacheWrite },
        context: {
          total: tok.input + tok.cacheRead,
          input: tok.input,
          cacheRead: tok.cacheRead,
        },
      };
      if (tok.credit != null) {
        messageInfo.workbuddyCredit = tok.credit;
      }
    }

    return { info: messageInfo, parts };
  };

  let lastUserId: string | undefined;
  let lastMsgId: string | undefined;
  for (const p of pending) {
    if (p.kind === 'user') {
      messages.push(buildUser(p));
      lastUserId = p.id;
      lastMsgId = p.id;
    } else if (asstById.has(p.messageId)) {
      // parentID 必须能链到 user，否则 getOverallStats 的 groupMessagesByUser 挂不上 → trends 空
      const parentID = lastUserId || lastMsgId;
      messages.push(buildAsst(p.messageId, parentID));
      lastMsgId = p.messageId;
    }
  }

  return messages;
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
      if (!['edit', 'write', 'multiedit', 'multi_edit', 'strreplace', 'applypatch'].includes(name)) continue;

      const state = typeof part.state === 'object' && part.state ? part.state : {};
      const input = (state as any).input || {};
      const metadata = (state as any).metadata || {};
      const filediff = metadata.filediff || {};

      let additions = filediff.additions || 0;
      let deletions = filediff.deletions || 0;
      let filePath =
        filediff.path
        || input.path
        || input.file_path
        || input.filePath
        || (state as any).title
        || '';

      if ((name === 'write' || name === 'edit') && !additions) {
        const content = input.content || input.new_string || input.newString;
        if (content) additions = String(content).split('\n').length;
      }
      if ((name === 'edit' || name === 'strreplace') && !deletions) {
        const old = input.old_string || input.oldString;
        if (old) deletions = String(old).split('\n').length;
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

function loadUnifiedMessages(session: WorkbuddySessionItem): UnifiedMessage[] {
  const events = readWorkbuddyJsonl(session.sessionId, session.jsonlPath);
  return convertWorkbuddyEventsToMessages(session.sessionId, events, session.cwd, session.model);
}

/**
 * 每次 LLM call 时长采样。
 * workbuddy jsonl 只在 call 结束后批量 flush 事件（无原生 TTFT 原料），
 * 旧口径 user→首步 flush 会把首步全量 decode 算进 latency，严重虚高。
 * 新口径逐 call 采样：
 * - anchor = user 发送 ts（首步）/ 上一步最后一个 tool result ts（后续步，剔除工具执行时间）
 * - stepMs = 本步 assistant created（组内最早事件 ts）- anchor
 * 语义为「单次 LLM call 总时长」近似（排队 + prefill + 该步全量 decode）。
 */
export function collectWorkbuddyStepSamples(messages: UnifiedMessage[]): Array<{
  msgId: string;
  stepMs: number;
  outputTokens: number;
}> {
  const samples: Array<{ msgId: string; stepMs: number; outputTokens: number }> = [];
  let anchorTs: number | null = null;

  for (const um of messages) {
    const role = um.info.role;
    const created = um.info.time?.created || 0;

    if (role === 'user') {
      if (created) anchorTs = created;
      continue;
    }
    if (role !== 'assistant' || !created) continue;

    // 本步最后一个 tool result ts：作为下一步 call 起点锚（剔除工具执行时间）
    let lastResultTs = 0;
    for (const part of um.parts || []) {
      if (part.type !== 'tool') continue;
      const endTs = (part.state as any)?.time?.end;
      if (typeof endTs === 'number' && endTs > lastResultTs) lastResultTs = endTs;
    }

    const stepMs = anchorTs != null && created > anchorTs ? created - anchorTs : 0;
    const tokens = um.info.tokens;
    samples.push({
      msgId: String(um.info.id ?? ''),
      stepMs,
      outputTokens: (tokens?.output || 0) + (tokens?.reasoning || 0),
    });
    anchorTs = Math.max(created, lastResultTs);
  }

  return samples;
}

async function getWorkbuddySessionStats(
  session: WorkbuddySessionItem,
  preloaded?: UnifiedMessage[],
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
    total_credits: number;
    creditsByModel: Record<string, number>;
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
    total_credits: 0,
    creditsByModel: {},
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
    const unifiedMessages = preloaded || loadUnifiedMessages(session);
    stats.total_messages = unifiedMessages.length;

    const models = new Set<string>();
    const textParts: any[] = [];
    const timingLists = createTimingLists();
    // 逐 LLM call 时长采样（口径见 collectWorkbuddyStepSamples 注释）
    for (const s of collectWorkbuddyStepSamples(unifiedMessages)) {
      pushAssistantTimingSample(timingLists, {
        latencyMs: s.stepMs,
        outputTokens: s.outputTokens,
        decodeDurationMs: s.stepMs > 0 ? s.stepMs : undefined,
        // 不传 inputTokens：步时长≠prefill 时间，不造假 prefill_tps（与 grok 口径一致）
      });
    }

    for (const um of unifiedMessages) {
      const role = um.info.role;
      const created = um.info.time?.created || 0;

      if (role === 'user') {
        stats.total_user_messages++;
      }

      for (const part of um.parts || []) {
        if (part.type === 'tool') {
          stats.total_tool_calls++;
          const st = (part.state as any)?.status;
          if (st === 'completed') stats.total_tool_calls_success++;
          else if (st === 'failed' || st === 'error') stats.total_tool_calls_failed++;
        }
      }

      if (um.info.tokens) {
        stats.total_input += um.info.tokens.input || 0;
        stats.total_output += um.info.tokens.output || 0;
        stats.total_reasoning += um.info.tokens.reasoning || 0;
        stats.total_cache_read += um.info.tokens.cache?.read || 0;
        stats.total_cache_write += um.info.tokens.cache?.write || 0;
      }
      const credit = (um.info as any).workbuddyCredit;
      if (typeof credit === 'number') {
        stats.total_credits += credit;
        const creditModel = um.info.modelID || um.info.model?.modelID || 'unknown';
        stats.creditsByModel[creditModel] = (stats.creditsByModel[creditModel] || 0) + credit;
      }

      const modelKey = um.info.modelID || um.info.model?.modelID;
      if (modelKey && modelKey !== 'unknown') models.add(modelKey);

      const texts = (um.parts || [])
        .filter((p) => p.type === 'text' || p.type === 'reasoning')
        .map((p) => (p as any).text)
        .filter(Boolean);
      if (texts.length) {
        textParts.push({
          role,
          text: texts.join('\n'),
          tool: '',
          duration: 0,
          startTime: created,
          endTime: created,
        });
      }

    }

    stats.total_tokens = stats.total_input + stats.total_cache_read + stats.total_output;
    stats.models_used = Array.from(models).join(',') || (session.model
      ? normalizeWorkbuddyModel(session.model).modelID
      : '');
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
    const maxFromMsgs = maxContextFromUnifiedMessages(unifiedMessages);
    const max_context_tokens = maxFromMsgs || session.contextSize || undefined;

    return {
      stats: {
        ...stats,
        total_user_messages: userParts.length || stats.total_user_messages,
        last_message,
        last_message_tokens,
        max_context_tokens,
        textParts: textParts.length > 0 ? textParts : undefined,
        userParts: userParts.length > 0 ? userParts : undefined,
        ...timingSummary,
      },
      unifiedMessages,
      pricing,
    };
  } catch (e) {
    console.warn(`[ai-coding-stats] 获取 WorkBuddy session 统计失败: ${session.sessionId}`, e);
    return { stats, unifiedMessages: [], pricing: { usd: 0, cny: 0 } };
  }
}

// ==================== 导出 ====================

const DATETIME_DIR_PATTERN = /^(\d{4}-\d{2}-\d{2}([_-]\d+){0,3})$/;
const UUID_DIR_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH_DIR_PATTERN = /^[a-f0-9]{16,}$/i;

function isSessionLikeDirName(name: string): boolean {
  return DATETIME_DIR_PATTERN.test(name) || UUID_DIR_PATTERN.test(name) || HASH_DIR_PATTERN.test(name);
}

function deriveProjectName(cwd: string): string {
  const base = path.basename(cwd) || cwd;
  if (!isSessionLikeDirName(base)) return base;
  // 取父目录名作为项目名（一个项目下可能有多个会话子目录）
  const parent = path.basename(path.dirname(cwd));
  return parent || base;
}

function resolveWorkbuddyProjectFields(session: WorkbuddySessionItem): {
  projectName?: string;
  projectRoot?: string;
} {
  const workspacePaths = new Set(listWorkbuddyWorkspacePaths());
  const isDefaultWorkspace = session.cwd ? workspacePaths.has(session.cwd) : false;

  const projectName = isDefaultWorkspace
    ? 'WorkBuddy默认'
    : session.cwd
      ? deriveProjectName(session.cwd)
      : session.projectId || undefined;
  // cwd basename 像日期/UUID/长 hash 时，把 project_id 提到父目录，
  // 让多个会话在 aggregateByProject 合并到同一项目切片
  const projectRoot = isDefaultWorkspace
    ? session.cwd
    : session.cwd
      ? (isSessionLikeDirName(path.basename(session.cwd))
          ? path.dirname(session.cwd)
          : session.cwd)
      : undefined;
  return { projectName, projectRoot };
}

export async function convertWorkbuddySession(
  session: WorkbuddySessionItem,
  preloaded?: UnifiedMessage[],
): Promise<UnifiedSessionInfo> {
  const { stats, unifiedMessages, pricing } = await getWorkbuddySessionStats(session, preloaded);
  const session_status = session.status === 'working'
    ? 'in-progress' as const
    : session.status === 'completed'
      ? checkSessionStatus(unifiedMessages)
      : checkSessionStatus(unifiedMessages);

  const activity = buildActivitySpanFromUnifiedMessages(
    unifiedMessages,
    session.updatedAt,
    session.createdAt,
  );

  const { projectName, projectRoot } = resolveWorkbuddyProjectFields(session);

  return {
    id: session.sessionId,
    project_id: session.projectId || projectRoot || session.cwd || '',
    parent_id: undefined,
    slug: session.sessionId,
    directory: session.cwd,
    title: session.title,
    version: session.mode || 'unknown',
    time_created: session.createdAt,
    time_updated: session.updatedAt,
    project_name: projectName,
    project_worktree: projectRoot,

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
    // DB credit 滞后；jsonl 汇总优先
    cost_is_partial: stats.total_credits === 0 && (session.dbCredits ?? 0) > 0 ? true : undefined,
    total_credits: stats.total_credits || undefined,
    meta: {
      workbuddy: {
        totalCredits: stats.total_credits || 0,
        creditsByModel: stats.creditsByModel,
        dbCredits: session.dbCredits ?? null,
      },
    },

    source: 'workbuddy',
  };
}

function loadSubagentUnifiedMessages(
  parent: WorkbuddySessionItem,
  meta: WorkbuddySubagentMeta,
): UnifiedMessage[] {
  const events = readWorkbuddySubagentJsonl(parent.sessionId, meta.agentId, meta.jsonlPath);
  return convertWorkbuddyEventsToMessages(
    meta.virtualSessionId,
    events,
    parent.cwd,
    parent.model,
  );
}

export async function convertWorkbuddySubagentSession(
  parent: WorkbuddySessionItem,
  meta: WorkbuddySubagentMeta,
  preloaded?: UnifiedMessage[],
): Promise<UnifiedSessionInfo> {
  const unifiedMessages = preloaded || loadSubagentUnifiedMessages(parent, meta);
  const pseudo: WorkbuddySessionItem = {
    ...parent,
    sessionId: meta.virtualSessionId,
    title: meta.description
      ? `${meta.subagentType}: ${meta.description}`
      : `${meta.subagentType} (${meta.agentId})`,
    jsonlPath: meta.jsonlPath,
    // subagent 状态不写 DB；用 outcome 近似
    status: meta.outcome === 'started' || meta.outcome === 'running'
      ? 'working'
      : meta.outcome === 'failed'
        ? 'error'
        : 'completed',
  };
  const { stats, pricing } = await getWorkbuddySessionStats(pseudo, unifiedMessages);

  let session_status = checkSessionStatus(unifiedMessages);
  if (meta.outcome === 'failed') session_status = 'error';
  else if (meta.outcome === 'aborted') session_status = 'aborted';
  else if (meta.outcome === 'started' || meta.outcome === 'running') session_status = 'in-progress';

  const activity = buildActivitySpanFromUnifiedMessages(
    unifiedMessages,
    parent.updatedAt,
    parent.createdAt,
  );
  const time_updated = activity.last_active_at_iso
    ? new Date(activity.last_active_at_iso).getTime()
    : parent.updatedAt;
  const time_created = activity.first_active_at_iso
    ? new Date(activity.first_active_at_iso).getTime()
    : parent.createdAt;

  const { projectName, projectRoot } = resolveWorkbuddyProjectFields(parent);
  const title = meta.description
    ? `${meta.subagentType}: ${meta.description}`
    : `${meta.subagentType} (${meta.agentId})`;

  const subDir = meta.jsonlPath
    ? path.dirname(meta.jsonlPath)
    : path.join(parent.cwd || '', 'subagents', meta.agentId);

  return {
    id: meta.virtualSessionId,
    project_id: parent.projectId || projectRoot || parent.cwd || '',
    parent_id: meta.parentSessionId,
    spawn_group_id: meta.spawnGroupId || meta.toolCallId || undefined,
    slug: meta.virtualSessionId,
    directory: subDir,
    title,
    version: parent.mode || 'unknown',
    time_created,
    time_updated,
    project_name: projectName,
    project_worktree: projectRoot,

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
    total_credits: stats.total_credits || undefined,
    meta: {
      workbuddy: {
        totalCredits: stats.total_credits || 0,
        creditsByModel: stats.creditsByModel,
        dbCredits: parent.dbCredits ?? null,
      },
    },

    source: 'workbuddy',
  };
}

export async function getWorkbuddySessionDetail(sessionId: string): Promise<UnifiedSessionDetail | null> {
  const parsed = parseWorkbuddyVirtualSessionId(sessionId);

  if (parsed.agentId) {
    const parent = await getWorkbuddySession(parsed.rootSessionId);
    if (!parent) return null;
    const metas = listWorkbuddySubagentsFromMainJsonl(parent);
    let meta = metas.find((m) => m.agentId === parsed.agentId);
    if (!meta) {
      // 磁盘有 jsonl 但 main 未挂到：兜底
      const jsonlPath = findWorkbuddySubagentJsonlPath(parsed.rootSessionId, parsed.agentId, parent.jsonlPath);
      if (!jsonlPath) return null;
      meta = {
        virtualSessionId: buildWorkbuddySubagentSessionId(parsed.rootSessionId, parsed.agentId),
        parentSessionId: parsed.rootSessionId,
        agentId: parsed.agentId,
        toolCallId: `disk:${parsed.agentId}`,
        subagentType: 'general-purpose',
        description: parsed.agentId,
        outcome: 'completed',
        jsonlPath,
      };
    }
    const unifiedMessages = loadSubagentUnifiedMessages(parent, meta);
    const editDiffs = calculateEditDiffs(unifiedMessages);
    const pricing = calculateSessionPricingFromUnifiedMessages(unifiedMessages);
    const info = await convertWorkbuddySubagentSession(parent, meta, unifiedMessages);
    return {
      info: { ...info, pricing },
      messages: unifiedMessages,
      editDiffs,
      pricing,
    };
  }

  const session = await getWorkbuddySession(parsed.rootSessionId);
  if (!session) return null;

  const unifiedMessages = loadUnifiedMessages(session);
  const editDiffs = calculateEditDiffs(unifiedMessages);
  const pricing = calculateSessionPricingFromUnifiedMessages(unifiedMessages);
  const info = await convertWorkbuddySession(session, unifiedMessages);

  return {
    info: { ...info, pricing },
    messages: unifiedMessages,
    editDiffs,
    pricing,
  };
}

export { listWorkbuddySessions, listWorkbuddySubagentsFromMainJsonl };
