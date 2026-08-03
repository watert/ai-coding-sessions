/**
 * Session trajectory helpers（Agent 友好 skeleton / detail 裁剪）
 */

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
  /** filter tool status (e.g. error, completed) */
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
}

export interface TraceStep {
  i: number;
  role: string;
  id: string;
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

function matchToolFilter(name: string, status: string, tool?: string, statusFilter?: string): boolean {
  if (tool && !name.toLowerCase().includes(tool.toLowerCase())) return false;
  if (statusFilter && !status.toLowerCase().includes(statusFilter.toLowerCase())) return false;
  return true;
}

function extractTools(parts: any[], opts: TraceBuildOptions): TraceToolRow[] {
  const maxOut = opts.maxOutputChars ?? 400;
  const includeIo = !!opts.includeIo;
  const rows: TraceToolRow[] = [];
  for (const p of parts || []) {
    if (p.type !== 'tool' && !p.tool) continue;
    const name = toolName(p);
    const status = toolStatus(p);
    if (!matchToolFilter(name, status, opts.tool, opts.status)) continue;
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
  const steps: TraceStep[] = [];

  for (let idx = 0; idx < sliced.length; idx++) {
    const m = sliced[idx];
    const info = msgInfo(m);
    const parts: any[] = m.parts || [];
    const tools = includeTools ? extractTools(parts, opts) : [];

    // if tool/status filter set, drop messages with no matching tools (unless user msg)
    const role = info.role || '?';
    if ((opts.tool || opts.status) && role !== 'user' && tools.length === 0) {
      // still keep if no tool parts at all? only keep matching tools
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
      i: from + idx,
      role,
      id: String(info.id || ''),
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
    if (!matchToolFilter(name, status, opts.tool, opts.status)) return null;
    const max = opts.maxOutputChars;
    if (max == null) return p;
    const next = { ...p };
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
