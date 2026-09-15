/**
 * DSH → OpenCode 统一协议转换
 *
 * 事件流: turn/step 边界 + user/message + assistant/message + tool/call|result
 * - usage 在 assistant/message.data.usage (inputTokens 已剔除 cache, 对齐 dsh-llm TokenUsage)
 * - stream 带 time / time0+dt → 真 TTFT / decode 窗口
 * - user/message.source.kind=user 才算人话; agent-instructions/plugin/skill-catalog 丢弃
 * - inbox spliced next-step (turn 开着) → insert; next-turn (turn 开着) → queued
 * - header.parentSession / origin=subagent → parent_id
 * - session/end-seed inherited → 剥 seed 前缀 (fork 子会话不重复计父 usage)
 */

import path from 'node:path';
import {
  getDshSession,
  listDshSessions,
  readDshEvents,
  type DshEvent,
  type DshSessionItem,
} from './dsh-code';
import { checkSessionStatus } from './opencode';
import { calculateSessionPricingFromUnifiedMessages, type SessionPricing } from '../pricing';
import type { UnifiedSessionInfo, UnifiedSessionDetail, UnifiedMessage, UserQueueOrigin } from './types';
import type { BashSignals } from '../core';
import { classifyBashCommands, extractBashCommands } from './bash-signals';
import { inferDeliverableSignals } from './deliverable-signals';
import { maxContextFromUnifiedMessages, sanitizeUserTextParts, buildLastTokenInfo } from './utils';
import { buildActivitySpanFromUnifiedMessages } from './usage-by-day';
import {
  createTimingLists,
  pushAssistantTimingSample,
  summarizeTimingLists,
} from '../lib/timing-stats';

const MAX_LATENCY_MS = 300_000;
const SYNTHETIC_USER = new Set(['agent-instructions', 'plugin', 'skill-catalog', 'inject', 'goal']);

type PendingTool = { messageIndex: number; partIndex: number };

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parseArgs(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as any;
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object') return v;
    } catch { /* raw 当 command */ }
    return { raw };
  }
  return {};
}

function streamWindow(stream: any[]): { start: number; end: number } {
  let start = 0;
  let end = 0;
  for (const s of stream || []) {
    const t0 = n(s?.time) || n(s?.time0);
    if (!t0) continue;
    if (!start || t0 < start) start = t0;
    let te = t0;
    if (Array.isArray(s?.dt) && s.dt.length) te = t0 + s.dt.reduce((a: number, b: number) => a + n(b), 0);
    if (te > end) end = te;
  }
  return { start, end };
}

function toolResultPayload(data: any): { text: string; isError: boolean; callId: string } {
  const msg = data?.message || {};
  const callId = String(msg.source?.callId || data?.callId || '');
  let isError = !!data?.error;
  const texts: string[] = [];
  for (const b of msg.content || []) {
    if (b?.isError) isError = true;
    if (b?.type === 'tool-result') {
      if (b.isError) isError = true;
      for (const c of b.content || []) {
        if (typeof c === 'string') texts.push(c);
        else if (c?.type === 'text' && c.text) texts.push(String(c.text));
      }
    } else if (b?.type === 'text' && b.text) texts.push(String(b.text));
  }
  return { text: texts.join('\n'), isError, callId };
}

