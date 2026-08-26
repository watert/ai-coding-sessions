/**
 * Session 失败事件查询模块（API 异常 + Tool Call Fail + soft fail）
 *
 * 直接读各 source 原始数据（不走缓存），按近 N 天窗口聚合失败事件：
 * - grok:    updates.jsonl turn_completed.stop_reason≠end_turn（API 异常，含 agent_result 全文）
 *            + toolCalls status=failed/error（hard tool fail）
 * - opencode: message.data.error 非空（API/消息级异常）+ part state.status failed/error
 * - kimi:    tool part failed/error（hard）+ AgentSwarm 结果中 failed/aborted 子 agent（失败任务）
 *
 * 供 CLI `failures` 与宿主 REST 汇总（/api/ai-coding/failure-stats）复用。
 */

import dayjs from 'dayjs';
import { listGrokCodeSessions, listGrokCodeMessages } from '../sources/grok-code';
import { readJsonlCached } from '../lib/jsonl-cache';
import { initOpencodeDb, getOpencodeDb } from '../sources/opencode';
import { listKimiCodeSessions, listKimiCodeMessages, parseAgentSwarmResult } from '../sources/kimi-code';
import { classifySoftToolError } from '../sources/tool-error-soft';

/** 已实现失败采集的 source */
export type FailureSource = 'grok' | 'opencode' | 'kimi';

export type FailureKind = 'api' | 'tool';

export interface FailureEvent {
  source: FailureSource;
  sessionId: string;
  sessionTitle?: string;
  ts: number;
  kind: FailureKind;
  model?: string;
  /** api: stop_reason / finish_reason */
  stopReason?: string;
  /** api: HTTP status code（grok agent_result 内嵌） */
  statusCode?: number;
  /** tool: 工具名 */
  toolName?: string;
  /** soft fail（已自动降级，非硬错误） */
  soft?: boolean;
  /** grok errorKind / soft 分类 */
  errorKind?: string;
  /** 归一化错误文本（短） */
  error: string;
  /** 原始错误文本（截断 400 字符） */
  errorRaw?: string;
}

export interface FailureDistRow {
  key: string;
  count: number;
  pct: number;
}

export interface FailureCollectOptions {
  days?: number;
  /** YYYY-MM-DD 或 ISO，优先于 days */
  startDate?: string;
  endDate?: string;
  /** 默认 all（仅已实现源） */
  source?: 'all' | FailureSource;
  top?: number;
}

export interface FailureAnalyzeResult {
  range: { start: string; end: string; days: number };
  total: number;
  /** hard tool fail 数 */
  toolCount: number;
  /** 软失败数（不计入 toolCount） */
  softCount: number;
  apiCount: number;
  sessions: number;
  bySource: FailureDistRow[];
  byKind: FailureDistRow[];
  byModel: FailureDistRow[];
  byTool: FailureDistRow[];
  byError: FailureDistRow[];
  /** 全部 API 异常事件 */
  apiFailures: FailureEvent[];
  /** 最近事件样本（api + hard tool，按时间倒序） */
  samples: FailureEvent[];
}

// ==================== 窗口 ====================

export function resolveFailureWindow(opts: FailureCollectOptions): { sinceMs: number; endMs: number; days: number } {
  const endMs = opts.endDate
    ? (opts.endDate.includes('T') ? dayjs(opts.endDate).valueOf() : dayjs(opts.endDate).endOf('day').valueOf())
    : dayjs().endOf('day').valueOf();
  if (opts.startDate) {
    const sinceMs = opts.startDate.includes('T')
      ? dayjs(opts.startDate).valueOf()
      : dayjs(opts.startDate).startOf('day').valueOf();
    const days = Math.max(1, Math.ceil((endMs - sinceMs) / 86_400_000));
    return { sinceMs, endMs, days };
  }
  const days = Math.max(1, opts.days ?? 14);
  return { sinceMs: dayjs().subtract(days, 'day').startOf('day').valueOf(), endMs, days };
}

// ==================== 通用 ====================

