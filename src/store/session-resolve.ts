/**
 * Session 引用解析 + cwd 过滤（P0 handoff / list --cwd）
 * ref: latest | native id | path | free-text title
 */

import path from 'node:path';
import { resolveHomeDir } from '../lib/home-paths';
import type { UnifiedSessionInfo } from '../sources/types';

export type ResolveMatchKind = 'id' | 'latest' | 'title' | 'path';

export interface ResolvedSession {
  ok: true;
  session: UnifiedSessionInfo;
  match: ResolveMatchKind;
}

export interface ResolveAmbiguous {
  ok: false;
  error: 'ambiguous';
  reference: string;
  matches: Array<{
    id: string;
    source: string;
    title: string | null;
    directory: string | null;
    project_name: string | null;
    last_active_at_iso: string | null;
  }>;
  message: string;
}

export interface ResolveNotFound {
  ok: false;
  error: 'not_found';
  reference: string;
  message: string;
}

export type ResolveResult = ResolvedSession | ResolveAmbiguous | ResolveNotFound;

/** 规范化 cwd/路径：expand ~、绝对化、去尾斜杠 */
export function normalizeCwd(input: string, baseCwd: string = process.cwd()): string {
  let s = String(input || '').trim();
  if (!s) return '';
  if (s === '.' || s === './') s = baseCwd;
  if (s.startsWith('~/') || s.startsWith('~\\')) {
    s = path.join(resolveHomeDir(), s.slice(2));
  }
  try {
    s = path.resolve(baseCwd, s);
  } catch {
    // keep
  }
  // 统一分隔符，去尾 /
  s = s.replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** session 上可能代表「项目/工作目录」的路径候选 */
export function sessionPathCandidates(s: UnifiedSessionInfo): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [s.project_worktree, s.project_name, s.project_id, s.directory]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const t = raw.trim();
    // 仅保留像路径的（含 / 或盘符）
    if (!t.includes('/') && !t.includes('\\') && !/^[A-Za-z]:/.test(t)) continue;
    const n = normalizeCwd(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * cwd 匹配：exact 或互为祖先（repo 与 worktree / 子目录）
 * 默认匹配 project_worktree / project_name / project_id；
 * directory 多为 session 存储路径，仅 exact 时计入（避免 kimi 内部 dir 误伤）
 */
export function matchesCwd(
  session: UnifiedSessionInfo,
  cwd: string,
  opts?: { baseCwd?: string; includeDirectoryPrefix?: boolean },
): boolean {
  const target = normalizeCwd(cwd, opts?.baseCwd);
  if (!target) return true;

  const projectish = [session.project_worktree, session.project_name, session.project_id]
    .filter((v): v is string => typeof v === 'string' && !!v.trim())
    .map((v) => normalizeCwd(v, opts?.baseCwd))
    .filter(Boolean);

  for (const n of projectish) {
    if (n === target) return true;
    if (n.startsWith(`${target}/`) || target.startsWith(`${n}/`)) return true;
  }

  if (typeof session.directory === 'string' && session.directory.trim()) {
    const d = normalizeCwd(session.directory, opts?.baseCwd);
    if (d === target) return true;
    if (opts?.includeDirectoryPrefix && (d.startsWith(`${target}/`) || target.startsWith(`${d}/`))) {
      return true;
    }
  }

  return false;
}

export function filterSessionsByCwd(
  sessions: UnifiedSessionInfo[],
  cwd: string | undefined | null,
  opts?: { baseCwd?: string; includeDirectoryPrefix?: boolean },
): UnifiedSessionInfo[] {
  if (!cwd || !String(cwd).trim()) return sessions;
  return sessions.filter((s) => matchesCwd(s, cwd, opts));
}

function titleNorm(s?: string | null): string {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** display + custom + 源标题，供 resolve 子串匹配 */
function sessionTitleHaystack(s: UnifiedSessionInfo): string {
  return [s.title, s.custom_title, s.source_title].map(titleNorm).filter(Boolean).join('\n');
}

function compactMatch(s: UnifiedSessionInfo) {
  return {
    id: s.id,
    source: String(s.source || ''),
    title: s.title ?? null,
    directory: s.directory || null,
    project_name: (s.project_name as string) || null,
    last_active_at_iso: s.last_active_at_iso ?? null,
  };
}

function activityMs(s: UnifiedSessionInfo): number {
  if (s.last_active_at_iso) {
    const t = Date.parse(s.last_active_at_iso);
    if (Number.isFinite(t)) return t;
  }
  return s.time_updated || s.time_created || 0;
}

/** 从路径 basename 猜 session id */
export function sessionIdFromPath(ref: string): string | null {
  const base = path.basename(ref).replace(/\.jsonl(\.zst)?$/i, '');
  // uuid
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(base)) {
    return base;
  }
  // rollout-...-uuid
  const m = base.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (m) return m[1];
  // ses_ / session_
  if (/^(ses_|session_)/i.test(base) && base.length >= 8) return base;
  // grok-like 019f...
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(base)) {
    return base;
  }
  if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(base) && base.length >= 20) return base;
  return null;
}

