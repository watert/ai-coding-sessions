/**
 * 跨 session tool call 导出（issue #7 方向 D 落地）:
 * 数据出口与检索解耦 — CLI 只吐结构化 jsonl, grep/jq/python 由 agent 接管。
 * 数据源: tool_calls 物化表 (tool-calls --build 按需构建, cache-first) / live detail (--live)。
 */
import type { UnifiedSessionInfo } from '../sources/types';
import type { SourceId } from './schema';
import { getStoreDb } from './db';

export interface ToolCallRecord {
  source: string;
  session_id: string;
  /** session 内 tool call 序号 (0..N) */
  idx: number;
  msg_idx: number | null;
  turn: number | null;
  tool: string;
  status: string;
  soft: boolean;
  /** tool input 原文: 字符串或解析后的对象 (jq/python 直接可用) */
  input: unknown;
  input_len: number;
  output_len: number | null;
  error: string | null;
  created_at: number | null;
}

export interface ToolCallExtractOptions {
  /** 附带 output preview (截断), 默认只有 output_len */
  maxOutputChars?: number;
  /** 只取指定 tool 名 (大小写不敏感) */
  tool?: string;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

/** 与 session-trace 同口径识别 tool part（统一消息格式, 7 source 通用） */
function parseToolPart(p: any): { name: string; status: string; input: unknown } | null {
  if (p.type !== 'tool' && !p.tool) return null;
  const name = String(p.tool || p.name || p.toolName || p.call?.name || '?');
  const status = String(p.state?.status ?? p.status ?? (typeof p.state === 'string' ? p.state : '?'));
  const input = p.state?.input ?? p.input ?? p.args;
  return { name, status, input };
}

/**
 * 从 unified detail messages 提取全部 tool call（含 input 全文, 不截断）。
 * turn 口径: 遇 user message 递增（与 trace 的 turn 语义近似）。
 */
export function extractToolCalls(
  messages: any[] | undefined | null,
  opts: ToolCallExtractOptions = {},
): Array<Omit<ToolCallRecord, 'source' | 'session_id'>> {
  const toolFilter = opts.tool?.toLowerCase();
  const out: Array<Omit<ToolCallRecord, 'source' | 'session_id'>> = [];
  let turn = -1;

  for (let i = 0; i < (messages?.length ?? 0); i++) {
    const m = messages![i];
    const info = m?.info || m || {};
    if (info.role === 'user') turn += 1;
    const parts: any[] = m?.parts || [];
    const time = info.time || {};
    const createdAt = time.created ?? time.start ?? info.created_at ?? null;

    for (const p of parts) {
      const parsed = parseToolPart(p);
      if (!parsed) continue;
      if (toolFilter && parsed.name.toLowerCase() !== toolFilter) continue;

      const input = parsed.input;
      const inputLen = input == null ? 0 : typeof input === 'string' ? input.length : safeStringify(input).length;
      const output = p.state?.output ?? p.output ?? p.result;
      const error = p.state?.error ?? p.error;

      // soft 分类: metadata 优先, 否则 error/短 output 文本启发（与 tool-error-soft 同口径入口）
      const meta = p?.state?.metadata || p?.metadata || {};
      let soft = meta.errorSeverity === 'soft' || meta.soft === true || p?.errorSeverity === 'soft';
      if (!soft && error != null && typeof error === 'string') {
        const st = parsed.status.toLowerCase();
        soft = st.includes('abort') || (error.length < 4000 && /user abort|operation was aborted/i.test(error));
      }

      const row: Omit<ToolCallRecord, 'source' | 'session_id'> = {
        idx: out.length,
        msg_idx: i,
        turn: turn < 0 ? 0 : turn,
        tool: parsed.name,
        status: parsed.status,
        soft,
        input,
        input_len: inputLen,
        output_len: output == null ? null : typeof output === 'string' ? output.length : safeStringify(output).length,
        error: error == null ? null : typeof error === 'string' ? error.slice(0, 2000) : safeStringify(error).slice(0, 2000),
        created_at: typeof createdAt === 'number' ? createdAt : null,
      };

      if (opts.maxOutputChars != null && output != null) {
        const text = typeof output === 'string' ? output : safeStringify(output);
        (row as any).output_preview = text.length > opts.maxOutputChars ? `${text.slice(0, opts.maxOutputChars)}…` : text;
      }
      out.push(row);
    }
  }
  return out;
}

// ==================== 物化表读写 ====================

/** 全量替换某 session 的物化行（事务内 DELETE + INSERT） */
export function replaceToolCalls(
  source: SourceId,
  sessionId: string,
  rows: Array<Omit<ToolCallRecord, 'source' | 'session_id'>>,
  builtAt = Date.now(),
): number {
  const db = getStoreDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM tool_calls WHERE source = ? AND session_id = ?').run(source, sessionId);
    const ins = db.prepare(
      `INSERT INTO tool_calls (source, session_id, idx, msg_idx, turn, tool, status, soft, input, input_len, output_len, error, created_at, built_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      ins.run(
        source,
        sessionId,
        r.idx,
        r.msg_idx,
        r.turn,
        r.tool,
        r.status,
        r.soft ? 1 : 0,
        typeof r.input === 'string' ? r.input : r.input == null ? null : safeStringify(r.input),
        r.input_len,
        r.output_len,
        r.error,
        r.created_at,
        builtAt,
      );
    }
  });
  tx();
  return rows.length;
}

/** 某 session 的物化时间（无行返回 null） */
export function getToolCallsBuiltAt(source: SourceId, sessionId: string): number | null {
  const db = getStoreDb();
  const row = db
    .prepare('SELECT MAX(built_at) AS built_at FROM tool_calls WHERE source = ? AND session_id = ?')
    .get(source, sessionId) as { built_at: number | null };
  return row?.built_at ?? null;
}

export interface QueryToolCallsFilters {
  source?: SourceId | 'all';
  tool?: string;
  status?: string;
  /** 仅非 soft */
  noSoft?: boolean;
  limit?: number;
}

/** 物化表读取（session 顺序由调用方传入的 ids 决定, 保证与 queryCached 排序一致） */
export function queryToolCallsBySession(
  source: SourceId,
  sessionId: string,
  filters: QueryToolCallsFilters = {},
): ToolCallRecord[] {
  const db = getStoreDb();
  const where: string[] = ['source = ?', 'session_id = ?'];
  const params: any[] = [source, sessionId];
  if (filters.tool) {
    where.push('tool = ? COLLATE NOCASE');
    params.push(filters.tool);
  }
  if (filters.status) {
    where.push('status = ?');
    params.push(filters.status);
  }
  if (filters.noSoft) where.push('soft = 0');
  const sql = `SELECT idx, msg_idx, turn, tool, status, soft, input, input_len, output_len, error, created_at
               FROM tool_calls WHERE ${where.join(' AND ')} ORDER BY idx ASC`;
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r) => ({
    source,
    session_id: sessionId,
    idx: r.idx,
    msg_idx: r.msg_idx,
    turn: r.turn,
    tool: r.tool,
    status: r.status,
    soft: !!r.soft,
    input: tryParseJson(r.input),
    input_len: r.input_len ?? 0,
    output_len: r.output_len,
    error: r.error,
    created_at: r.created_at,
  }));
}

/** 物化表存的 JSON 文本还原成对象 (jq/python 直用) */
function tryParseJson(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  const t = s.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  return s;
}

/** session meta 头（导出行冗余, 便于脱离上下文后 grep 仍可归因） */
export function toolCallHeader(s: UnifiedSessionInfo): Record<string, unknown> {
  return {
    source: s.source,
    session_id: s.id,
    session_title: s.title ?? null,
    directory: s.directory || null,
    models_used: s.models_used ?? null,
  };
}