function errText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    if (typeof o.error === 'string') return o.error;
    if (typeof o.output === 'string') return o.output;
    try {
      return JSON.stringify(o);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

function normError(raw: unknown, max = 160): string {
  return errText(raw).replace(/\s+/g, ' ').trim().slice(0, max) || '(empty)';
}

function toMs(ts?: number | null): number | undefined {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return undefined;
  return ts < 1e12 ? ts * 1000 : ts;
}

/** 错误文本中提取 HTTP status code */
function extractStatusCode(text: string): number | undefined {
  const m = text.match(/status\s+(\d{3})/i);
  return m ? Number(m[1]) : undefined;
}

function toDist(map: Map<string, number>, total: number, top?: number): FailureDistRow[] {
  const rows = Array.from(map.entries())
    .map(([key, count]) => ({ key, count, pct: total > 0 ? (count / total) * 100 : 0 }))
    .sort((a, b) => b.count - a.count);
  return top ? rows.slice(0, top) : rows;
}

function tsInWindow(ts: number, sinceMs: number, endMs: number): boolean {
  return ts > 0 && ts >= sinceMs && ts <= endMs;
}

function toolSoftFlag(errorText: string, metadata?: Record<string, unknown>) {
  const cls = classifySoftToolError({ error: errorText, output: errorText });
  const isSoft = cls.soft || metadata?.errorSeverity === 'soft';
  return { isSoft, kind: cls.kind };
}

// ==================== grok ====================

/**
 * grok updates.jsonl → turn_completed 异常（stop_reason ≠ end_turn）。
 * agent_result 常携带完整 upstream 错误文本（如 400 Model only supports text input）。
 */
function collectGrokApiEvents(
  sessionId: string,
  sessionTitle: string | undefined,
  rows: any[],
  sinceMs: number,
  endMs: number,
  out: FailureEvent[],
) {
  for (const row of rows || []) {
    if (row?.method !== '_x.ai/session/update') continue;
    const update = row?.params?.update;
    if (!update || update.sessionUpdate !== 'turn_completed') continue;
    const stop = String(update.stop_reason || '');
    if (!stop || stop === 'end_turn' || stop === 'turn_ended') continue;
    const ts = toMs(row.timestamp) ?? toMs(row?.params?._meta?.agentTimestampMs);
    if (ts == null || !tsInWindow(ts, sinceMs, endMs)) continue;
    const text = errText(update.agent_result ?? update.error ?? update.message ?? '');
    if (!text.replace(/\s+/g, '')) continue;
    const usageModels = Object.keys(update.usage?.modelUsage || {});
    out.push({
      source: 'grok',
      sessionId,
      sessionTitle,
      ts,
      kind: 'api',
      model: usageModels.join(',') || undefined,
      stopReason: stop,
      statusCode: extractStatusCode(text),
      error: normError(text),
      errorRaw: text.slice(0, 400).replace(/\s+/g, ' '),
    });
  }
}

async function collectGrokSession(
  s: { sessionId: string; sessionDir: string; title?: string; updatedAt: number },
  sinceMs: number,
  endMs: number,
  out: FailureEvent[],
) {
  // API 异常：updates.jsonl turn_completed
  const rows = readJsonlCached(pathJoin(s.sessionDir, 'updates.jsonl')) ?? [];
  collectGrokApiEvents(s.sessionId, s.title || undefined, rows, sinceMs, endMs, out);

  // Tool fail：chat_history.jsonl toolCalls
  const msgs = await listGrokCodeMessages({ sessionId: s.sessionId, sessionDir: s.sessionDir });
  for (const msg of msgs || []) {
    if (!tsInWindow(msg.timestamp || 0, sinceMs, endMs)) continue;
    for (const tc of msg.toolCalls || []) {
      const st = String(tc.status || '').toLowerCase();
      const isSoft = tc.errorSeverity === 'soft';
      const isError = !isSoft && (st === 'failed' || st === 'error' || tc.error);
      if (!isError && !isSoft) continue;
      const text = errText(tc.result ?? tc.error);
      out.push({
        source: 'grok',
        sessionId: s.sessionId,
        sessionTitle: s.title || undefined,
        ts: msg.timestamp || 0,
        kind: 'tool',
        model: msg.model,
        toolName: tc.name || 'unknown',
        soft: isSoft,
        errorKind: tc.errorKind,
        error: isSoft ? normError(text) || `soft:${tc.errorKind || 'unknown'}` : normError(text),
        errorRaw: text.slice(0, 400).replace(/\s+/g, ' '),
      });
    }
  }
}

// ==================== opencode ====================

/** opencode message.data.error 非空 → API/消息级异常 */
function collectOpencodeApiEvents(sinceMs: number, out: FailureEvent[]) {
  const db = getOpencodeDb();
  const rows = db.prepare(`
    SELECT m.data, m.session_id, m.time_created
    FROM message m
    WHERE json_extract(m.data, '$.error') IS NOT NULL
      AND m.time_created >= ?
  `).all(sinceMs) as Array<{ data: string; session_id: string; time_created: number }>;
  for (const r of rows) {
    const m = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const text = errText(m.error);
    if (!text) continue;
    out.push({
      source: 'opencode',
      sessionId: r.session_id,
      ts: r.time_created || 0,
      kind: 'api',
      model: m.modelID || m.model?.modelID,
      stopReason: 'message-error',
      error: normError(text),
      errorRaw: text.slice(0, 400).replace(/\s+/g, ' '),
    });
  }
}

/** opencode part state.status failed/error（soft 单独标记） */
function collectOpencodeToolEvents(sinceMs: number, out: FailureEvent[]) {
  const db = getOpencodeDb();
  const rows = db.prepare(`
    SELECT pt.data as data, m.data as mdata, m.session_id, m.time_created
    FROM part pt
    JOIN message m ON m.id = pt.message_id
    WHERE json_extract(pt.data, '$.type') = 'tool'
      AND json_extract(pt.data, '$.state.status') IN ('failed', 'error')
      AND m.time_created >= ?
  `).all(sinceMs) as Array<{ data: string; mdata: string; session_id: string; time_created: number }>;
  for (const r of rows) {
    const p = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const m = typeof r.mdata === 'string' ? JSON.parse(r.mdata) : r.mdata;
    const state = p.state || {};
    const raw = state.error ?? state.output ?? '';
    const { isSoft, kind } = toolSoftFlag(errText(raw), state.metadata);
    out.push({
      source: 'opencode',
      sessionId: r.session_id,
      ts: r.time_created || 0,
      kind: 'tool',
      model: m.modelID || m.model?.modelID,
      toolName: String(p.tool || p.name || 'unknown'),
      soft: isSoft,
      errorKind: kind,
      error: isSoft ? normError(raw) || `soft:${kind || 'unknown'}` : normError(raw),
      errorRaw: errText(raw).slice(0, 400).replace(/\s+/g, ' '),
    });
  }
}

// ==================== kimi ====================

/** kimi tool part failed/error + AgentSwarm failed/aborted 子任务 */
function collectKimiSessionEvents(
  sessionId: string,
  sessionTitle: string | undefined,
  msgs: any[],
  sinceMs: number,
  endMs: number,
  out: FailureEvent[],
) {
  for (const msg of msgs || []) {
    const ts = msg.timestamp || 0;
    if (!tsInWindow(ts, sinceMs, endMs)) continue;
    for (const part of msg.parts || []) {
      if (part?.type !== 'tool') continue;
      const state = part.state || {};
      const status = String(state.status || '');
      if (status === 'failed' || status === 'error') {
        const raw = state.error ?? state.output ?? '';
        const { isSoft, kind } = toolSoftFlag(errText(raw), state.metadata);
        out.push({
          source: 'kimi',
          sessionId,
          sessionTitle,
          ts,
          kind: 'tool',
          model: msg.model,
          toolName: String(part.tool || part.name || 'unknown'),
          soft: isSoft,
          errorKind: kind,
          error: isSoft ? normError(raw) || `soft:${kind || 'unknown'}` : normError(raw),
          errorRaw: errText(raw).slice(0, 400).replace(/\s+/g, ' '),
        });
        continue;
      }
      // AgentSwarm 结果中 failed/aborted 子 agent → API 类失败任务
      if (/^agentswarm$/i.test(String(part.tool || ''))) {
        const output = extractKimiOutput(state.output ?? state.result ?? state.error);
        const agents = output ? parseAgentSwarmResult(output) : {};
        for (const info of Object.values(agents)) {
          if (!info.errorInfo) continue;
          out.push({
            source: 'kimi',
            sessionId,
            sessionTitle,
            ts,
            kind: 'api',
            model: msg.model,
            stopReason: `swarm-${info.outcome || 'failed'}`,
            error: normError(info.errorInfo, 200),
            errorRaw: info.errorInfo.slice(0, 400).replace(/\s+/g, ' '),
          });
        }
      }
    }
  }
}

function extractKimiOutput(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const o = raw as { output?: unknown; content?: unknown };
    if (typeof o.output === 'string') return o.output;
    if (typeof o.content === 'string') return o.content;
  }
  return undefined;
}

