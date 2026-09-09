/**
 * skill-read 抽取与物化（session 级一行, reads 走 JSON 列）:
 * 口径 = Skill tool 调用 (skill/skill-tool) + 读 skill 目录文件 (read 类工具命中 skills/<name>/)。
 * 数据源: live detail messages (skill-reads --build 增量物化), 抽取逻辑与 session-tool-calls 同 part 口径。
 */
import type { SourceId } from './schema';
import { getStoreDb } from './db';
import { parseToolPart } from './session-tool-calls';

export interface SkillReadEvent {
  idx: number;
  /** skill-tool: Skill tool 调用; skill-file: 读 skill 目录下文件 */
  kind: 'skill-tool' | 'skill-file';
  /** 解析出的 skill 名 (tool input 或路径 skills/<name>/ 段) */
  skill: string;
  /** 触发的原始 tool 名 (Skill / read / read_file …) */
  tool: string;
  status: string;
  /** skill-file: 文件绝对/相对路径 */
  file?: string;
  /** skill-tool: 调用 args (无则缺省) */
  args?: string;
  msg_idx: number;
  turn: number;
  created_at: number | null;
}

export interface SkillReadsRecord {
  source: SourceId;
  session_id: string;
  read_count: number;
  reads: SkillReadEvent[];
  built_at: number;
}

/** read 类工具名 (大小写不敏感) */
const READ_TOOLS = new Set(['read', 'read_file', 'open_file', 'view']);
/** Skill tool 名 */
const SKILL_TOOLS = new Set(['skill']);
/** 路径中 skill 目录段: skills/<name>/ (含 .agents/skills、plugins cache 等嵌套) */
const SKILL_PATH_RE = /(?:^|\/)skills\/([A-Za-z0-9_.-]+)\//;

/** 从 tool input 提取文件路径 (各 source 字段名不一) */
function extractFilePath(input: any): string | null {
  if (input == null) return null;
  if (typeof input === 'string') return input;
  const v = input.file_path ?? input.filePath ?? input.path ?? input.file ?? input.filename;
  return typeof v === 'string' ? v : null;
}

/** Skill tool input 解析: zcode {skill,args} / opencode {name} / claude {command:"name args"} */
function parseSkillToolInput(input: any): { skill: string; args?: string } | null {
  if (input == null) return null;
  if (typeof input === 'string') {
    const s = input.trim();
    return s ? { skill: s.split(/\s+/)[0], args: s.slice(s.split(/\s+/)[0].length).trim() || undefined } : null;
  }
  const skill = input.skill ?? input.name ?? input.command ?? input.id;
  if (skill == null) return null;
  const raw = String(skill).trim().replace(/^\/+/, '');
  if (!raw) return null;
  const args = input.args ?? input.arguments;
  const parts = raw.split(/\s+/);
  return {
    skill: parts[0],
    args: (args != null ? String(args) : parts.slice(1).join(' ')) || undefined,
  };
}

/**
 * 从 unified detail messages 抽取 skill 读取事件。
 * turn 口径与 extractToolCalls 一致: 遇 user message 递增。
 */
export function extractSkillReads(messages: any[] | undefined | null): SkillReadEvent[] {
  const out: SkillReadEvent[] = [];
  let turn = -1;

  for (let i = 0; i < (messages?.length ?? 0); i++) {
    const m = messages![i];
    const info = m?.info || m || {};
    if (info.role === 'user') turn += 1;

    for (const p of m?.parts || []) {
      const parsed = parseToolPart(p);
      if (!parsed) continue;
      const toolName = parsed.name.toLowerCase();
      const createdAt = (info.time || {})?.created ?? (info.time || {})?.start ?? info.created_at ?? null;
      const base = { tool: parsed.name, status: parsed.status, msg_idx: i, turn: turn < 0 ? 0 : turn, created_at: typeof createdAt === 'number' ? createdAt : null };

      // Skill tool 调用
      if (SKILL_TOOLS.has(toolName)) {
        const parsedInput = parseSkillToolInput(parsed.input);
        if (parsedInput) {
          out.push({ ...base, idx: out.length, kind: 'skill-tool', skill: parsedInput.skill, args: parsedInput.args });
        }
        continue;
      }

      // 读 skill 目录文件
      if (READ_TOOLS.has(toolName)) {
        const file = extractFilePath(parsed.input);
        if (!file) continue;
        const mt = SKILL_PATH_RE.exec(file);
        if (!mt) continue;
        out.push({ ...base, idx: out.length, kind: 'skill-file', skill: mt[1], file });
      }
    }
  }
  return out;
}

