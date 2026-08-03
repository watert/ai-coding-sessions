/**
 * Session trajectory helpers（Agent 友好 skeleton / detail 裁剪）
 * P1: turn 分组 · soft-fail 暴露
 */

import { classifySoftToolError } from '../sources/tool-error-soft';

export interface TraceBuildOptions {
  /** include tool name rows (default true) */
  includeTools?: boolean;
  /** include tool input/output previews (default false) */
  includeIo?: boolean;
  /** include reasoning preview (default false) */
  includeReasoning?: boolean;
  /** user/assistant text preview length (default 120) */
  textPreview?: number;
  /** max chars per tool input/output when includeIo (default 400) */
  maxOutputChars?: number;
  /** filter tool name (case-insensitive substring) */
  tool?: string;
  /** filter tool status (e.g. error, completed, soft) */
  status?: string;
  /** message index range [from, to) */
  from?: number;
  to?: number;
  /** cap number of steps returned */
  maxSteps?: number;
}

export interface TraceToolRow {
  name: string;
  status: string;
  callID?: string;
  input_len?: number;
  output_len?: number;
  input_preview?: string;
  output_preview?: string;
  error_preview?: string;
  /** soft fail（用户中断 / rg 过大 / grok FileTooLarge 等） */
  soft?: boolean;
  soft_kind?: string;
}

export interface TraceStep {
  i: number;
  /** 0-based user turn（user boundary / parentID 链） */
  turn: number;
  /** 本 turn 内序号（含 user 步 = 0） */
  step_in_turn: number;
  role: string;
  id: string;
  parent_id?: string | null;
  t: number | null;
  done: number | null;
  duration_ms: number | null;
  model: string | null;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    total: number;
  } | null;
  tps: number | null;
  cost: number | null;
  parts: string[];
  text_preview: string | null;
  tools: TraceToolRow[];
  reasoning_preview?: string | null;
}

/** turn 聚合摘要 */
export interface TraceTurn {
  turn: number;
  user_i: number | null;
  user_id: string | null;
  step_count: number;
  tool_count: number;
  soft_tool_count: number;
  t_start: number | null;
  t_end: number | null;
  duration_ms: number | null;
  text_preview: string | null;
  tools: Record<string, number>;
}

export interface DetailShapeOptions {
  toolsOnly?: boolean;
  noReasoning?: boolean;
  maxOutputChars?: number;
  from?: number;
  to?: number;
  tool?: string;
  status?: string;
}

function previewText(s: string | undefined | null, max: number): string | null {
  if (s == null || s === '') return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function lenOf(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'string') return v.length;
  try {
    return JSON.stringify(v).length;
  } catch {
    return String(v).length;
  }
}

function asPreview(v: unknown, max: number): string | null {
  if (v == null) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return previewText(s, max);
}

function msgInfo(m: any): any {
  return m?.info || m || {};
}

function msgTime(info: any): { t: number | null; done: number | null } {
  const time = info.time || {};
  const t = time.created ?? time.start ?? info.created_at ?? null;
  const done = time.completed ?? time.end ?? null;
  return {
    t: typeof t === 'number' ? t : t != null ? Number(t) || null : null,
    done: typeof done === 'number' ? done : done != null ? Number(done) || null : null,
  };
}

function msgTokens(info: any): TraceStep['tokens'] {
  const tok = info.tokens;
  if (!tok || typeof tok !== 'object') return null;
  const cacheRead = tok.cacheRead ?? tok.cache?.read ?? 0;
  return {
    input: tok.input ?? 0,
    output: tok.output ?? 0,
    cache_read: cacheRead ?? 0,
    total: tok.total ?? (tok.input || 0) + (tok.output || 0) + (cacheRead || 0),
  };
}

function toolStatus(p: any): string {
  const st = p.state?.status ?? p.status ?? (typeof p.state === 'string' ? p.state : null);
  return st != null ? String(st) : '?';
}

function toolName(p: any): string {
  return p.tool || p.name || p.toolName || p.call?.name || '?';
}

