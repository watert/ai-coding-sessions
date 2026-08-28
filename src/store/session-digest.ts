/**
 * 多 session digest 聚合（面向自动化 memory 整理）
 * roots 列表 → 逐 session live detail → buildHandoff → 按 project 分组渲染。
 * 机械聚合、零 LLM；md 输出按 project 分组，可直接 append 到日度 memory 文件。
 */

import type { UnifiedSessionInfo } from '../sources/types';
import { buildHandoff, type SessionHandoff } from './session-handoff';

/** digest 单条：handoff 紧凑子集 + 列表统计字段 */
export interface DigestEntry {
  source: string;
  id: string;
  title: string | null;
  /** 分组键：project 路径（handoff.cwd → project_name → directory） */
  project: string;
  project_label: string;
  session_status: string | null;
  models_used: string | null;
  last_active_at_iso: string | null;
  turn_count: number;
  tool_error_hard: number;
  total_tokens: number | null;
  total_input: number | null;
  total_output: number | null;
  goal: string | null;
  stop_point: string | null;
  next_action: string | null;
  files_touched: string[];
  warnings: number;
}

export interface DigestSkip {
  source: string;
  id: string;
  reason: 'detail_not_found' | 'handoff_failed' | 'empty' | 'fetch_error';
}

export interface DigestGroup {
  project: string;
  project_label: string;
  sessions: DigestEntry[];
}

export interface DigestResult {
  ok: true;
  startDate: string | null;
  endDate: string | null;
  total_candidates: number;
  digested: number;
  skipped: DigestSkip[];
  groups: DigestGroup[];
}

/** 注入式 detail 获取（CLI 传 getSessionDetail 封装；测试传 mock） */
export type DigestDetailFetcher = (
  s: UnifiedSessionInfo,
) => Promise<Parameters<typeof buildHandoff>[0] | null>;

export interface BuildDigestOptions {
  startDate?: string;
  endDate?: string;
  /** files_touched 上限（默认 5） */
  maxFiles?: number;
  /** 透传 buildHandoff 的双 cap 覆盖 */
  textPreview?: number;
  /** digest 默认更紧凑：user 300 / assistant 1200 */
  userPreview?: number;
  assistantPreview?: number;
}

function basename(p: string): string {
  const t = p.replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i >= 0 ? t.slice(i + 1) : t;
}

function pickProject(s: UnifiedSessionInfo, h: SessionHandoff): string {
  return h.cwd || s.project_name || s.project_worktree || s.directory || '(unknown)';
}

/** 空 session：无 turn 且无 goal（没实际交互） */
function isEmptyHandoff(h: SessionHandoff): boolean {
  return h.turn_count === 0 && !h.goal && !h.last_user_request;
}

export async function buildDigest(
  sessions: UnifiedSessionInfo[],
  fetchDetail: DigestDetailFetcher,
  opts: BuildDigestOptions = {},
): Promise<DigestResult> {
  const maxFiles = opts.maxFiles ?? 5;
  const entries: DigestEntry[] = [];
  const skipped: DigestSkip[] = [];

  for (const s of sessions) {
    let detail: Parameters<typeof buildHandoff>[0] | null = null;
    try {
      detail = await fetchDetail(s);
    } catch {
      skipped.push({ source: String(s.source), id: s.id, reason: 'fetch_error' });
      continue;
    }
    if (!detail) {
      skipped.push({ source: String(s.source), id: s.id, reason: 'detail_not_found' });
      continue;
    }
    const h = buildHandoff(detail, {
      ...(opts.textPreview != null
        ? { textPreview: opts.textPreview }
        : { userPreview: opts.userPreview ?? 300, assistantPreview: opts.assistantPreview ?? 1200 }),
    });
    if (!h) {
      skipped.push({ source: String(s.source), id: s.id, reason: 'handoff_failed' });
      continue;
    }
    if (isEmptyHandoff(h)) {
      skipped.push({ source: String(s.source), id: s.id, reason: 'empty' });
      continue;
    }
    const project = pickProject(s, h);
    entries.push({
      source: h.source,
      id: h.id,
      title: s.title || h.title,
      project,
      project_label: project === '(unknown)' ? project : basename(project),
      session_status: h.session_status,
      models_used: h.models_used,
      last_active_at_iso: h.last_active_at_iso,
      turn_count: h.turn_count,
      tool_error_hard: h.tool_error_hard,
      total_tokens: s.total_tokens ?? null,
      total_input: s.total_input ?? null,
      total_output: s.total_output ?? null,
      goal: h.goal,
      stop_point: h.stop_point,
      next_action: h.next_action,
      files_touched: h.files_touched.slice(0, maxFiles),
      warnings: h.warnings.length,
    });
  }

  // 按 project 分组（保序：首次出现顺序）
  const groupMap = new Map<string, DigestGroup>();
  for (const e of entries) {
    let g = groupMap.get(e.project);
    if (!g) {
      g = { project: e.project, project_label: e.project_label, sessions: [] };
      groupMap.set(e.project, g);
    }
    g.sessions.push(e);
  }

  return {
    ok: true,
    startDate: opts.startDate ?? null,
    endDate: opts.endDate ?? null,
    total_candidates: sessions.length,
    digested: entries.length,
    skipped,
    groups: [...groupMap.values()],
  };
}

function fmtTokens(n: number | null): string | null {
  if (n == null) return null;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** md 渲染：按 project 分组，可直接 append 到日度 memory 文件 */
export function formatDigestMarkdown(result: DigestResult): string {
  const window =
    result.startDate || result.endDate
      ? `${result.startDate ?? '…'} ~ ${result.endDate ?? '…'}`
      : 'all';
  const bySource = new Map<string, number>();
  for (const g of result.groups) {
    for (const e of g.sessions) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
  }
  const srcSummary = [...bySource.entries()].map(([k, v]) => `${k}×${v}`).join(' ');

  const lines: string[] = [
    '# AI Coding Sessions Digest',
    '',
    `> window ${window} · digested ${result.digested}/${result.total_candidates} · ${srcSummary || 'none'}`,
    '',
  ];

  for (const g of result.groups) {
    lines.push(`## ${g.project_label} — \`${g.project}\``, '');
    for (const e of g.sessions) {
      const meta = [
        `\`${e.source}\``,
        e.session_status,
        e.turn_count ? `${e.turn_count} turns` : null,
        fmtTokens(e.total_tokens) ? `${fmtTokens(e.total_tokens)} tok` : null,
        e.tool_error_hard ? `hard-err ${e.tool_error_hard}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      lines.push(`- **${e.title || e.id}** ${meta}`);
      if (e.goal) lines.push(`  - goal: ${e.goal}`);
      if (e.stop_point) lines.push(`  - stop: ${e.stop_point}`);
      if (e.next_action) lines.push(`  - next: ${e.next_action}`);
      if (e.files_touched.length) {
        lines.push(`  - files: ${e.files_touched.map((f) => `\`${f}\``).join(' ')}`);
      }
    }
    lines.push('');
  }

  if (result.skipped.length) {
    lines.push(
      `<!-- skipped ${result.skipped.length}: ${result.skipped.map((s) => `${s.source}:${s.id}(${s.reason})`).join(', ')} -->`,
      '',
    );
  }
  return lines.join('\n');
}
