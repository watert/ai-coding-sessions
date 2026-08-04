/**
 * Cursor → OpenCode 统一协议
 *
 * 消息主源：cursorDiskKV bubble（含 toolFormerData）
 * transcript JSONL 仅补漏（无 bubble 时）
 * usage：bubble.tokenCount 优先；否则 estimate；多数 session 无 billed token
 */

import path from 'path';
import {
  listCursorSessions,
  getCursorSession,
  getCursorComposerData,
  getCursorBubbles,
  readCursorTranscript,
  normalizeCursorToolName,
  parseCursorToolParams,
  cursorToolResultText,
  type CursorSessionItem,
  type CursorBubble,
  type CursorComposerData,
  type CursorTranscriptLine,
} from './cursor-code';
import { checkSessionStatus } from './opencode';
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

// ==================== 文本 ====================

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
  // 去掉 timestamp 包装
  const noTs = raw.replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/gi, '').trim();
  return noTs || raw;
}

function bubbleTsMs(b: CursorBubble): number {
  if (!b.createdAt) return 0;
  if (typeof b.createdAt === 'number') return b.createdAt;
  const n = Date.parse(String(b.createdAt));
  return Number.isFinite(n) ? n : 0;
}

function normalizeModel(raw?: string | null): { providerID: string; modelID: string } {
  const id = (raw || 'default').trim() || 'default';
  if (id.includes('/')) {
    const [providerID, ...rest] = id.split('/');
    return { providerID: providerID || 'cursor', modelID: rest.join('/') || id };
  }
  // Cursor 订阅模型常记为 default / auto
  if (id === 'default' || id === 'auto') {
    return { providerID: 'cursor', modelID: id };
  }
  return { providerID: 'cursor', modelID: id };
}

function toolInputFromFormer(tf: NonNullable<CursorBubble['toolFormerData']>): Record<string, any> {
  const fromParams = parseCursorToolParams(tf.params);
  if (Object.keys(fromParams).length) {
    // Shell 类：统一 command 字段
    if (fromParams.command != null) return fromParams;
    const name = normalizeCursorToolName(tf.name);
    if (name === 'Read' && fromParams.targetFile && !fromParams.path) {
      return { ...fromParams, path: fromParams.targetFile };
    }
    if (name === 'Glob' && fromParams.globPattern && !fromParams.pattern) {
      return { ...fromParams, pattern: fromParams.globPattern };
    }
    return fromParams;
  }
  return parseCursorToolParams(tf.rawArgs);
}

function toolStatus(tf: NonNullable<CursorBubble['toolFormerData']>): 'completed' | 'error' {
  const s = String(tf.status || '').toLowerCase();
  if (s === 'error' || s === 'failed' || s === 'cancelled' || s === 'canceled') return 'error';
  const result = tf.result;
  if (typeof result === 'string') {
    try {
      const p = JSON.parse(result);
      if (p?.rejected || p?.error) return 'error';
    } catch {
      /* ignore */
    }
  } else if (result && typeof result === 'object') {
    if ((result as any).rejected || (result as any).error) return 'error';
  }
  const ad = tf.additionalData;
  if (ad && String(ad.status || '').toLowerCase() === 'error') return 'error';
  return 'completed';
}

// ==================== bubbles → messages ====================

/** 从 bubble 抽 thinking 正文 */
export function extractCursorThinkingText(b: CursorBubble): string {
  const t = b.thinking;
  if (typeof t === 'string' && t.trim()) return t.trim();
  if (t && typeof t === 'object' && typeof (t as any).text === 'string') {
    return String((t as any).text).trim();
  }
  // allThinkingBlocks 偶发
  const blocks = (b as any).allThinkingBlocks;
  if (Array.isArray(blocks) && blocks.length) {
    const parts: string[] = [];
    for (const bl of blocks) {
      if (typeof bl === 'string' && bl.trim()) parts.push(bl.trim());
      else if (bl?.text) parts.push(String(bl.text).trim());
    }
    if (parts.length) return parts.join('\n');
  }
  return '';
}

/**
 * 是否为 thinking step 边界 bubble（Cursor UI "Thought for Xs"）
 * capabilityType 30 / grouping.hasThinking / 有 thinking 正文
 */
