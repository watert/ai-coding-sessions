/**
 * Pi (badlogic/pi-mono) 本地数据访问
 *
 * 数据落盘: ~/.pi/agent/sessions/<cwd-slug>/<ISO-ts>_<uuid>.jsonl
 * - 首行: {type:"session", version:3, id, timestamp, cwd}
 * - 事件流: session | model_change | thinking_level_change | message
 * - 未知 type 事件容错跳过（v3 格式仍在快速迭代）
 * 无原生 title；title 用首条 user text 截断（v1 接受 isWeakTitle 不认现状）
 */

import fs from 'fs';
import path from 'path';
import { splitLines } from '../lib/jsonl-cache';
import { resolveHomeDir } from '../lib/home-paths';

// ==================== 路径 ====================

/**
 * Pi sessions 根解析
 * - PI_SESSIONS_DIR 直接当 sessions 根使用（basename 即便不是 sessions 也认）
 * - PI_HOME 当 ~/.pi，自动拼 /agent/sessions
 * - 缺省：~/.pi/agent/sessions
 */
export function resolvePiSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveHomeDir(env);

  // PI_SESSIONS_DIR 优先：env 直接给 sessions 根，不做 normalize
  if (env.PI_SESSIONS_DIR?.trim()) {
    return path.resolve(env.PI_SESSIONS_DIR.trim());
  }
  // PI_HOME：~/.pi，自动拼 agent/sessions
  if (env.PI_HOME?.trim()) {
    const abs = path.resolve(env.PI_HOME.trim());
    if (path.basename(abs) === 'agent') return path.join(abs, 'sessions');
    return path.join(abs, 'agent', 'sessions');
  }
  return path.join(home, '.pi', 'agent', 'sessions');
}

/** @deprecated 兼容旧引用；运行时请用 getPiSessionsRoot() 以支持 env 注入 */
export const PI_SESSIONS_ROOT = resolvePiSessionsRoot();

export function getPiSessionsRoot(): string {
  return resolvePiSessionsRoot();
}

// ==================== 类型 ====================

/** pi session header (首行 type=session) */
export type PiSessionHeader = {
  type: 'session';
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
};

/** pi message envelope (顶层含 id/parentId/timestamp; message 含 role) */
export type PiMessageEnvelope = {
  type: 'message';
  id: string;
  parentId: string | null;
  timestamp: string;
  message: {
    role: 'user' | 'assistant' | 'toolResult';
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string; thinkingSignature?: string }
      | {
          type: 'toolCall';
          id: string;
          name: string;
          arguments: Record<string, any>;
        }
    >;
    /** assistant only */
    api?: string;
    provider?: string;
    model?: string;
    stopReason?: string;
    rawStopReason?: string;
    responseId?: string;
    timestamp?: number;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    };
    /** toolResult only */
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    /** toolResult timestamp (ms) */
    timestamp2?: number;
  };
};

export type PiEvent = PiMessageEnvelope | { type: string; [k: string]: any };

/** list / listRefs 返回的最少元数据（懒解析 jsonl 内容） */
export type PiSessionItem = {
  sessionId: string;
  /** jsonl 路径 */
  filePath: string;
  /** cwd-slug 目录名（仅展示 / 调试） */
  cwdSlug: string;
  /** 来自 session header 的 cwd */
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** 第一条 user message 的截断预览（v1 用作 title） */
  firstUserText?: string;
  /** mtime:size 形式的便宜脏标记 */
  dirtyMark: string;
  /** 文件 mtime ms */
  mtimeMs: number;
  /** 文件 size bytes */
  size: number;
};

/** 单条 jsonl 内的轻量行迭代（容错） */
export type PiRawLine = Record<string, any>;

// ==================== 内部 helpers ====================

function numTs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.trim()) {
    const d = Date.parse(v);
    if (Number.isFinite(d) && d > 0) return d;
  }
  return 0;
}