// ==================== 物化表读写 ====================

/**
 * 全量替换某 session 的物化行（事务内 DELETE + INSERT）。
 *
 * 首次 build 空 events 时**不写 built_at**——留给下次增量重提，
 * 避免「某次 build 漏 extractor / live 失败」造成的死循环跳过。
 * 其它情况（有旧行 / events 非空）仍正常写 built_at。
 */
export function replaceSkillReads(
  source: SourceId,
  sessionId: string,
  events: SkillReadEvent[],
  builtAt = Date.now(),
): number {
  const db = getStoreDb();
  // 事务外 SELECT: 拿 DELETE 前的旧行存在性 (同事务内 SELECT 会看到 DELETE 后的 0)
  const existed = !!db
    .prepare('SELECT 1 AS x FROM skill_reads WHERE source = ? AND session_id = ?')
    .get(source, sessionId);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM skill_reads WHERE source = ? AND session_id = ?').run(source, sessionId);
    if (events.length === 0 && !existed) return;
    db.prepare(
      'INSERT INTO skill_reads (source, session_id, read_count, reads, built_at) VALUES (?, ?, ?, ?, ?)',
    ).run(source, sessionId, events.length, JSON.stringify(events), builtAt);
  });
  tx();
  return events.length;
}

/** 某 session 的物化时间（无行返回 null） */
export function getSkillReadsBuiltAt(source: SourceId, sessionId: string): number | null {
  const db = getStoreDb();
  const row = db
    .prepare('SELECT built_at FROM skill_reads WHERE source = ? AND session_id = ?')
    .get(source, sessionId) as { built_at: number | null } | undefined;
  return row?.built_at ?? null;
}

/** 读某 session 的物化记录（JSON 还原为事件数组） */
export function getSkillReads(source: SourceId, sessionId: string): SkillReadsRecord | null {
  const db = getStoreDb();
  const row = db
    .prepare('SELECT source, session_id, read_count, reads, built_at FROM skill_reads WHERE source = ? AND session_id = ?')
    .get(source, sessionId) as any;
  if (!row) return null;
  let reads: SkillReadEvent[] = [];
  try {
    reads = JSON.parse(row.reads);
  } catch {
    /* 理论不会发生: 写入侧 stringify */
  }
  return { source: row.source, session_id: row.session_id, read_count: row.read_count, reads, built_at: row.built_at };
}

export interface QuerySkillReadsFilters {
  /** skill 名 (大小写不敏感, 支持前缀模糊 %) */
  skill?: string;
  kind?: SkillReadEvent['kind'];
}

/** 全库检索（跨 session, 供导出/统计; 行级事件打平返回） */
export function querySkillReads(
  filters: QuerySkillReadsFilters = {},
): Array<SkillReadEvent & { source: SourceId; session_id: string }> {
  const db = getStoreDb();
  const where: string[] = ['1=1'];
  const params: any[] = [];
  if (filters.kind) {
    where.push(`EXISTS (SELECT 1 FROM json_each(skill_reads.reads) je WHERE je.value->>'kind' = ?)`);
    params.push(filters.kind);
  }
  if (filters.skill) {
    const op = filters.skill.includes('%') ? 'LIKE' : '=';
    where.push(`EXISTS (SELECT 1 FROM json_each(skill_reads.reads) je WHERE LOWER(je.value->>'skill') ${op} LOWER(?))`);
    params.push(filters.skill.toLowerCase());
  }
  const rows = db
    .prepare(`SELECT source, session_id, reads FROM skill_reads WHERE ${where.join(' AND ')}`)
    .all(...params) as any[];

  const out: Array<SkillReadEvent & { source: SourceId; session_id: string }> = [];
  for (const r of rows) {
    let reads: SkillReadEvent[] = [];
    try {
      reads = JSON.parse(r.reads);
    } catch {
      continue;
    }
    for (const e of reads) {
      if (filters.kind && e.kind !== filters.kind) continue;
      if (filters.skill) {
        const s = e.skill.toLowerCase();
        if (filters.skill.includes('%') ? !s.includes(filters.skill.replace(/%/g, '').toLowerCase()) : s !== filters.skill.toLowerCase()) continue;
      }
      out.push({ ...e, source: r.source, session_id: r.session_id });
    }
  }
  out.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  return out;
}