function userText(data: any): string {
  const parts: string[] = [];
  for (const c of data?.content || []) {
    if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.join('\n');
}

function inheritedCut(events: DshEvent[]): number {
  let cut = -1;
  for (const ev of events) {
    if (ev.type === 'session/end-seed' && ev.data?.inherited && typeof ev.seq === 'number') {
      cut = ev.seq;
    }
  }
  return cut;
}

export function convertDshEventsToMessages(
  sessionId: string,
  events: DshEvent[],
  opts: { fallbackCwd?: string } = {},
): { messages: UnifiedMessage[]; title?: string; lastTurnReason?: string; turnOpen: boolean } {
  const cwd = opts.fallbackCwd || '';
  const out: UnifiedMessage[] = [];
  const pending = new Map<string, PendingTool>();
  const originByUserId = new Map<string, UserQueueOrigin>();
  const cut = inheritedCut(events);
  let lastUserId: string | undefined;
  let title: string | undefined;
  let turnOpen = false;
  let lastTurnReason: string | undefined;
  let lastStepKey = '';
  const stepStart = new Map<string, number>();
  let partN = 0;
  const pid = (msgId: string, p: string) => `${msgId}-${p}${partN++}`;

  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string') continue;
    const seq = n(ev.seq);
    if (cut >= 0 && seq >= 0 && seq < cut) continue;
    const t = n(ev.time);
    const d = ev.data || {};

    if (ev.type === 'turn/start') { turnOpen = true; continue; }
    if (ev.type === 'turn/end') {
      turnOpen = false;
      lastTurnReason = String(d.reason?.kind || d.reason || '');
      continue;
    }
    if (ev.type === 'step/start') {
      lastStepKey = `${d.turn ?? ''}:${d.step ?? ''}`;
      if (t) stepStart.set(lastStepKey, t);
      continue;
    }
    if (ev.type === 'session/title') {
      if (typeof d.title === 'string' && d.title.trim()) title = d.title.trim();
      continue;
    }
    if (ev.type === 'agent/inbox/spliced') {
      const target = String(d.target || '');
      for (const ins of d.inserted || []) {
        const id = ins?.id;
        if (!id || !turnOpen) continue;
        if (target === 'next-step') originByUserId.set(id, 'insert');
        else if (target === 'next-turn') originByUserId.set(id, 'queued');
      }
      continue;
    }
    if (ev.type === 'compaction/summary' || ev.type === 'compaction/end') {
      const envId = `dsh-cp-${seq || out.length}`;
      const text = `[Context Compacted]\n${d.summary || d.text || ''}`.trim();
      out.push({
        info: {
          id: envId,
          sessionID: sessionId,
          role: 'assistant',
          parentID: lastUserId,
          time: { created: t || Date.now(), completed: t || Date.now() },
          path: { cwd, root: '' },
          compaction: true,
          finish: 'stop',
        } as any,
        parts: [{ id: pid(envId, 't'), type: 'text', text, sessionID: sessionId, messageID: envId }],
      });
      continue;
    }

    if (ev.type === 'user/message') {
      const kind = String(d.source?.kind || 'user');
      if (SYNTHETIC_USER.has(kind)) continue;
      const text = userText(d);
      const envId = String(d.id || `dsh-u-${seq || out.length}`);
      const origin = originByUserId.get(d.id) || originByUserId.get(envId);
      const parts: any[] = text
        ? [{ id: pid(envId, 't'), type: 'text', text, sessionID: sessionId, messageID: envId }]
        : [];
      out.push({
        info: {
          id: envId,
          sessionID: sessionId,
          role: 'user',
          time: { created: t || Date.now() },
          path: { cwd, root: '' },
          ...(origin ? { user_origin: origin } : {}),
        } as any,
        parts,
      });
      lastUserId = envId;
      continue;
    }

    if (ev.type === 'assistant/message') {
      const msg = d.message || {};
      const src = msg.source || {};
      const envId = String(msg.id || `dsh-a-${seq || out.length}`);
      const stepKey = `${d.turn ?? ''}:${d.step ?? ''}`;
      const created = stepStart.get(stepKey) || t || Date.now();
      const win = streamWindow(d.stream);
      const decodeStart = win.start || created;
      const decodeEnd = win.end || t || created;
      const provider = String(src.provider || '');
      const model = String(src.model || '');
      const usage = d.usage || {};
      const input = n(usage.inputTokens);
      const output = n(usage.outputTokens);
      const cacheRead = n(usage.cacheReadTokens);
      const cacheWrite = n(usage.cacheWriteTokens);
      const reasoning = n(usage.reasoningTokens);
      const total = n(usage.totalTokens) || (input + output + cacheRead);
      const finish = d.interrupted
        ? 'interrupted'
        : String(src.replayState?.response?.stopReason || '');
      const info: any = {
        id: envId,
        sessionID: sessionId,
        role: 'assistant',
        parentID: lastUserId,
        time: { created, completed: t || created, decodeStart, decodeEnd },
        path: { cwd, root: '' },
      };
      if (model) {
        info.model = { providerID: provider || 'unknown', modelID: model };
        info.providerID = provider || 'unknown';
        info.modelID = model;
      }
      if (input || output || cacheRead || reasoning) {
        info.tokens = {
          total,
          input,
          output,
          reasoning,
          cache: { read: cacheRead, write: cacheWrite },
          context: { total: input + cacheRead, input, cacheRead },
        };
      }
      if (finish) info.finish = finish;

      const latencyMs = decodeStart > created ? decodeStart - created : 0;
      const decodeMs = decodeEnd > decodeStart ? decodeEnd - decodeStart : 0;
      const tps: { prefill?: number; decode?: number } = {};
      if (latencyMs > 0 && latencyMs < MAX_LATENCY_MS && input + cacheRead > 0) {
        tps.prefill = Number(((input + cacheRead) / (latencyMs / 1000)).toFixed(2));
      }
      if (decodeMs > 0 && output + reasoning > 0) {
        tps.decode = Number(((output + reasoning) / (decodeMs / 1000)).toFixed(2));
      }
      if (tps.prefill || tps.decode) info.tps = tps;

      const parts: any[] = [];
      for (const c of msg.content || []) {
        if (!c || !c.type) continue;
        if (c.type === 'reasoning' || c.type === 'thinking') {
          const text = c.text || c.thinking || '';
          if (!text) continue;
          parts.push({
            id: pid(envId, 'r'),
            type: 'reasoning',
            text,
            sessionID: sessionId,
            messageID: envId,
            time: { start: decodeStart, end: decodeEnd },
          });
        } else if (c.type === 'text') {
          const text = c.text || '';
          if (!text) continue;
          parts.push({
            id: pid(envId, 't'),
            type: 'text',
            text,
            sessionID: sessionId,
            messageID: envId,
            time: { start: decodeStart, end: decodeEnd },
          });
        } else if (c.type === 'tool-call' || c.type === 'toolCall') {
          const callId = String(c.id || c.callId || '');
          const name = String(c.name || 'unknown');
          const partIndex = parts.length;
          parts.push({
            id: pid(envId, 'tool'),
            type: 'tool',
            tool: name,
            callID: callId,
            sessionID: sessionId,
            messageID: envId,
            state: {
              status: 'completed',
              input: parseArgs(c.arguments ?? c.args),
              output: '',
              title: name,
              time: { start: t || created, end: t || created },
            },
          });
          if (callId) pending.set(callId, { messageIndex: out.length, partIndex });
        }
      }
      out.push({ info, parts });
      continue;
    }

    if (ev.type === 'tool/call') {
      const callId = String(d.callId || '');
      if (!callId || pending.has(callId)) continue;
      // 无 assistant content 时挂到最近一条 assistant
      let ai = -1;
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].info.role === 'assistant') { ai = i; break; }
      }
      if (ai < 0) continue;
      const name = String(d.name || 'unknown');
      const msg = out[ai];
      const partIndex = (msg.parts || []).length;
      (msg.parts as any[]).push({
        id: pid(msg.info.id, 'tool'),
        type: 'tool',
        tool: name,
        callID: callId,
        sessionID: sessionId,
        messageID: msg.info.id,
        state: {
          status: 'completed',
          input: parseArgs(d.arguments ?? d.args),
          output: '',
          title: name,
          time: { start: t, end: t },
        },
      });
      pending.set(callId, { messageIndex: ai, partIndex });
      continue;
    }

    if (ev.type === 'tool/result') {
      const { text, isError, callId } = toolResultPayload(d);
      const p = callId ? pending.get(callId) : undefined;
      if (!p) continue;
      const msg = out[p.messageIndex];
      const part = msg?.parts?.[p.partIndex] as any;
      if (part?.state) {
        part.state.output = text;
        part.state.status = isError ? 'error' : 'completed';
        if (t) part.state.time = { ...part.state.time, end: t };
      }
    }
  }

  return { messages: out, title, lastTurnReason, turnOpen };
}