export function isCursorThinkingBubble(b: CursorBubble): boolean {
  if (b.type === 1) return false;
  if (b.capabilityType === 30 || b.grouping?.capabilityType === 30) return true;
  if (b.grouping?.hasThinking) return true;
  if (extractCursorThinkingText(b)) return true;
  // 仅有 thinkingDurationMs、无 text/tool 的空壳也算（UI 仍显示 Thought）
  if (
    (b.thinkingDurationMs != null || b.grouping?.thinkingDurationMs != null) &&
    !(b.text && String(b.text).trim()) &&
    !(b.toolFormerData?.name)
  ) {
    return true;
  }
  return false;
}

function isCursorToolBubble(b: CursorBubble): boolean {
  const tf = b.toolFormerData;
  return !!(tf && (tf.name || tf.params || tf.rawArgs || tf.result));
}

/**
 * Cursor bubbles → 多条 assistant step（对齐 UI 轮次）
 *
 * 边界：
 * - type=1 → user
 * - thinking bubble（capabilityType=30）→ 新 assistant step 起手（reasoning part）
 * - 随后 tool / text 归入当前 step，直到下一个 thinking
 * - 无 thinking 仅 tool/text 时也开 step
 *
 * 旧实现把整段 type=2 合成一条，丢失 Thought 与中间轮次。
 */