function looksLikePath(ref: string): boolean {
  return (
    ref.includes('/') ||
    ref.includes('\\') ||
    ref.endsWith('.jsonl') ||
    ref.endsWith('.jsonl.zst') ||
    /^[A-Za-z]:/.test(ref)
  );
}

/**
 * 在已过滤的 session 列表上解析 ref。
 * - 空 / latest → 最近一条
 * - 精确 id（不区分大小写）
 * - 路径 → 抽 id
 * - 其余 → title 子串（歧义返回 candidates）
 */
export function resolveSessionRef(
  sessions: UnifiedSessionInfo[],
  ref?: string | null,
  opts?: { preferRoots?: boolean },
): ResolveResult {
  let pool = sessions.slice();
  if (opts?.preferRoots) {
    const roots = pool.filter((s) => s.parent_id == null || s.parent_id === '');
    if (roots.length) pool = roots;
  }
  pool.sort((a, b) => activityMs(b) - activityMs(a));

  // 支持从 URL 复制的 ref: session_xxx?source=kimi → 剥掉查询串
  const raw = (ref ?? '').trim().split('?')[0].trim();
  if (!raw || raw.toLowerCase() === 'latest') {
    if (!pool.length) {
      return {
        ok: false,
        error: 'not_found',
        reference: raw || 'latest',
        message: 'no session matched filters (cwd/source/window)',
      };
    }
    return { ok: true, session: pool[0], match: 'latest' };
  }

  // path → id
  if (looksLikePath(raw)) {
    const id = sessionIdFromPath(raw);
    if (id) {
      const hit = pool.find((s) => s.id.toLowerCase() === id.toLowerCase());
      if (hit) return { ok: true, session: hit, match: 'path' };
      // 也在未 preferRoots 的全集再找一次
      const hit2 = sessions.find((s) => s.id.toLowerCase() === id.toLowerCase());
      if (hit2) return { ok: true, session: hit2, match: 'path' };
      return {
        ok: false,
        error: 'not_found',
        reference: raw,
        message: `no session for path id ${id}`,
      };
    }
  }

  // exact id
  const exact = pool.filter((s) => s.id.toLowerCase() === raw.toLowerCase());
  if (exact.length === 1) return { ok: true, session: exact[0], match: 'id' };
  if (exact.length > 1) {
    // 跨 source 同 id 极少；仍按 ambiguous
    return {
      ok: false,
      error: 'ambiguous',
      reference: raw,
      matches: exact.map(compactMatch),
      message: `id ${raw} matched ${exact.length} sessions; pass --source=`,
    };
  }
  // 全集 id（含 subagent）
  const exactAll = sessions.filter((s) => s.id.toLowerCase() === raw.toLowerCase());
  if (exactAll.length === 1) return { ok: true, session: exactAll[0], match: 'id' };

  // title substring（display / custom / 源标题）
  const q = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  const titleHits = pool.filter((s) => sessionTitleHaystack(s).includes(q));
  if (titleHits.length === 1) return { ok: true, session: titleHits[0], match: 'title' };
  if (titleHits.length > 1) {
    return {
      ok: false,
      error: 'ambiguous',
      reference: raw,
      matches: titleHits.slice(0, 20).map(compactMatch),
      message: `title ${JSON.stringify(raw)} matched ${titleHits.length} sessions; pick --id= or refine --ref=`,
    };
  }

  return {
    ok: false,
    error: 'not_found',
    reference: raw,
    message: `no session matched ${JSON.stringify(raw)}`,
  };
}