function calculateDshEditDiffs(messages: UnifiedMessage[]): {
  additions: number; deletions: number; filesChanged: number; files?: string[];
} {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const m of messages) {
    for (const part of m.parts || []) {
      if (part.type !== 'tool') continue;
      const name = String((part as any).tool || '').toLowerCase();
      const input = ((part as any).state?.input || {}) as Record<string, any>;
      const fp = input.path || input.file_path || input.filePath;
      if (fp && (name === 'edit' || name === 'write' || name === 'str_replace_editor')) files.add(String(fp));
      if (name === 'write' && input.content) additions += String(input.content).split('\n').length;
      else if ((name === 'edit' || name === 'str_replace_editor') && (input.new_string || input.newString || input.content)) {
        additions += String(input.new_string || input.newString || input.content).split('\n').length;
        const old = input.old_string || input.oldString;
        if (old) deletions += String(old).split('\n').length;
      }
    }
  }
  return { additions, deletions, filesChanged: files.size, files: files.size ? Array.from(files) : undefined };
}

function mapDshStatus(
  messages: UnifiedMessage[],
  lastTurnReason?: string,
  turnOpen?: boolean,
): UnifiedSessionInfo['session_status'] {
  const r = String(lastTurnReason || '').toLowerCase();
  if (turnOpen) return 'in-progress';
  if (r === 'interrupted' || r === 'cancelled' || r === 'canceled') return 'aborted';
  if (r === 'error' || r === 'failed') return 'error';
  if (r === 'completed' || r === 'success') {
    const fallback = checkSessionStatus(messages);
    // turn 已 completed 但末条 tool 未回填时仍可能 in-progress; 以 check 为准
    return fallback === 'in-progress' ? 'in-progress' : 'done';
  }
  return checkSessionStatus(messages);
}