export function convertCursorBubblesToMessages(
  sessionId: string,
  bubbles: CursorBubble[],
  opts?: {
    fallbackCwd?: string;
    fallbackModel?: string;
  },
): UnifiedMessage[] {
  const messages: UnifiedMessage[] = [];
  const fallbackCwd = opts?.fallbackCwd || '';
  const fallbackModel = opts?.fallbackModel || 'default';

  type AsstAcc = {
    id: string;
    created: number;
    completed: number;
    modelName?: string;
    reasonings: Array<{ text: string; durationMs?: number }>;
    texts: string[];
    tools: Array<{
      id: string;
      callId: string;
      name: string;
      input: Record<string, any>;
      output: string;
      status: 'completed' | 'error';
      start?: number;
      end?: number;
    }>;
    inputTokens: number;
    outputTokens: number;
  };

  let lastUserId: string | undefined;
  let asst: AsstAcc | null = null;

  const flushAsst = () => {
    if (!asst) return;
    if (!asst.texts.length && !asst.tools.length && !asst.reasonings.length) {
      asst = null;
      return;
    }
    const model = normalizeModel(asst.modelName || fallbackModel);
    const parts: any[] = [];
    let pi = 0;
    for (const r of asst.reasonings) {
      parts.push({
        id: `${asst.id}-r${pi++}`,
        type: 'reasoning',
        text: r.text,
        sessionID: sessionId,
        messageID: asst.id,
        // 可选：duration 供 UI
        ...(r.durationMs != null ? { time: { start: asst.created, end: asst.created + r.durationMs } } : {}),
      });
    }
    for (const t of asst.texts) {
      parts.push({
        id: `${asst.id}-t${pi++}`,
        type: 'text',
        text: t,
        sessionID: sessionId,
        messageID: asst.id,
      });
    }
    for (const tool of asst.tools) {
      parts.push({
        id: tool.id,
        type: 'tool',
        tool: tool.name,
        callID: tool.callId,
        sessionID: sessionId,
        messageID: asst.id,
        state: {
          status: tool.status,
          input: tool.input,
          output: tool.output,
          title: tool.name,
          time:
            tool.start != null
              ? { start: tool.start, end: tool.end || tool.start }
              : undefined,
        },
      });
    }

    const totalIn = asst.inputTokens;
    const totalOut = asst.outputTokens;
    const total = totalIn + totalOut;
    // activity：step 结束时间
    const endTs = asst.completed || asst.created;
    const info: any = {
      id: asst.id,
      sessionID: sessionId,
      role: 'assistant',
      parentID: lastUserId,
      time: { created: asst.created || endTs, completed: endTs },
      path: { cwd: fallbackCwd, root: '' },
      model,
      providerID: model.providerID,
      modelID: model.modelID,
    };
    if (total > 0) {
      info.tokens = {
        total,
        input: totalIn,
        output: totalOut,
        reasoning: 0,
        cache: { read: 0, write: 0 },
        context: { total: totalIn, input: totalIn, cacheRead: 0 },
      };
    }
    messages.push({ info, parts });
    asst = null;
  };

  const startAsst = (b: CursorBubble, ts: number): AsstAcc => ({
    id: b.bubbleId || `asst-${ts || messages.length}`,
    created: ts || Date.now(),
    completed: ts || 0,
    modelName: b.modelInfo?.modelName,
    reasonings: [],
    texts: [],
    tools: [],
    inputTokens: 0,
    outputTokens: 0,
  });

  const touchAsst = (b: CursorBubble, ts: number) => {
    if (!asst) asst = startAsst(b, ts);
    else {
      if (ts && (!asst.created || ts < asst.created)) asst.created = ts;
      if (ts && ts > asst.completed) asst.completed = ts;
      if (!asst.modelName && b.modelInfo?.modelName) asst.modelName = b.modelInfo.modelName;
    }
    const tc = b.tokenCount;
    if (tc) {
      asst.inputTokens += Number(tc.inputTokens) || 0;
      asst.outputTokens += Number(tc.outputTokens) || 0;
    }
  };

  for (const b of bubbles) {
    const ts = bubbleTsMs(b);
    const type = b.type;

    if (type === 1) {
      flushAsst();
      const raw = b.text || '';
      const text = extractUserQuery(raw);
      const id = b.bubbleId || `user-${ts || messages.length}`;
      messages.push({
        info: {
          id,
          sessionID: sessionId,
          role: 'user',
          time: { created: ts },
          path: { cwd: fallbackCwd, root: '' },
        } as any,
        parts: text
          ? [{ id: `${id}-text`, type: 'text', text, sessionID: sessionId, messageID: id } as any]
          : [],
      });
      lastUserId = id;
      continue;
    }

    // --- assistant 侧 ---
    const thinkingText = extractCursorThinkingText(b);
    const isThinking = isCursorThinkingBubble(b);
    const isTool = isCursorToolBubble(b);
    const text = b.text && String(b.text).trim() ? String(b.text) : '';

    // thinking = 新 step 边界（对齐 UI "Thought for …"）
    if (isThinking) {
      flushAsst();
      touchAsst(b, ts);
      const duration =
        b.thinkingDurationMs ??
        b.grouping?.thinkingDurationMs ??
        undefined;
      asst!.reasonings.push({
        text: thinkingText || (duration != null ? `(thought ${duration}ms)` : '(thinking)'),
        durationMs: typeof duration === 'number' ? duration : undefined,
      });
      // thinking bubble 偶带短 text 时一并收
      if (text) asst!.texts.push(text);
      continue;
    }

    if (isTool) {
      touchAsst(b, ts);
      const tf = b.toolFormerData!;
      const callId = tf.toolCallId || tf.modelCallId || b.bubbleId || `call-${asst!.tools.length}`;
      const name = normalizeCursorToolName(tf.name);
      const input = toolInputFromFormer(tf);
      if (name === 'Bash' && !input.command) {
        const raw = parseCursorToolParams(tf.rawArgs);
        if (raw.command) input.command = raw.command;
      }
      asst!.tools.push({
        id: b.bubbleId || callId,
        callId,
        name,
        input,
        output: cursorToolResultText(tf.result),
        status: toolStatus(tf),
        start: ts,
        end: ts,
      });
      continue;
    }

    if (text) {
      touchAsst(b, ts);
      asst!.texts.push(text);
      continue;
    }

    // 空 bubble：忽略
  }
  flushAsst();
  return messages;
}

