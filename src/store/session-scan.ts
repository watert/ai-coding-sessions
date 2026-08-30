/**
 * 跨 session prompt 检索 (issue #7 方向 H):
 * 缓存 prompts 表全文 (sync 落库), cache-first SQL 侧数据, 内嵌匹配仅此一处。
 * tool input 检索不走这里 — 用 tool-calls 导出 jsonl 后交给 agent grep/python。
 */
import type { UnifiedSessionInfo } from '../sources/types';

export interface ScanOptions {
  pattern: string;
  /** true 按 RegExp 匹配; 默认大小写不敏感 substring */
  regex?: boolean;
  /** preview 截断长度 (默认 200) */
  maxChars?: number;
  /** 每 session matches 上限 (默认 20) */
  maxMatches?: number;
}

export interface ScanMatcher {
  test: (s: string) => boolean;
  /** 首个命中下标; 无命中 -1 */
  index: (s: string) => number;
}

export interface ScanMatch {
  /** prompt 行 idx */
  idx: number;
  preview: string;
}

export interface ScanSessionResult {
  source: string;
  id: string;
  title: string | null;
  directory: string | null;
  project: string | null;
  models_used: string | null;
  last_active_at_iso: string | null;
  match_count: number;
  matches: ScanMatch[];
}

export interface ScanResult {
  ok: true;
  pattern: string;
  regex: boolean;
  scanned: number;
  matched: number;
  matches: ScanSessionResult[];
  notes: string[];
}

export type PromptRow = { idx: number; text: string };

export function buildScanMatcher(pattern: string, regex?: boolean): ScanMatcher {
  if (regex) {
    const re = new RegExp(pattern, 'i');
    return {
      test: (s) => re.test(s),
      index: (s) => {
        const m = re.exec(s);
        return m ? m.index : -1;
      },
    };
  }
  const needle = pattern.toLowerCase();
  const lower = (s: string) => s.toLowerCase();
  return {
    test: (s) => lower(s).includes(needle),
    index: (s) => lower(s).indexOf(needle),
  };
}

/** 以首个命中为中心截 preview (保留上下文, 而非从头截断) */
export function scanPreview(text: string, matcher: ScanMatcher, maxChars: number): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const i = matcher.index(flat);
  if (i < 0) return null;
  const start = Math.max(0, i - Math.floor(maxChars / 3));
  const end = Math.min(flat.length, start + maxChars);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

function sessionMeta(s: UnifiedSessionInfo) {
  return {
    source: s.source,
    id: s.id,
    title: s.title ?? null,
    directory: s.directory || null,
    project: s.project_name ?? s.project_id ?? null,
    models_used: s.models_used ?? null,
    last_active_at_iso: s.last_active_at_iso ?? null,
  };
}

export function scanPromptRows(
  rows: PromptRow[],
  matcher: ScanMatcher,
  maxChars: number,
  maxMatches: number,
): ScanMatch[] {
  const out: ScanMatch[] = [];
  for (const row of rows) {
    const preview = scanPreview(row.text, matcher, maxChars);
    if (preview == null) continue;
    out.push({ idx: row.idx, preview });
    if (out.length >= maxMatches) break;
  }
  return out;
}

export function scanSessions(
  sessions: UnifiedSessionInfo[],
  opts: ScanOptions,
  deps: { getPrompts: (s: UnifiedSessionInfo) => PromptRow[] },
): ScanResult {
  const matcher = buildScanMatcher(opts.pattern, opts.regex);
  const maxChars = opts.maxChars ?? 200;
  const maxMatches = opts.maxMatches ?? 20;

  const matches: ScanSessionResult[] = [];
  for (const s of sessions) {
    const hits = scanPromptRows(deps.getPrompts(s), matcher, maxChars, maxMatches);
    if (hits.length > 0) {
      matches.push({ ...sessionMeta(s), match_count: hits.length, matches: hits });
    }
  }

  return {
    ok: true,
    pattern: opts.pattern,
    regex: !!opts.regex,
    scanned: sessions.length,
    matched: matches.length,
    matches,
    notes: ['prompt matches 来自缓存 prompts 表 (sync 后落库); tool input 检索用 tool-calls 导出后自行 grep'],
  };
}