/** soft 分类：metadata 优先，否则从 error/短 output 文本推断（避免大 I/O 全量 stringify） */
export function classifyToolPartSoft(p: any): { soft: boolean; kind?: string } {
  const meta = p?.state?.metadata || p?.metadata || {};
  if (meta.errorSeverity === 'soft' || meta.soft === true) {
    return { soft: true, kind: meta.errorKind ? String(meta.errorKind) : undefined };
  }
  if (p?.errorSeverity === 'soft') {
    return { soft: true, kind: p.errorKind ? String(p.errorKind) : undefined };
  }
  const status = toolStatus(p).toLowerCase();
  const error = p.state?.error ?? p.error;
  const output = p.state?.output ?? p.output ?? p.result;
  const probeSoft = (raw: unknown) => {
    if (raw == null) return { soft: false as const };
    if (typeof raw === 'string') {
      if (raw.length > 4000) return { soft: false as const };
      return classifySoftToolError({ error: raw });
    }
    // 对象仅扫常见字段，避免 JSON.stringify 大 payload
    if (typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      return classifySoftToolError({
        error: o.error ?? o.Error ?? o.message ?? o.output,
      });
    }
    return classifySoftToolError({ error: raw });
  };

  if (status === 'error' || status === 'failed' || error != null) {
    const cls = probeSoft(error ?? output);
    if (cls.soft) return { soft: true, kind: cls.kind };
  }
  // soft demote 为 completed 时，部分 source 只在短 output 留文案
  if (status === 'completed' || status === 'success') {
    const cls = probeSoft(output);
    if (cls.soft) return { soft: true, kind: cls.kind };
  }
  return { soft: false };
}

function matchToolFilter(
  name: string,
  status: string,
  soft: boolean,
  tool?: string,
  statusFilter?: string,
): boolean {
  if (tool && !name.toLowerCase().includes(tool.toLowerCase())) return false;
  if (!statusFilter) return true;
  const f = statusFilter.toLowerCase();
  const st = status.toLowerCase();
  if (f === 'soft') return soft;
  if (f === 'hard' || f === 'hard_error') {
    return !soft && (st.includes('error') || st.includes('fail'));
  }
  // soft demote 不当 error 命中
  if ((f === 'error' || f === 'failed' || f === 'fail') && soft) return false;
  return st.includes(f);
}