/** transcript 回退（无 bubble 时） */
export function convertCursorTranscriptToMessages(
  sessionId: string,
  lines: CursorTranscriptLine[],
  opts?: { fallbackCwd?: string; fallbackModel?: string },
): UnifiedMessage[] {
  const messages: UnifiedMessage[] = [];
  const fallbackCwd = opts?.fallbackCwd || '';
  const model = normalizeModel(opts?.fallbackModel || 'default');
  let lastUserId: string | undefined;
  let idx = 0;

  for (const line of lines) {
    if (line.type === 'status' || (!line.role && line.status)) continue;
    const role = line.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const content = line.message?.content || [];
    const id = `tx-${sessionId}-${idx++}`;
    const parts: any[] = [];
    let textJoined = '';
    let pi = 0;

    for (const c of content) {
      if (!c) continue;
      if (c.type === 'text' && c.text) {
        const t = role === 'user' ? extractUserQuery(c.text) : c.text;
        if (!t) continue;
        textJoined += (textJoined ? '\n' : '') + t;
        parts.push({
          id: `${id}-t${pi++}`,
          type: 'text',
          text: t,
          sessionID: sessionId,
          messageID: id,
        });
      } else if (c.type === 'tool_use') {
        const callId = c.id || `${id}-tool-${pi}`;
        parts.push({
          id: callId,
          type: 'tool',
          tool: normalizeCursorToolName(c.name),
          callID: callId,
          sessionID: sessionId,
          messageID: id,
          state: {
            status: 'completed',
            input: c.input || {},
            title: c.name,
          },
        });
      }
    }

    if (!parts.length) continue;

    if (role === 'user') {
      messages.push({
        info: {
          id,
          sessionID: sessionId,
          role: 'user',
          time: { created: 0 },
          path: { cwd: fallbackCwd, root: '' },
        } as any,
        parts,
      });
      lastUserId = id;
    } else {
      messages.push({
        info: {
          id,
          sessionID: sessionId,
          role: 'assistant',
          parentID: lastUserId,
          time: { created: 0 },
          path: { cwd: fallbackCwd, root: '' },
          model,
          providerID: model.providerID,
          modelID: model.modelID,
        } as any,
        parts,
      });
    }
  }
  return messages;
}

// ==================== editDiffs ====================

function editDiffsFromComposer(
  composer: CursorComposerData | null,
  messages: UnifiedMessage[],
): { additions: number; deletions: number; filesChanged: number; files?: string[] } {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;

  // 从 tool 参数里猜路径
  for (const m of messages) {
    for (const part of m.parts || []) {
      if (part.type !== 'tool') continue;
      const name = String(part.tool || '').toLowerCase();
      const input = (part.state as any)?.input || {};
      const fp =
        input.path ||
        input.file_path ||
        input.filePath ||
        input.targetFile ||
        input.target_file;
      if (fp && (name.includes('edit') || name.includes('write') || name === 'edit' || name === 'write')) {
        files.add(String(fp));
      }
      if (name === 'write' || name === 'edit') {
        const content = input.content || input.new_string || input.newString;
        if (content) additions += String(content).split('\n').length;
        const old = input.old_string || input.oldString;
        if (old) deletions += String(old).split('\n').length;
      }
    }
  }

  const fromComposerAdd = Number(composer?.totalLinesAdded) || 0;
  const fromComposerDel = Number(composer?.totalLinesRemoved) || 0;
  const fromComposerFiles = Number(composer?.filesChangedCount) || 0;

  return {
    additions: fromComposerAdd || additions,
    deletions: fromComposerDel || deletions,
    filesChanged: fromComposerFiles || files.size,
    files: files.size ? Array.from(files) : undefined,
  };
}

// ==================== context estimate（对齐 grok estimate 语义，但只有「末次窗口快照」） ====================

/**
 * Cursor 本地无 per-call billed usage；composerData.promptTokenBreakdown 是
 * **当前 context 填充量**（非累计消耗），categories 为 system/tools/rules/... 估算。
 *
 * 与 Grok 的 estimate 差异：
 * - Grok：updates 里多轮 context 快照，可近似累加
 * - Cursor：仅会话末次窗口一帧 → 只挂 last assistant，不写 session total_tokens
 */
export function extractCursorContextEstimate(composer?: CursorComposerData | null): {
  used: number;
  maxTokens: number;
  /** 按 category 拆（全属 context 输入侧，无 output） */
  byCategory: Record<string, number>;
  contextUsagePercent?: number;
} | null {
  const ptb = composer?.promptTokenBreakdown;
  const used = Number(ptb?.totalUsedTokens) || 0;
  if (used <= 0) return null;
  const byCategory: Record<string, number> = {};
  for (const c of ptb?.categories || []) {
    const id = String(c?.id || c?.label || 'other');
    const n = Number(c?.estimatedTokens) || 0;
    if (n > 0) byCategory[id] = (byCategory[id] || 0) + n;
  }
  return {
    used,
    maxTokens: Number(ptb?.maxTokens) || 0,
    byCategory,
    contextUsagePercent:
      typeof composer?.contextUsagePercent === 'number'
        ? composer.contextUsagePercent
        : undefined,
  };
}