function deriveProjectName(cwd: string): string {
  if (!cwd) return '';
  return path.basename(cwd) || cwd;
}

function collectStats(messages: UnifiedMessage[]): {
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
  usage_source: 'real';
  cost_is_partial: boolean;
  usage_is_incomplete: boolean;
  compact_count?: number;
  time_compacting?: number;
  max_context_tokens?: number;
  textParts?: any[];
  userParts?: any[];
  insert_count?: number;
  queued_count?: number;
  last_message?: any;
  last_message_tokens?: number;
  avg_tps?: number;
  avg_latency_ms?: number;
  avg_prefill_tps?: number;
  assistant_tps_list?: number[];
  latency_list?: number[];
  prefill_tps_list?: number[];
  usage_by_model?: Array<{
    provider: string; model: string; modelKey?: string;
    input: number; output: number; cache_read: number; cache_write: number; reasoning?: number; tokens?: number;
  }>;
} {
  const stats = {
    total_messages: messages.length,
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
    editDiffs: calculateDshEditDiffs(messages),
    bashSignals: classifyBashCommands(extractBashCommands(messages)),
    usage_source: 'real' as const,
    cost_is_partial: true,
    usage_is_incomplete: false,
  };
  const models = new Set<string>();
  const modelUsage = new Map<string, {
    provider: string; model: string; input: number; output: number;
    cache_read: number; cache_write: number; reasoning: number;
  }>();
  const textParts: any[] = [];
  const userTextParts: any[] = [];
  const timingLists = createTimingLists();

  for (const um of messages) {
    const role = um.info.role;
    const created = um.info.time?.created || 0;
    if (role === 'user') stats.total_user_messages++;
    for (const part of um.parts || []) {
      if (part.type !== 'tool') continue;
      stats.total_tool_calls++;
      const st = (part.state as any)?.status;
      if (st === 'error' || st === 'failed') stats.total_tool_calls_failed++;
      else stats.total_tool_calls_success++;
    }
    if (um.info.tokens) {
      stats.total_input += um.info.tokens.input || 0;
      stats.total_output += um.info.tokens.output || 0;
      stats.total_reasoning += um.info.tokens.reasoning || 0;
      stats.total_cache_read += um.info.tokens.cache?.read || 0;
      stats.total_cache_write += um.info.tokens.cache?.write || 0;
    }
    const providerID = um.info.providerID || um.info.model?.providerID;
    const modelID = um.info.modelID || um.info.model?.modelID;
    if (modelID) {
      models.add(modelID);
      const key = `${providerID || 'unknown'}/${modelID}`;
      const cur = modelUsage.get(key) || {
        provider: providerID || 'unknown', model: modelID,
        input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0,
      };
      cur.input += um.info.tokens?.input || 0;
      cur.output += um.info.tokens?.output || 0;
      cur.cache_read += um.info.tokens?.cache?.read || 0;
      cur.cache_write += um.info.tokens?.cache?.write || 0;
      cur.reasoning += um.info.tokens?.reasoning || 0;
      modelUsage.set(key, cur);
    }
    const texts = (um.parts || [])
      .filter((p: any) => p.type === 'text' || p.type === 'reasoning')
      .map((p: any) => p.text)
      .filter(Boolean);
    if (texts.length) {
      textParts.push({ role, text: texts.join('\n'), tool: '', duration: 0, startTime: created, endTime: created });
      if (role === 'user') {
        const origin = (um.info as any).user_origin as UserQueueOrigin | undefined;
        userTextParts.push({
          role, text: texts.join('\n'), tool: '', duration: 0, startTime: created, endTime: created,
          ...(origin ? { origin } : {}),
        });
      }
    }
    if (role === 'assistant') {
      const tokens = um.info.tokens;
      const time = (um.info.time || {}) as { created?: number; decodeStart?: number; decodeEnd?: number; completed?: number };
      const startTs = time.created || 0;
      const decodeStartTs = time.decodeStart || 0;
      const latencyMs = decodeStartTs > startTs ? decodeStartTs - startTs : 0;
      const decodeEnd = time.decodeEnd || time.completed || 0;
      const decodeMs = latencyMs > 0 && decodeEnd > decodeStartTs ? decodeEnd - decodeStartTs : 0;
      if (latencyMs > 0) {
        pushAssistantTimingSample(timingLists, {
          latencyMs,
          outputTokens: (tokens?.output || 0) + (tokens?.reasoning || 0),
          decodeDurationMs: decodeMs > 0 ? decodeMs : undefined,
          inputTokens: (tokens?.input || 0) + (tokens?.cache?.read || 0),
        });
      } else {
        const endTs = time.completed || startTs;
        const callMs = endTs > startTs ? endTs - startTs : 0;
        if (callMs > 0) {
          pushAssistantTimingSample(timingLists, {
            outputTokens: (tokens?.output || 0) + (tokens?.reasoning || 0),
            decodeDurationMs: callMs,
          });
        }
      }
    }
  }

  stats.total_tokens = stats.total_input + stats.total_cache_read + stats.total_output;
  const compactMsgs = messages.filter((m) => (m.info as any).compaction);
  let userParts = sanitizeUserTextParts(userTextParts);
  userParts = userParts.filter((r, i) => (i > 0 ? userParts[i - 1].text : '') !== r.text);
  const lastWithTokens = [...messages].reverse().find((m) => m.info.tokens?.total);

  return {
    ...stats,
    models_used: Array.from(models).join(','),
    max_context_tokens: maxContextFromUnifiedMessages(messages) || undefined,
    compact_count: compactMsgs.length || undefined,
    time_compacting: compactMsgs.length ? compactMsgs[compactMsgs.length - 1].info.time?.created : undefined,
    usage_by_model: Array.from(modelUsage.entries()).map(([k, v]) => ({
      provider: v.provider, model: v.model, modelKey: k,
      input: v.input, output: v.output, cache_read: v.cache_read, cache_write: v.cache_write,
      reasoning: v.reasoning, tokens: v.input + v.output + v.cache_read + v.cache_write,
    })),
    ...summarizeTimingLists(timingLists),
    total_user_messages: userParts.length || stats.total_user_messages,
    last_message: lastWithTokens?.info || [...messages].reverse().find((m) => m.info.role === 'assistant')?.info,
    last_message_tokens: lastWithTokens?.info.tokens?.total,
    textParts: textParts.length ? textParts : undefined,
    userParts: userParts.length ? userParts : undefined,
    insert_count: userParts.filter((p) => (p as any).origin === 'insert').length || undefined,
    queued_count: userParts.filter((p) => (p as any).origin === 'queued').length || undefined,
  };
}

