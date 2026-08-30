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
import { listClaudeCodeSessions, listClaudeCodeMessages } from '../sources/claude-code';
import { listCodexSessions, listCodexMessages } from '../sources/codex-code';
import { listZcodeSessions, listZcodeMessages } from '../sources/zcode-code';
import { listWorkbuddySessions, readWorkbuddyJsonl } from '../sources/workbuddy-code';
import { classifySoftToolError } from '../sources/tool-error-soft';
import { classifyBashCategory, extractBashCmdFamily, extractBashExitCode, normCommand } from './bash-breakdown';

/** 已实现失败采集的 source */
export type FailureSource = 'grok' | 'opencode' | 'kimi' | 'claude' | 'codex' | 'zcode' | 'workbuddy';

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
  /** tool: bash 原始命令（BashBreakdown 三维列用） */
  command?: string;
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

/** source × model × tool 交叉行；含 top error 提示 */
export interface SourceModelToolRow {
  source: string;
  model: string;
  tool: string;
  count: number;
  pct: number;
  topError: string;
  topErrorCount: number;
}

/**
 * Bash 失败深掘。
 * byExitCode / byModel / samples 是稳定信息源；
 * byCmdFamily / byCategory / byCommand 在 T4 (#11) 落地后真正聚合（当前 FailureEvent 不携带
 * raw command，多为占位）；samples 内嵌字段缺失 raw command 时返回 null 而非占位字符串。
 */