/**
 * 无 bubble.tokenCount 时，把 context 快照挂到最后一条 assistant：
 * - tokens.context.total = used（窗口占用）
 * - tokens.input = used（UI lastTokenInfo 左栏）
 * - tokens.output = 0（本地无 output 累计）
 * - tokens.total = used（供 buildLastTokenInfo）
 */
export function applyCursorContextEstimateToMessages(
  messages: UnifiedMessage[],
  composer?: CursorComposerData | null,
): { messages: UnifiedMessage[]; applied: boolean; used: number } {
  const est = extractCursorContextEstimate(composer);
  if (!est) return { messages, applied: false, used: 0 };

  // 已有任意 real token 则不覆盖
  const hasReal = messages.some((m) => {
    const t = m.info?.tokens;
    if (!t) return false;
    return (t.input || 0) > 0 || (t.output || 0) > 0;
  });
  if (hasReal) return { messages, applied: false, used: est.used };

  let lastAsstIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info?.role === 'assistant') {
      lastAsstIdx = i;
      break;
    }
  }
  if (lastAsstIdx < 0) return { messages, applied: false, used: est.used };

  const next = messages.slice();
  const m = { ...next[lastAsstIdx], info: { ...next[lastAsstIdx].info } };
  m.info.tokens = {
    total: est.used,
    input: est.used,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
    context: {
      total: est.used,
      input: est.used,
      cacheRead: 0,
    },
  };
  // 透传 breakdown，宿主/详情可用（非协议必填）
  (m.info as any).cursorContextEstimate = {
    used: est.used,
    maxTokens: est.maxTokens,
    byCategory: est.byCategory,
    contextUsagePercent: est.contextUsagePercent,
    usage_source: 'estimate' as const,
  };
  next[lastAsstIdx] = m;
  return { messages: next, applied: true, used: est.used };
}

// ==================== load messages ====================

async function loadCursorMessages(
  session: CursorSessionItem,
  composer?: CursorComposerData | null,
): Promise<{ messages: UnifiedMessage[]; from: 'bubbles' | 'transcript' | 'empty' }> {
  const modelHint =
    composer?.modelConfig?.modelName ||
    composer?.modelConfig?.selectedModels?.[0]?.modelId ||
    'default';
  const bubbles = await getCursorBubbles(session.sessionId);
  const hasSubstance = bubbles.some(
    (b) =>
      (b.text && b.text.trim()) ||
      b.toolFormerData?.name ||
      b.toolFormerData?.result,
  );
  let messages: UnifiedMessage[] = [];
  let from: 'bubbles' | 'transcript' | 'empty' = 'empty';
  if (hasSubstance) {
    messages = convertCursorBubblesToMessages(session.sessionId, bubbles, {
      fallbackCwd: session.cwd,
      fallbackModel: modelHint,
    });
    from = 'bubbles';
  } else {
    const tx = readCursorTranscript(session.sessionId);
    if (tx.length) {
      messages = convertCursorTranscriptToMessages(session.sessionId, tx, {
        fallbackCwd: session.cwd,
        fallbackModel: modelHint,
      });
      from = 'transcript';
    }
  }
  // context 快照 → last assistant（estimate）
  messages = applyCursorContextEstimateToMessages(messages, composer).messages;
  return { messages, from };
}

// ==================== stats ====================

function mapCursorStatus(
  raw: string | undefined,
  messages: UnifiedMessage[],
): UnifiedSessionInfo['session_status'] {
  const s = String(raw || '').toLowerCase();
  if (s === 'completed' || s === 'done') return checkSessionStatus(messages) || 'done';
  if (s === 'aborted' || s === 'cancelled' || s === 'canceled') return 'aborted';
  if (s === 'error' || s === 'failed') return 'error';
  if (
    s === 'generating' ||
    s === 'in_progress' ||
    s === 'in-progress' ||
    s === 'running' ||
    s === 'streaming'
  ) {
    return 'in-progress';
  }
  return checkSessionStatus(messages);
}