/** 仅读首行解析 session header（轻量，list 路径） */
function readHeader(filePath: string): PiSessionHeader | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    // 仅取首条非空行
    for (const line of splitLines(raw)) {
      const t = line.trim();
      if (!t) continue;
      let obj: any;
      try {
        obj = JSON.parse(t);
      } catch {
        return null;
      }
      if (obj && obj.type === 'session') return obj as PiSessionHeader;
      // 兜底：首行不是 session 也算无 header
      return null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 文件 stat → dirty mark 与 mtime */
function fileStat(filePath: string): { mtimeMs: number; size: number } {
  try {
    const st = fs.statSync(filePath);
    return { mtimeMs: Math.floor(st.mtimeMs), size: st.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

/** 扫 root 下两级目录，列出 jsonl（cwd-slug/<file>.jsonl） */
function walkSessionFiles(root: string): Array<{ filePath: string; cwdSlug: string }> {
  if (!fs.existsSync(root)) return [];
  const out: Array<{ filePath: string; cwdSlug: string }> = [];
  let projDirs: fs.Dirent[];
  try {
    projDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const pd of projDirs) {
    if (!pd.isDirectory() || pd.name.startsWith('.')) continue;
    const projDir = path.join(root, pd.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      out.push({ filePath: path.join(projDir, f.name), cwdSlug: pd.name });
    }
  }
  return out;
}

// ==================== 列表 ====================

/**
 * 列出全部 pi session（解析首行 + stat；不读全文）
 * 用法：listSessions/convert 调用；不含 listRefs 用的脏标记聚合
 */
export async function listPiCodeSessions(): Promise<PiSessionItem[]> {
  const root = getPiSessionsRoot();
  const files = walkSessionFiles(root);
  const out: PiSessionItem[] = [];
  for (const { filePath, cwdSlug } of files) {
    const header = readHeader(filePath);
    if (!header || !header.id) continue;
    const stat = fileStat(filePath);
    out.push({
      sessionId: header.id,
      filePath,
      cwdSlug,
      cwd: header.cwd || '',
      createdAt: numTs(header.timestamp),
      updatedAt: stat.mtimeMs || numTs(header.timestamp),
      dirtyMark: `${stat.mtimeMs}:${stat.size}`,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/**
 * 仅 listRefs 用的轻量扫描：mtime:size 脏标记 + first_user_text 预览
 * 不解析完整 jsonl；仅前 30 行扫首条 user text
 */
export async function listPiSessionRefs(): Promise<PiSessionItem[]> {
  const root = getPiSessionsRoot();
  const files = walkSessionFiles(root);
  const out: PiSessionItem[] = [];
  for (const { filePath, cwdSlug } of files) {
    const header = readHeader(filePath);
    if (!header || !header.id) continue;
    const stat = fileStat(filePath);
    // 找首条 user text（最多读前 ~64KB，足够覆盖首条 prompt）
    let firstUserText: string | undefined;
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(65536);
        const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
        const chunk = buf.subarray(0, bytes).toString('utf-8');
        for (const line of splitLines(chunk)) {
          const t = line.trim();
          if (!t) continue;
          let obj: any;
          try {
            obj = JSON.parse(t);
          } catch {
            continue;
          }
          if (obj?.type === 'message' && obj.message?.role === 'user') {
            const c = obj.message.content?.[0];
            if (c?.type === 'text' && typeof c.text === 'string') {
              firstUserText = c.text.slice(0, 80);
              break;
            }
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* ignore */
    }
    out.push({
      sessionId: header.id,
      filePath,
      cwdSlug,
      cwd: header.cwd || '',
      createdAt: numTs(header.timestamp),
      updatedAt: stat.mtimeMs || numTs(header.timestamp),
      dirtyMark: `${stat.mtimeMs}:${stat.size}`,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      firstUserText,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** 按 sessionId 精确取 item（list 走一遍；detail 找不到时回退用） */
export async function getPiSession(sessionId: string): Promise<PiSessionItem | null> {
  const list = await listPiCodeSessions();
  return list.find((s) => s.sessionId === sessionId) || null;
}

/** 读取整个 jsonl 并解析为原始 events（容错：单行失败跳过） */
export function readPiSessionEvents(filePath: string): PiEvent[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const out: PiEvent[] = [];
    for (const line of splitLines(raw)) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as PiEvent);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ==================== 增强解析（pi-source 用） ====================

export type PiSessionParsed = {
  header?: PiSessionHeader;
  events: PiEvent[];
  /** 最后一条 assistant 的 stopReason（用于 status 映射） */
  lastStopReason?: string;
  /** assistant usage.cost.total 聚合（real reported） */
  reportedCostUsd: number;
  /** 末条 model_change 的 provider/modelId */
  provider?: string;
  modelId?: string;
  /** 首条 user text 截断（v1 title） */
  firstUserText?: string;
};

/**
 * 解析整个 pi session：header + events + 末条 assistant stopReason + reportedCostUsd。
 * 未知 type 事件容错跳过（switch default no-op）。
 */
export function parsePiSession(filePath: string): PiSessionParsed {
  const out: PiSessionParsed = { events: [], reportedCostUsd: 0 };
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    let lastModel: { provider?: string; modelId?: string } | null = null;
    for (const line of splitLines(raw)) {
      const t = line.trim();
      if (!t) continue;
      let ev: any;
      try {
        ev = JSON.parse(t);
      } catch {
        continue;
      }
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') continue;
      out.events.push(ev as PiEvent);
      switch (ev.type) {
        case 'session':
          out.header = {
            type: 'session',
            version: Number(ev.version) || 1,
            id: ev.id || '',
            timestamp: ev.timestamp || '',
            cwd: ev.cwd || '',
          };
          break;
        case 'model_change':
          lastModel = { provider: ev.provider, modelId: ev.modelId };
          break;
        case 'message':
          if (ev.message?.role === 'assistant') {
            out.lastStopReason = ev.message.stopReason || out.lastStopReason;
            const costTotal = ev.message.usage?.cost?.total;
            if (typeof costTotal === 'number' && Number.isFinite(costTotal)) {
              out.reportedCostUsd += costTotal;
            }
          } else if (ev.message?.role === 'user' && !out.firstUserText) {
            const c = ev.message.content?.[0];
            if (c?.type === 'text' && typeof c.text === 'string') {
              out.firstUserText = c.text.slice(0, 80);
            }
          }
          break;
        default:
          // 未知事件容错跳过（switch default no-op）
          break;
      }
    }
    if (lastModel) {
      out.provider = lastModel.provider;
      out.modelId = lastModel.modelId;
    }
  } catch {
    /* ignore */
  }
  return out;
}