export async function convertDshSession(
  session: DshSessionItem,
  preloaded?: { events?: DshEvent[]; messages?: UnifiedMessage[]; title?: string; lastTurnReason?: string; turnOpen?: boolean },
): Promise<UnifiedSessionInfo> {
  let messages = preloaded?.messages;
  let title = preloaded?.title ?? session.title;
  let lastTurnReason = preloaded?.lastTurnReason;
  let turnOpen = preloaded?.turnOpen;
  if (!messages) {
    const events = preloaded?.events || readDshEvents(session.logPath).events;
    const r = convertDshEventsToMessages(session.sessionId, events, { fallbackCwd: session.cwd });
    messages = r.messages;
    title = r.title || title;
    lastTurnReason = r.lastTurnReason;
    turnOpen = r.turnOpen;
  }
  const stats = collectStats(messages);
  const pricing: SessionPricing = calculateSessionPricingFromUnifiedMessages(messages);
  stats.cost_is_partial = !(pricing.details?.some((d) => (d.usd || 0) > 0));
  const activity = buildActivitySpanFromUnifiedMessages(messages, session.updatedAt, session.createdAt);
  const firstUser = messages.find((m) => m.info.role === 'user');
  const firstText = (firstUser?.parts?.find((p: any) => p.type === 'text') as any)?.text as string | undefined;
  const resolvedTitle = (title || firstText || session.sessionId).replace(/\s+/g, ' ').trim().slice(0, 80);

  return {
    id: session.sessionId,
    project_id: session.cwd || session.sessionId,
    parent_id: session.parentId || undefined,
    slug: session.sessionId,
    directory: session.cwd,
    title: resolvedTitle,
    source_title: resolvedTitle,
    version: `dsh-v${session.formatVersion}`,
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
    usage_by_model: stats.usage_by_model,
    session_status: mapDshStatus(messages, lastTurnReason, turnOpen),
    compact_count: stats.compact_count,
    time_compacting: stats.time_compacting ?? null,
    insert_count: stats.insert_count,
    queued_count: stats.queued_count,
    last_message_tokens: stats.last_message_tokens,
    max_context_tokens: stats.max_context_tokens,
    last_message: stats.last_message,
    lastTokenInfo: buildLastTokenInfo(messages),
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
    deliverableSignals: inferDeliverableSignals({ messages }),
    pricing,
    usage_source: stats.usage_source,
    cost_is_partial: stats.cost_is_partial,
    usage_is_incomplete: /^(interrupted|error|failed|cancelled|canceled)$/i.test(String(lastTurnReason || '')) || stats.usage_is_incomplete,
    source: 'dsh',
  };
}