async function getCursorSessionStats(
  session: CursorSessionItem,
  preloaded?: UnifiedMessage[],
  preComposer?: CursorComposerData | null,
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
    editDiffs: { additions: number; deletions: number; filesChanged: number; files?: string[] };
    bashSignals: BashSignals;
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
    usage_source?: 'real' | 'estimate';
    cost_is_partial?: boolean;
    usage_is_incomplete?: boolean;
  };
  unifiedMessages: UnifiedMessage[];
  pricing: SessionPricing;
  composer: CursorComposerData | null;
}> {
  const emptyStats: {
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
    editDiffs: { additions: number; deletions: number; filesChanged: number; files?: string[] };
    bashSignals: BashSignals;
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
    usage_source?: 'real' | 'estimate';
    cost_is_partial?: boolean;
    usage_is_incomplete?: boolean;
  } = {
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
    usage_source: 'estimate',
    cost_is_partial: true,
    usage_is_incomplete: false,
  };

  try {
    const composer = preComposer !== undefined
      ? preComposer
      : await getCursorComposerData(session.sessionId);
    const { messages: unifiedMessages } = preloaded
      ? { messages: preloaded }
      : await loadCursorMessages(session, composer);

    const stats = { ...emptyStats };
    stats.total_messages = unifiedMessages.length;
    stats.editDiffs = editDiffsFromComposer(composer, unifiedMessages);
    stats.bashSignals = classifyBashCommands(extractBashCommands(unifiedMessages));

    const models = new Set<string>();
    const textParts: any[] = [];
    const timingLists = createTimingLists();
    let lastUserTs: number | null = null;
    let anyRealTokens = false;

    for (const um of unifiedMessages) {
      const role = um.info.role;
      const created = um.info.time?.created || 0;
      if (role === 'user') {
        stats.total_user_messages++;
        lastUserTs = created;
      }
      for (const part of um.parts || []) {
        if (part.type !== 'tool') continue;
        stats.total_tool_calls++;
        const st = (part.state as any)?.status;
        if (st === 'error' || st === 'failed') stats.total_tool_calls_failed++;
        else stats.total_tool_calls_success++;
      }
      if (um.info.tokens) {
        const tin = um.info.tokens.input || 0;
        const tout = um.info.tokens.output || 0;
        // context estimate 挂在 last asst，不算 real billed
        const isCtxEst = !!(um.info as any).cursorContextEstimate;
        if (!isCtxEst && (tin || tout)) anyRealTokens = true;
        if (!isCtxEst) {
          stats.total_input += tin;
          stats.total_output += tout;
          stats.total_reasoning += um.info.tokens.reasoning || 0;
          stats.total_cache_read += um.info.tokens.cache?.read || 0;
          stats.total_cache_write += um.info.tokens.cache?.write || 0;
        }
      }
      const mk = um.info.modelID || um.info.model?.modelID;
      if (mk && mk !== 'unknown') models.add(mk);

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
      if (role === 'assistant') {
        const tokens = um.info.tokens;
        const latencyMs = lastUserTs && created > lastUserTs ? created - lastUserTs : 0;
        pushAssistantTimingSample(timingLists, {
          latencyMs,
          outputTokens: (tokens?.output || 0) + (tokens?.reasoning || 0),
          inputTokens: (tokens?.input || 0) + (tokens?.cache?.read || 0),
        });
        lastUserTs = null;
      }
    }

    stats.total_tokens = stats.total_input + stats.total_cache_read + stats.total_output;
    const modelFromConfig =
      composer?.modelConfig?.modelName ||
      composer?.modelConfig?.selectedModels?.[0]?.modelId;
    stats.models_used =
      Array.from(models).join(',') ||
      (modelFromConfig ? normalizeModel(modelFromConfig).modelID : '');

    // context 估算：max_context = 末次窗口占用（非 model maxTokens）
    const ctxEst = extractCursorContextEstimate(composer);
    const breakdownTotal = ctxEst?.used || 0;
    const maxFromMsgs = maxContextFromUnifiedMessages(unifiedMessages);
    stats.max_context_tokens = maxFromMsgs || breakdownTotal || undefined;

    if (anyRealTokens) {
      stats.usage_source = 'real';
      // Cursor 订阅价不可从本地还原
      stats.cost_is_partial = true;
      stats.usage_is_incomplete = false;
    } else {
      // 无 bubble token：仅 context 快照 → estimate
      // 故意不把 used 写入 total_tokens（那是窗口占用，不是累计消耗；token-stats 会虚高）
      stats.usage_source = 'estimate';
      stats.cost_is_partial = true;
      stats.usage_is_incomplete = false;
      // 列表 total_* 保持 0；last_message_tokens / lastTokenInfo 走 message.tokens
    }

    // estimate 路径：message 上已挂 context，但 stats 累加会把 used 当 usage；回滚 total_*
    if (!anyRealTokens && breakdownTotal > 0) {
      stats.total_input = 0;
      stats.total_output = 0;
      stats.total_cache_read = 0;
      stats.total_cache_write = 0;
      stats.total_reasoning = 0;
      stats.total_tokens = 0;
    }

    const pricing = anyRealTokens
      ? calculateSessionPricingFromUnifiedMessages(unifiedMessages)
      : { usd: 0, cny: 0 }; // context estimate 不计费
    const timingSummary = summarizeTimingLists(timingLists);

    let userParts = sanitizeUserTextParts(textParts.filter((p) => p.role === 'user'));
    userParts = userParts.filter((r, i) => {
      const prevText = i > 0 ? userParts[i - 1].text : '';
      return prevText !== r.text;
    });

    const lastWithTokens = [...unifiedMessages].reverse().find((m) => m.info.tokens?.total);
    const last_message = lastWithTokens?.info || [...unifiedMessages].reverse().find((m) => m.info.role === 'assistant')?.info;
    // last_message_tokens：context used（窗口占用），与 total_tokens 语义不同
    const last_message_tokens = lastWithTokens?.info.tokens?.total || breakdownTotal || undefined;

    return {
      stats: {
        ...stats,
        total_user_messages: userParts.length || stats.total_user_messages,
        last_message,
        last_message_tokens,
        textParts: textParts.length ? textParts : undefined,
        userParts: userParts.length ? userParts : undefined,
        ...timingSummary,
      },
      unifiedMessages,
      pricing,
      composer,
    };
  } catch (e) {
    console.warn(`[cursor-source] stats 失败: ${session.sessionId}`, e);
    return {
      stats: emptyStats,
      unifiedMessages: [],
      pricing: { usd: 0, cny: 0 },
      composer: null,
    };
  }
}