function extractTools(parts: any[], opts: TraceBuildOptions): TraceToolRow[] {
  const maxOut = opts.maxOutputChars ?? 400;
  const includeIo = !!opts.includeIo;
  const rows: TraceToolRow[] = [];
  for (const p of parts || []) {
    if (p.type !== 'tool' && !p.tool) continue;
    const name = toolName(p);
    const status = toolStatus(p);
    const softInfo = classifyToolPartSoft(p);
    if (!matchToolFilter(name, status, softInfo.soft, opts.tool, opts.status)) continue;
    const input = p.state?.input ?? p.input ?? p.args;
    const output = p.state?.output ?? p.output ?? p.result;
    const error = p.state?.error ?? p.error;
    const row: TraceToolRow = {
      name,
      status,
      callID: p.callID || p.callId || p.toolCallId || undefined,
      input_len: lenOf(input),
      output_len: lenOf(output),
    };
    if (softInfo.soft) {
      row.soft = true;
      if (softInfo.kind) row.soft_kind = softInfo.kind;
    }
    if (includeIo) {
      row.input_preview = asPreview(input, maxOut) ?? undefined;
      row.output_preview = asPreview(output, maxOut) ?? undefined;
      if (error != null) row.error_preview = asPreview(error, maxOut) ?? undefined;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * 给消息序列分配 turn：
 * 1. user → 新 turn
 * 2. assistant 带 parentID → 挂到对应用户 turn（否则当前 turn）
 * 3. 无 user 时 turn=0
 */
function buildTurnIndex(messages: any[]): {
  turnOf: number[];
  stepInTurnOf: number[];
  parentOf: Array<string | null>;
} {
  const turnOf: number[] = [];
  const stepInTurnOf: number[] = [];
  const parentOf: Array<string | null> = [];
  const idToTurn = new Map<string, number>();
  let turn = -1;
  let stepInTurn = 0;

  for (let i = 0; i < messages.length; i++) {
    const info = msgInfo(messages[i]);
    const role = String(info.role || '?');
    const id = info.id != null ? String(info.id) : '';
    const parentID = info.parentID ?? info.parent_id ?? null;
    const parentStr = parentID != null ? String(parentID) : null;

    if (role === 'user') {
      turn += 1;
      stepInTurn = 0;
      if (id) idToTurn.set(id, turn);
    } else if (parentStr && idToTurn.has(parentStr)) {
      turn = idToTurn.get(parentStr)!;
      // 同 turn 内序号递增：找本 turn 已有最大 step
      let maxStep = -1;
      for (let j = 0; j < i; j++) {
        if (turnOf[j] === turn) maxStep = Math.max(maxStep, stepInTurnOf[j]);
      }
      stepInTurn = maxStep + 1;
    } else {
      if (turn < 0) turn = 0;
      stepInTurn += 1;
    }

    if (id && role === 'user') idToTurn.set(id, turn);
    // assistant 也可作后续 parent（少见），登记便于链式
    if (id && !idToTurn.has(id)) idToTurn.set(id, turn);

    turnOf.push(turn);
    stepInTurnOf.push(stepInTurn);
    parentOf.push(parentStr);
  }

  return { turnOf, stepInTurnOf, parentOf };
}

/**
 * Build compact trajectory steps from unified detail messages.
 */
export function buildTraceSteps(messages: any[] | undefined | null, opts: TraceBuildOptions = {}): TraceStep[] {
  const list = Array.isArray(messages) ? messages : [];
  const from = opts.from ?? 0;
  const to = opts.to ?? list.length;
  const textPreview = opts.textPreview ?? 120;
  const includeTools = opts.includeTools !== false;
  const includeReasoning = !!opts.includeReasoning;
  const sliced = list.slice(from, to);
  const { turnOf, stepInTurnOf, parentOf } = buildTurnIndex(list);
  const steps: TraceStep[] = [];

  for (let idx = 0; idx < sliced.length; idx++) {
    const absIdx = from + idx;
    const m = sliced[idx];
    const info = msgInfo(m);
    const parts: any[] = m.parts || [];
    const tools = includeTools ? extractTools(parts, opts) : [];

    // if tool/status filter set, drop messages with no matching tools (unless user msg)
    const role = info.role || '?';
    if ((opts.tool || opts.status) && role !== 'user' && tools.length === 0) {
      const anyTool = parts.some((p) => p.type === 'tool' || p.tool);
      if (anyTool) continue;
      if (opts.tool || opts.status) continue;
    }

    const { t, done } = msgTime(info);
    const textParts = parts.filter((p) => p.type === 'text').map((p) => p.text || '').join('\n');
    const reasoningParts = parts
      .filter((p) => p.type === 'reasoning' || p.type === 'thinking')
      .map((p) => p.text || '')
      .join('\n');

    const step: TraceStep = {
      i: absIdx,
      turn: turnOf[absIdx] ?? 0,
      step_in_turn: stepInTurnOf[absIdx] ?? 0,
      role,
      id: String(info.id || ''),
      parent_id: parentOf[absIdx] ?? null,
      t,
      done,
      duration_ms: t != null && done != null && done >= t ? done - t : null,
      model: info.model?.modelID || info.modelID || null,
      tokens: msgTokens(info),
      tps: info.tps ?? info.meta?.tps ?? null,
      cost: info.cost ?? info.costUSD ?? null,
      parts: parts.map((p) => p.type || '?'),
      text_preview: previewText(textParts, textPreview),
      tools,
    };
    if (includeReasoning) {
      step.reasoning_preview = previewText(reasoningParts, textPreview);
    }
    steps.push(step);
    if (opts.maxSteps != null && steps.length >= opts.maxSteps) break;
  }

  return steps;
}

/** Summarize tools across steps */
export function summarizeTraceTools(steps: TraceStep[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of steps) {
    for (const t of s.tools) {
      out[t.name] = (out[t.name] || 0) + 1;
    }
  }
  return out;
}

/** 按 turn 聚合 skeleton */
export function summarizeTraceTurns(steps: TraceStep[]): TraceTurn[] {
  const byTurn = new Map<number, TraceStep[]>();
  for (const s of steps) {
    const list = byTurn.get(s.turn) || [];
    list.push(s);
    byTurn.set(s.turn, list);
  }
  const turns: TraceTurn[] = [];
  for (const turn of Array.from(byTurn.keys()).sort((a, b) => a - b)) {
    const list = byTurn.get(turn)!;
    const user = list.find((s) => s.role === 'user');
    const tools: Record<string, number> = {};
    let tool_count = 0;
    let soft_tool_count = 0;
    let t_start: number | null = null;
    let t_end: number | null = null;
    for (const s of list) {
      if (s.t != null) t_start = t_start == null ? s.t : Math.min(t_start, s.t);
      const endCand = s.done ?? s.t;
      if (endCand != null) t_end = t_end == null ? endCand : Math.max(t_end, endCand);
      for (const t of s.tools) {
        tools[t.name] = (tools[t.name] || 0) + 1;
        tool_count += 1;
        if (t.soft) soft_tool_count += 1;
      }
    }
    turns.push({
      turn,
      user_i: user?.i ?? null,
      user_id: user?.id ?? null,
      step_count: list.length,
      tool_count,
      soft_tool_count,
      t_start,
      t_end,
      duration_ms: t_start != null && t_end != null && t_end >= t_start ? t_end - t_start : null,
      text_preview: user?.text_preview ?? list[0]?.text_preview ?? null,
      tools,
    });
  }
  return turns;
}

function truncateDeep(v: unknown, max: number): unknown {
  if (v == null) return v;
  if (typeof v === 'string') {
    return v.length <= max ? v : `${v.slice(0, max)}…`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => truncateDeep(x, max));
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      o[k] = truncateDeep(val, max);
    }
    return o;
  }
  return v;
}

function shapePart(p: any, opts: DetailShapeOptions): any | null {
  const type = p.type || '?';
  if (opts.noReasoning && (type === 'reasoning' || type === 'thinking')) return null;
  if (opts.toolsOnly && type !== 'tool' && !p.tool) {
    // keep step markers lightly for opencode structure
    if (type === 'step-start' || type === 'step-finish') return { type, id: p.id };
    return null;
  }
  if (type === 'tool' || p.tool) {
    const name = toolName(p);
    const status = toolStatus(p);
    const softInfo = classifyToolPartSoft(p);
    if (!matchToolFilter(name, status, softInfo.soft, opts.tool, opts.status)) return null;
    const max = opts.maxOutputChars;
    let next = p;
    if (max != null) {
      next = { ...p };
      if (next.state && typeof next.state === 'object') {
        next.state = { ...next.state };
        if (next.state.input != null) next.state.input = truncateDeep(next.state.input, max);
        if (next.state.output != null) next.state.output = truncateDeep(next.state.output, max);
        if (next.state.error != null) next.state.error = truncateDeep(next.state.error, max);
      }
      if (next.input != null) next.input = truncateDeep(next.input, max);
      if (next.output != null) next.output = truncateDeep(next.output, max);
      if (next.args != null) next.args = truncateDeep(next.args, max);
      if (typeof next.text === 'string' && next.text.length > max) {
        next.text = `${next.text.slice(0, max)}…`;
      }
    }
    // 保证 soft 分类在 part 上可见（即使 source 未写 metadata）
    if (softInfo.soft) {
      next = { ...next };
      const state = next.state && typeof next.state === 'object' ? { ...next.state } : {};
      const metadata = { ...(state.metadata || {}), errorSeverity: 'soft', errorKind: softInfo.kind };
      next.state = { ...state, metadata };
    }
    return next;
  }
  if (opts.maxOutputChars != null && typeof p.text === 'string' && p.text.length > opts.maxOutputChars) {
    return { ...p, text: `${p.text.slice(0, opts.maxOutputChars)}…` };
  }
  return p;
}

/**
 * Shape detail messages for agent context limits.
 */
export function shapeDetailMessages(messages: any[] | undefined | null, opts: DetailShapeOptions = {}): any[] {
  const list = Array.isArray(messages) ? messages : [];
  const from = opts.from ?? 0;
  const to = opts.to ?? list.length;
  const out: any[] = [];
  for (const m of list.slice(from, to)) {
    const parts = (m.parts || [])
      .map((p: any) => shapePart(p, opts))
      .filter((p: any) => p != null);
    if (opts.toolsOnly && parts.every((p: any) => p.type !== 'tool' && !p.tool)) {
      const role = msgInfo(m).role;
      if (role !== 'user') continue;
    }
    if ((opts.tool || opts.status) && !parts.some((p: any) => p.type === 'tool' || p.tool)) {
      const role = msgInfo(m).role;
      if (role !== 'user') continue;
    }
    out.push({ ...m, parts });
  }
  return out;
}