// ==================== 汇总 ====================

/**
 * 汇总近 N 天各 source 失败事件。
 * 每个 source 独立 try/catch：单源失败不影响其他源结果。
 */
export async function collectSessionFailures(
  opts: FailureCollectOptions = {},
): Promise<FailureAnalyzeResult> {
  const source = opts.source ?? 'all';
  const top = opts.top ?? 20;
  const { sinceMs, endMs, days } = resolveFailureWindow(opts);
  const events: FailureEvent[] = [];

  const tasks: Promise<void>[] = [];
  const run = (label: string, fn: () => Promise<void>) => {
    tasks.push(fn().catch((e) => console.warn(`[failure-stats] ${label} collect failed:`, e)));
  };

  if (source === 'all' || source === 'grok') {
    run('grok', async () => {
      const sessions = await listGrokCodeSessions();
      for (const s of sessions) {
        if ((s.updatedAt || 0) < sinceMs) continue;
        await collectGrokSession(s, sinceMs, endMs, events);
      }
    });
  }

  if (source === 'all' || source === 'opencode') {
    run('opencode', async () => {
      await initOpencodeDb();
      collectOpencodeApiEvents(sinceMs, events);
      collectOpencodeToolEvents(sinceMs, events);
    });
  }

  if (source === 'all' || source === 'kimi') {
    run('kimi', async () => {
      const sessions = await listKimiCodeSessions();
      for (const s of sessions) {
        if ((s.updatedAt || 0) < sinceMs) continue;
        try {
          const msgs = await listKimiCodeMessages({ sessionId: s.sessionId, sessionDir: s.sessionDir });
          collectKimiSessionEvents(s.sessionId, s.title || undefined, msgs, sinceMs, endMs, events);
        } catch {
          // 单 session 失败跳过
        }
      }
    });
  }

  await Promise.all(tasks);

  const filtered = events.filter((e) => tsInWindow(e.ts, sinceMs, endMs));
  const hard = filtered.filter((e) => !e.soft);

  const bySource = new Map<string, number>();
  const byKind = new Map<string, number>();
  const byModel = new Map<string, number>();
  const byTool = new Map<string, number>();
  const byError = new Map<string, number>();
  const sessionSet = new Set<string>();

  for (const e of hard) {
    sessionSet.add(`${e.source}:${e.sessionId}`);
    bySource.set(e.source, (bySource.get(e.source) || 0) + 1);
    byKind.set(e.kind, (byKind.get(e.kind) || 0) + 1);
    byModel.set(e.model || 'unknown', (byModel.get(e.model || 'unknown') || 0) + 1);
    if (e.kind === 'tool') byTool.set(e.toolName || 'unknown', (byTool.get(e.toolName || 'unknown') || 0) + 1);
    byError.set(e.error || '(empty)', (byError.get(e.error || '(empty)') || 0) + 1);
  }

  const total = hard.length;
  const apiFailures = filtered.filter((e) => e.kind === 'api' && !e.soft);
  const samples = hard
    .slice()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, Math.min(12, top));

  return {
    range: { start: dayjs(sinceMs).format('YYYY-MM-DD'), end: dayjs(endMs).format('YYYY-MM-DD'), days },
    total,
    toolCount: hard.filter((e) => e.kind === 'tool').length,
    softCount: filtered.filter((e) => e.soft).length,
    apiCount: apiFailures.length,
    sessions: sessionSet.size,
    bySource: toDist(bySource, total, top),
    byKind: toDist(byKind, total),
    byModel: toDist(byModel, total, top),
    byTool: toDist(byTool, total, top),
    byError: toDist(byError, total, top),
    apiFailures: apiFailures.slice().sort((a, b) => b.ts - a.ts).slice(0, Math.min(30, top)),
    samples,
  };
}

function pathJoin(dir: string, file: string): string {
  return `${dir.replace(/\/$/, '')}/${file}`;
}