// ==================== convert / detail ====================

function deriveProjectName(cwd: string): string {
  if (!cwd) return '';
  return path.basename(cwd) || cwd;
}

export async function convertCursorSession(
  session: CursorSessionItem,
  preloaded?: UnifiedMessage[],
): Promise<UnifiedSessionInfo> {
  const { stats, unifiedMessages, pricing, composer } = await getCursorSessionStats(
    session,
    preloaded,
  );

  const session_status = mapCursorStatus(composer?.status, unifiedMessages);
  const activity = buildActivitySpanFromUnifiedMessages(
    unifiedMessages,
    session.updatedAt,
    session.createdAt,
  );

  const title =
    session.title ||
    composer?.name ||
    session.subtitle ||
    session.sessionId.slice(0, 8);

  // subagent：header 标记；parent 暂不可靠时仅标 isSubagent 字段语义靠 parent_id 空
  return {
    id: session.sessionId,
    project_id: session.cwd || session.workspaceId || '',
    slug: session.sessionId,
    directory: session.cwd,
    title,
    version: session.unifiedMode || composer?.unifiedMode || composer?.agentBackend || 'cursor',
    time_created: session.createdAt,
    time_updated: session.updatedAt,
    project_name: session.cwd ? deriveProjectName(session.cwd) : undefined,
    project_worktree: session.cwd || undefined,

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
    usage_source: stats.usage_source,
    cost_is_partial: stats.cost_is_partial,
    usage_is_incomplete: stats.usage_is_incomplete,
    summary_additions: stats.editDiffs.additions || undefined,
    summary_deletions: stats.editDiffs.deletions || undefined,
    summary_files: stats.editDiffs.filesChanged || undefined,

    source: 'cursor',
  };
}

export async function getCursorSessionDetail(
  sessionId: string,
): Promise<UnifiedSessionDetail | null> {
  const session = await getCursorSession(sessionId);
  if (!session) return null;

  const composer = await getCursorComposerData(sessionId);
  const { messages } = await loadCursorMessages(session, composer);
  const { stats, pricing } = await getCursorSessionStats(session, messages, composer);
  const info = await convertCursorSession(session, messages);

  return {
    info,
    messages,
    editDiffs: stats.editDiffs,
    pricing,
  };
}

export { listCursorSessions };