export async function getDshSessionDetail(sessionId: string): Promise<UnifiedSessionDetail | null> {
  const session = await getDshSession(sessionId);
  if (!session) return null;
  const { events } = readDshEvents(session.logPath);
  const interim = convertDshEventsToMessages(session.sessionId, events, { fallbackCwd: session.cwd });
  const info = await convertDshSession(session, {
    events,
    messages: interim.messages,
    title: interim.title,
    lastTurnReason: interim.lastTurnReason,
    turnOpen: interim.turnOpen,
  });
  const pricing = info.pricing || { usd: 0, cny: 0 };
  return {
    info: { ...info, pricing },
    messages: interim.messages,
    editDiffs: calculateDshEditDiffs(interim.messages),
    pricing,
  };
}

export async function listDshSessionsForListing(): Promise<UnifiedSessionInfo[]> {
  const list = await listDshSessions();
  const { withConcurrencyLimit } = await import('./utils');
  return withConcurrencyLimit(list, async (s) => {
    const { events } = readDshEvents(s.logPath);
    const r = convertDshEventsToMessages(s.sessionId, events, { fallbackCwd: s.cwd });
    return convertDshSession(s, {
      events,
      messages: r.messages,
      title: r.title,
      lastTurnReason: r.lastTurnReason,
      turnOpen: r.turnOpen,
    });
  }, 3);
}