export interface BashBreakdown {
  total: number;
  byExitCode: FailureDistRow[];
  byCmdFamily: FailureDistRow[];
  byCategory: FailureDistRow[];
  byCommand: FailureDistRow[];
  byModel: FailureDistRow[];
  samples: Array<{
    time: string;
    source: string;
    model: string;
    exitCode: string;
    /** 无 raw command 时为 null（MUST-FIX #3）；占位字符串不再下发 */
    category: string | null;
    /** 无 raw command 且无 ev.bash.cmdFamily 兜底时为 null */
    cmdFamily: string | null;
    /** 无 raw command 时为 null */
    command: string | null;
    error: string;
  }>;
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
  /** source × model × tool 交叉表（含 topError 提示） */
  bySourceModelTool: SourceModelToolRow[];
  /** Bash 失败深掘；无 bash 事件时 total=0 仍返回结构（渲染段用 total>0 控制） */
  bash: BashBreakdown;
  /** 每日 top 失败工具 (#10 快线): 日期 → 日内 top5 (count 降序, 日期倒序, 最多 30 天) */
  dailyTopFailedTools: Record<string, DailyToolFailRow[]>;
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

// ==================== 4 source 通用 helper ====================

/** 单个 part 提取出的工具元信息；非法 part 返回 null（调用方跳过） */
export interface ToolPartInfo {
  name: string;
  command?: string;
}

/**
 * 4 source 共用的 part 提取器。
 * 识别形态：
 *  - claude:    { type:'tool_use', name, input:{command,...} }
 *  - codex/zcode/opencode/kimi: { type:'tool', tool, state:{ input, status, error, output } }
 *  - 扩展: type:'tool_call' / 'function_call'（workbuddy 适配后形态）
 * 其它（tool_result / text / 缺字段）一律返回 null。
 */
export function extractToolPartInfo(part: unknown): ToolPartInfo | null {
  if (!part || typeof part !== 'object') return null;
  const p = part as Record<string, unknown>;
  const t = String(p.type || '').toLowerCase();
  if (t !== 'tool_use' && t !== 'tool' && t !== 'tool_call' && t !== 'function_call') return null;

  const name = String(p.name || p.tool || p.toolName || '').trim();
  if (!name) return null;

  // command 提取：input / state.input / arguments / 直接 command 字段
  const input = (p.input && typeof p.input === 'object' ? p.input : undefined) as Record<string, unknown> | undefined;
  const state = (p.state && typeof p.state === 'object' ? p.state : undefined) as Record<string, unknown> | undefined;
  const stateInput = state && typeof state.input === 'object' ? (state.input as Record<string, unknown>) : undefined;
  const args = p.arguments && typeof p.arguments === 'object' ? (p.arguments as Record<string, unknown>) : undefined;
  const directCmd = typeof p.command === 'string' ? p.command : undefined;

  const cmdRaw =
    (typeof input?.command === 'string' ? input.command : undefined)
    ?? (typeof stateInput?.command === 'string' ? stateInput.command : undefined)
    ?? (typeof stateInput?.cmd === 'string' ? stateInput.cmd : undefined)
    ?? (typeof args?.command === 'string' ? args.command : undefined)
    ?? directCmd;
  const command = typeof cmdRaw === 'string' && cmdRaw.length > 0 ? cmdRaw : undefined;

  return { name, command };
}

/** 归一工具名（对齐 host tool-call-stats.ts）：bash 类归 'bash'，File 类归 'file edit'，其余保名 lowercase */
export function normalizeToolName(name: string): string {
  const t = (name || 'unknown').trim();
  if (!t) return 'unknown';
  const lower = t.toLowerCase();
  if (lower === 'bash' || lower === 'sh' || lower === 'shell' || lower === 'exec_command' || lower === 'terminal') return 'bash';
  if (lower === 'read' || lower === 'write' || lower === 'edit' || lower === 'multi_edit' || lower === 'multiedit') return 'file edit';
  return lower;
}

/** 把任意 part 数组里所有命中的 part 转成 ToolPartInfo（用于测试/调试；collect 内部直接复用 extractToolPartInfo） */
export function extractToolPartInfos(parts: unknown): ToolPartInfo[] {
  if (!Array.isArray(parts)) return [];
  const out: ToolPartInfo[] = [];
  for (const part of parts) {
    const info = extractToolPartInfo(part);
    if (info) out.push(info);
  }
  return out;
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
      // 注：toolCalls 元素无 error 字段（grok 解析只产出 result/status/errorKind/errorSeverity），
      // 原 `|| tc.error` / `tc.result ?? tc.error` 恒取不到值，去掉以保持与类型一致
      const isError = !isSoft && (st === 'failed' || st === 'error');
      if (!isError && !isSoft) continue;
      const text = errText(tc.result);
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
      command: typeof state.input?.command === 'string' ? state.input.command : undefined,
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
          command: typeof state.input?.command === 'string' ? state.input.command : undefined,
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

// ==================== claude ====================

/**
 * Claude Code：listClaudeCodeMessages 返回的消息里 assistant 的 content 是数组，
 * 形如 `[{type:'tool_use', name, input:{command,...}, id}, {type:'text', text}]`。
 * tool_result 是单独的 user 消息（含 type:'tool_result' block），不进 collect（无 status=failed 字段）。
 */
export function collectClaudeSessionEvents(
  sessionId: string,
  sessionTitle: string | undefined,
  msgs: any[],
  sinceMs: number,
  endMs: number,
  out: FailureEvent[],
): void {
  for (const msg of msgs || []) {
    const ts = msg?.timestamp ? toMs(msg.timestamp) ?? msg.timestamp : 0;
    if (!ts || !tsInWindow(ts, sinceMs, endMs)) continue;
    const blocks = Array.isArray(msg?.message?.content) ? msg.message.content : Array.isArray(msg?.content) ? msg.content : [];
    for (const block of blocks) {
      const t = String(block?.type || '').toLowerCase();
      // claude 在 tool_use 同消息后常带 tool_result block（user message）。这里只关心 tool_use。
      if (t !== 'tool_use' && t !== 'tool_call') continue;
      const info = extractToolPartInfo(block);
      if (!info) continue;
      const input = (block?.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
      // Claude 当前 schema 无显式 status=failed；tool_result content 错误文本由后续 user message 承载。
      // 本 collector 仅在 tool_use block 自带 is_error=true（fixture 或 schema 扩展字段）时记一条 tool error。
      const isError = block?.is_error === true || block?.input?.is_error === true;
      if (!isError) continue;
      const raw = String(input?.error || input?.message || input?.output || '');
      const { isSoft, kind } = toolSoftFlag(errText(raw));
      const tsEvent = ts || 0;
      out.push({
        source: 'claude',
        sessionId,
        sessionTitle,
        ts: tsEvent,
        kind: 'tool',
        model: msg?.message?.model,
        toolName: normalizeToolName(info.name),
        command: info.command,
        soft: isSoft,
        errorKind: kind,
        error: isSoft ? normError(raw) || `soft:${kind || 'unknown'}` : normError(raw),
        errorRaw: raw.slice(0, 400).replace(/\s+/g, ' '),
      });
    }
  }
}

// ==================== codex ====================

/**
 * Codex：listCodexMessages 返回的 msg.parts 形态为 `{type:'tool', tool, callID, state:{status, input, output, error}}`。
 * 防御式：若 type 字段缺失或形态异常，extractToolPartInfo 也会兜底。
 */
export function collectCodexSessionEvents(
  sessionId: string,
  sessionTitle: string | undefined,
  msgs: any[],
  sinceMs: number,
  endMs: number,
  out: FailureEvent[],
): void {
  for (const msg of msgs || []) {
    const ts = msg?.timestamp || 0;
    if (!tsInWindow(ts, sinceMs, endMs)) continue;
    for (const part of msg?.parts || []) {
      // 先取 info 拿到 command；status/error 单独从 state 读（与 helper 解耦）
      const info = extractToolPartInfo(part);
      if (!info) continue;
      const state = (part && typeof part.state === 'object' ? part.state : {}) as Record<string, unknown>;
      const status = String(state.status || '').toLowerCase();
      const metadata = (state.metadata && typeof state.metadata === 'object' ? state.metadata : {}) as Record<string, unknown>;
      const isSoft = metadata.errorSeverity === 'soft';
      const isError = !isSoft && (status === 'failed' || status === 'error');
      if (!isError && !isSoft) continue;
      const raw = state.error ?? state.output ?? '';
      const { isSoft: soft, kind } = toolSoftFlag(errText(raw), state.metadata as Record<string, unknown> | undefined);
      out.push({
        source: 'codex',
        sessionId,
        sessionTitle,
        ts,
        kind: 'tool',
        model: msg?.model,
        toolName: normalizeToolName(info.name),
        command: info.command,
        soft,
        errorKind: kind,
        error: soft ? normError(raw) || `soft:${kind || 'unknown'}` : normError(raw),
        errorRaw: errText(raw).slice(0, 400).replace(/\s+/g, ' '),
      });
    }
  }
}

// ==================== zcode ====================

/**
 * ZCode：listZcodeMessages 返回的 msg.parts（DB part.data 解构）形态与 codex 类似：
 * `{type:'tool', tool, state:{status, input, output, error, metadata}}`。
 */
export function collectZcodeSessionEvents(
  sessionId: string,
  sessionTitle: string | undefined,
  msgs: any[],
  sinceMs: number,
  endMs: number,
  out: FailureEvent[],
): void {
  for (const msg of msgs || []) {
    const ts = msg?.timeCreated || msg?.timeUpdated || 0;
    if (!tsInWindow(ts, sinceMs, endMs)) continue;
    for (const part of msg?.parts || []) {
      const info = extractToolPartInfo(part);
      if (!info) continue;
      const state = (part && typeof part.state === 'object' ? part.state : {}) as Record<string, unknown>;
      const status = String(state.status || '').toLowerCase();
      const metadata = (state.metadata && typeof state.metadata === 'object' ? state.metadata : {}) as Record<string, unknown>;
      const isSoft = metadata.errorSeverity === 'soft';
      const isError = !isSoft && (status === 'failed' || status === 'error');
      if (!isError && !isSoft) continue;
      const raw = state.error ?? state.output ?? '';
      const { isSoft: soft, kind } = toolSoftFlag(errText(raw), state.metadata as Record<string, unknown> | undefined);
      // model 优先用 msg.modelUsage?.modelId，回退 data.role 之外的信息；这里保守用 modelUsage
      const model = msg?.modelUsage?.modelId;
      out.push({
        source: 'zcode',
        sessionId,
        sessionTitle,
        ts,
        kind: 'tool',
        model,
        toolName: normalizeToolName(info.name),
        command: info.command,
        soft,
        errorKind: kind,
        error: soft ? normError(raw) || `soft:${kind || 'unknown'}` : normError(raw),
        errorRaw: errText(raw).slice(0, 400).replace(/\s+/g, ' '),
      });
    }
  }
}

// ==================== workbuddy ====================

/**
 * WorkBuddy：jsonl events 流（不是嵌套 parts），主事件类型 `function_call` / `function_call_result`。
 * 这里先把每个 event 适配成 part-like（type:'function_call'），再走 extractToolPartInfo + state 同款读取。
 * 失败判定对齐 host：仅 `function_call_result` 且 status='failed'|'error' 才记。
 */
export function collectWorkbuddySessionEvents(
  sessionId: string,
  sessionTitle: string | undefined,
  events: any[],
  sinceMs: number,
  endMs: number,
  out: FailureEvent[],
): void {
  // 1) 先按 callId 累积 function_call 输入（提供 command / 模型元信息）
  type CallInfo = { args?: Record<string, unknown>; name?: string; ts?: number; model?: string };
  const calls = new Map<string, CallInfo>();
  for (const ev of events || []) {
    if (ev?.type !== 'function_call') continue;
    const cid = String(ev.callId || ev.id || '').trim();
    if (!cid) continue;
    const args = ev.arguments && typeof ev.arguments === 'object' ? ev.arguments as Record<string, unknown>
      : (typeof ev.arguments === 'string' ? safeParseJson(ev.arguments) : undefined) || {};
    calls.set(cid, { args, name: ev.name, ts: ev.timestamp, model: ev.providerData?.model || ev.providerData?.requestModelName });
  }

  // 2) 再扫 function_call_result 取 failed/error
  for (const ev of events || []) {
    if (ev?.type !== 'function_call_result') continue;
    const st = String(ev.status || '').toLowerCase();
    const isSoft = (ev as any).errorSeverity === 'soft';
    const isError = !isSoft && (st === 'failed' || st === 'error');
    if (!isError && !isSoft) continue;
    const ts = ev.timestamp || 0;
    if (!tsInWindow(ts, sinceMs, endMs)) continue;
    const cid = String(ev.callId || '').trim();
    const info = calls.get(cid);

    // 把 event 适配成 part-like 形态，给 extractToolPartInfo 统一处理
    const partLike = {
      type: 'function_call',
      name: ev.name || info?.name || 'unknown',
      input: info?.args || {},
    };
    const partInfo = extractToolPartInfo(partLike);
    if (!partInfo) continue;

    const errText = extractWorkbuddyErrorText(ev);
    const { isSoft: soft, kind } = toolSoftFlag(errText);
    out.push({
      source: 'workbuddy',
      sessionId,
      sessionTitle,
      ts,
      kind: 'tool',
      model: info?.model || (ev as any).providerData?.model,
      toolName: normalizeToolName(partInfo.name),
      command: partInfo.command,
      soft,
      errorKind: kind,
      error: soft ? normError(errText) || `soft:${kind || 'unknown'}` : normError(errText),
      errorRaw: errText.slice(0, 400).replace(/\s+/g, ' '),
    });
  }
}

function safeParseJson(s: string): Record<string, unknown> | undefined {
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function extractWorkbuddyErrorText(ev: any): string {
  const out = ev?.output;
  if (typeof out === 'string') return out;
  if (out && typeof out === 'object') {
    if (typeof out.text === 'string') return out.text;
    if (typeof out.content === 'string') return out.content;
    try {
      return JSON.stringify(out);
    } catch {
      return String(out);
    }
  }
  return String(ev?.status || 'error');
}

// ==================== 交叉 / 深掘聚合 ====================

/**
 * 聚合 source × model × tool 交叉行，每行附 topError / topErrorCount。
 * 仅 kind='tool' 进表；pct 分母用 tool events 数量（行都是 tool，避免总和 < 100% 误导）；
 * 当 tool events 为 0 时所有 pct=0。
 *
 * 复合 key 用结构化 bucket（`Map<string, SmtBucket>`）存 `{source, model, tool, count, errors}`，
 * 不再用 `\t` 拼接 → split 重建，避免 source/model/tool 含 `\t` 时错位。
 *
 * 并列 topError 策略：取首个最大的（Map 插入序）。
 * - 多个 error 都达最大计数时，取最先遇到的那条（不取最末或随机）。
 * - 当前实现：`if (c > topErrorCount)` 严格大于，并列时保留首个命中。
 */
export function aggregateSourceModelTool(events: FailureEvent[], top?: number): SourceModelToolRow[] {
  type SmtBucket = { source: string; model: string; tool: string; count: number; errors: Map<string, number> };
  const smtBuckets = new Map<string, SmtBucket>();
  for (const e of events) {
    if (e.kind !== 'tool') continue;
    const model = e.model || 'unknown';
    const tool = e.toolName || 'unknown';
    // 复合 key 用 `::` 仅作 bucket 查表去重（避免 `\t` 重叠错位），字段语义以 bucket 对象为准
    const key = `${e.source}::${model}::${tool}`;
    let bucket = smtBuckets.get(key);
    if (!bucket) {
      bucket = { source: e.source, model, tool, count: 0, errors: new Map() };
      smtBuckets.set(key, bucket);
    }
    bucket.count += 1;
    const err = e.error || '(empty)';
    bucket.errors.set(err, (bucket.errors.get(err) || 0) + 1);
  }
  const rows: SourceModelToolRow[] = Array.from(smtBuckets.values()).map((b) => {
    let topError = '(empty)';
    let topErrorCount = 0;
    for (const [err, c] of b.errors) {
      // 并列时仅 `>` 才覆盖 → 首个最大保留
      if (c > topErrorCount) { topErrorCount = c; topError = err; }
    }
    return { source: b.source, model: b.model, tool: b.tool, count: b.count, pct: 0, topError, topErrorCount };
  }).sort((a, b) => b.count - a.count);
  // pct 分母用 tool events 数（行都是 tool，避免总和 < 100% 误导）
  const toolTotal = events.filter((e) => e.kind === 'tool').length;
  for (const r of rows) r.pct = toolTotal > 0 ? (r.count / toolTotal) * 100 : 0;
  return top ? rows.slice(0, top) : rows;
}

/**
 * BashBreakdown 包装：调 buildBashBreakdown 拿 row 级数据，再聚合多维分布 + byModel + samples。
 * `byExitCode` / `byModel` / `samples` 不依赖 command 信息，始终可用；
 * 其余维度依赖 buildBashBreakdown 是否能从 ev.command/ev.bash 提取 family。
 *
 * samples 内嵌字段（category / cmdFamily / command）缺失 raw command 时返回 null，
 * 而非 `'(unknown)'` 占位字符串（MUST-FIX #3，避免下游误当真信息）。
 *
 * 导出供 `failure-stats.test.ts` 补 case（MUST-FIX #4：零单测）。
 */
export function wrapBashBreakdown(events: FailureEvent[], top: number = 20): BashBreakdown {
  const total = events.length;
  if (total === 0) {
    return { total: 0, byExitCode: [], byCmdFamily: [], byCategory: [], byCommand: [], byModel: [], samples: [] };
  }
  // 三维真聚合：逐事件提取 command → family / category / command 各自入桶（不按 (family,exitCode) 行去重）
  const byCmdFamily = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const byCommand = new Map<string, number>();
  for (const e of events) {
    const evAny = e as FailureEvent & { bash?: { command?: string; cmdFamily?: string } };
    const command = e.command ?? evAny.bash?.command ?? '';
    if (!command.trim() && !evAny.bash?.cmdFamily) continue;
    const family = evAny.bash?.cmdFamily ?? extractBashCmdFamily(command);
    byCmdFamily.set(family, (byCmdFamily.get(family) || 0) + 1);
    const category = classifyBashCategory(family);
    byCategory.set(category, (byCategory.get(category) || 0) + 1);
    const cmdKey = normCommand(command);
    byCommand.set(cmdKey, (byCommand.get(cmdKey) || 0) + 1);
  }
  const byExitCode = new Map<string, number>();
  for (const e of events) {
    const code = extractBashExitCode(e.errorRaw || e.error || '');
    const key = code !== undefined ? String(code) : '(unknown)';
    byExitCode.set(key, (byExitCode.get(key) || 0) + 1);
  }
  const byModel = new Map<string, number>();
  for (const e of events) {
    const m = e.model || 'unknown';
    byModel.set(m, (byModel.get(m) || 0) + 1);
  }
  const samples = events
    .slice()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5)
    .map((e) => {
      const ec = extractBashExitCode(e.errorRaw || e.error || '');
      // 推断 cmdFamily / category / command：无 raw command 时一律返回 null
      const evAny = e as FailureEvent & { bash?: { command?: string; cmdFamily?: string } };
      const command = e.command ?? evAny.bash?.command ?? '';
      const family = evAny.bash?.cmdFamily ?? (command ? extractBashCmdFamily(command) : '');
      const category = family ? classifyBashCategory(family) : null;
      return {
        time: dayjs(e.ts).format('MM-DD HH:mm'),
        source: e.source,
        model: e.model || 'unknown',
        exitCode: ec !== undefined ? String(ec) : '(unknown)',
        category,
        cmdFamily: family || null,
        command: command || null,
        error: e.error || '(empty)',
      };
    });
  return {
    total,
    byExitCode: toDist(byExitCode, total),
    byCmdFamily: toDist(byCmdFamily, total, top),
    byCategory: toDist(byCategory, total, top),
    byCommand: toDist(byCommand, total, top),
    byModel: toDist(byModel, total, top),
    samples,
  };
}

// ==================== 汇总 ====================

export interface DailyToolFailRow {
  key: string;
  count: number;
  /** 占当日 hard tool 失败数百分比 */
  pct: number;
}

/**
 * 每日 top 失败工具 (#10 快线): 失败事件按 ts 本地日期分桶, 日内 count 降序取 topN。
 * 输入须为 hard tool 事件 (api/soft 由调用方过滤); duck-typed 兼容 FailureEvent(ts) 与
 * 宿主 ToolErrorEvent(timestamp), 建议传归一化 toolName 后的事件避免同工具分裂成多桶。
 * 返回日期倒序, 最多 maxDays 天。
 */
export function dailyTopFailedTools(
  events: Array<{ ts?: number; timestamp?: number; toolName?: string; kind?: string; soft?: boolean }>,
  topN = 5,
  maxDays = 30,
): Record<string, DailyToolFailRow[]> {
  const byDay = new Map<string, Map<string, number>>();
  for (const e of events) {
    const ts = e.ts ?? e.timestamp ?? 0;
    if (!ts) continue;
    const date = dayjs(ts).format('YYYY-MM-DD');
    let dayMap = byDay.get(date);
    if (!dayMap) { dayMap = new Map(); byDay.set(date, dayMap); }
    const tool = e.toolName || 'unknown';
    dayMap.set(tool, (dayMap.get(tool) || 0) + 1);
  }
  const out: Record<string, DailyToolFailRow[]> = {};
  const days = Array.from(byDay.keys()).sort().reverse().slice(0, maxDays);
  for (const date of days) {
    const dayMap = byDay.get(date)!;
    const dayTotal = Array.from(dayMap.values()).reduce((a, b) => a + b, 0);
    out[date] = Array.from(dayMap.entries())
      .map(([key, count]) => ({ key, count, pct: dayTotal > 0 ? (count / dayTotal) * 100 : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, topN);
  }
  return out;
}

/**
 * 仅采集窗口内失败事件，不做聚合（宿主薄适配 #11 T5）。
 * 每个 source 独立 try/catch：单源失败不影响其他源结果。
 */
export async function collectFailureEvents(
  opts: FailureCollectOptions = {},
): Promise<{ events: FailureEvent[]; sinceMs: number; endMs: number; days: number }> {
  const source = opts.source ?? 'all';
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

  if (source === 'all' || source === 'claude') {
    run('claude', async () => {
      const sessions = await listClaudeCodeSessions();
      for (const s of sessions) {
        if ((s.timestamp || 0) < sinceMs) continue;
        try {
          const msgs = await listClaudeCodeMessages({ project: s.project, sessionId: s.sessionId });
          collectClaudeSessionEvents(s.sessionId, s.display, msgs, sinceMs, endMs, events);
        } catch {
          // 单 session 失败跳过
        }
      }
    });
  }

  if (source === 'all' || source === 'codex') {
    run('codex', async () => {
      const sessions = await listCodexSessions();
      for (const s of sessions) {
        if ((s.updatedAt || 0) < sinceMs) continue;
        try {
          const msgs = await listCodexMessages({ sessionId: s.sessionId, rolloutPath: s.rolloutPath });
          collectCodexSessionEvents(s.sessionId, s.title, msgs, sinceMs, endMs, events);
        } catch {
          // 单 session 失败跳过
        }
      }
    });
  }

  if (source === 'all' || source === 'zcode') {
    run('zcode', async () => {
      const sessions = await listZcodeSessions();
      for (const s of sessions) {
        if ((s.updatedAt || 0) < sinceMs) continue;
        try {
          const msgs = await listZcodeMessages(s.sessionId);
          collectZcodeSessionEvents(s.sessionId, s.title, msgs, sinceMs, endMs, events);
        } catch {
          // 单 session 失败跳过
        }
      }
    });
  }

  if (source === 'all' || source === 'workbuddy') {
    run('workbuddy', async () => {
      const sessions = await listWorkbuddySessions();
      for (const s of sessions) {
        if ((s.updatedAt || 0) < sinceMs) continue;
        try {
          const evts = readWorkbuddyJsonl(s.sessionId, s.jsonlPath);
          collectWorkbuddySessionEvents(s.sessionId, s.title, evts, sinceMs, endMs, events);
        } catch {
          // 单 session 失败跳过
        }
      }
    });
  }

  await Promise.all(tasks);

  return { events, sinceMs, endMs, days };
}

/**
 * 汇总近 N 天各 source 失败事件（采集 + 聚合）。
 */
export async function collectSessionFailures(
  opts: FailureCollectOptions = {},
): Promise<FailureAnalyzeResult> {
  const top = opts.top ?? 20;
  const { events, sinceMs, endMs, days } = await collectFailureEvents(opts);

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

  // 交叉聚合：source × model × tool
  const bySourceModelTool = aggregateSourceModelTool(hard, top);
  // Bash 深掘：bashEvents 为空时 wrapBashBreakdown 内部已返回 total=0 结构（NICE-FIX #1：bash 必填）
  const bashEvents = hard.filter((e) => e.kind === 'tool' && e.toolName === 'bash');
  const bash = wrapBashBreakdown(bashEvents, top);

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
    bySourceModelTool,
    bash,
    dailyTopFailedTools: dailyTopFailedTools(hard.filter((e) => e.kind === 'tool')),
    apiFailures: apiFailures.slice().sort((a, b) => b.ts - a.ts).slice(0, Math.min(30, top)),
    samples,
  };
}

function pathJoin(dir: string, file: string): string {
  return `${dir.replace(/\/$/, '')}/${file}`;
}