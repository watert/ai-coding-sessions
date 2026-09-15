/**
 * DeepSeek Harness (DSH) 本地数据访问
 *
 * 落盘: ~/.dsh/sessions/<cwd-slug>/session-<id>/session.vN.jsonl(.zstd)
 * - 首行 header `{type:session, version, id, createdAt, cwd, parentSession?, origin?}`
 * - 之后每行一条逻辑事件 `{type, seq, time, data}`
 * - 默认 zstd 多帧拼接 (每批一次 append 一帧); 也接受未压缩 .jsonl
 * - 子会话: header.origin=subagent + parentSession
 *
 * 不解 DSH 包: 只读物理 JSONL. 未知 type 容错跳过.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { splitLines } from '../lib/jsonl-cache';
import { resolveHomeDir } from '../lib/home-paths';

// ==================== 路径 ====================

/** DSH 用户根: DSH_HOME → ~/.dsh */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveHomeDir(env);
  if (env.DSH_HOME?.trim()) return path.resolve(env.DSH_HOME.trim());
  return path.join(home, '.dsh');
}

/**
 * sessions 根:
 * - DSH_SESSIONS_DIR 直接当 sessions 根
 * - 否则 DSH_HOME/sessions (basename 已是 sessions 则原样用)
 */
export function resolveDshSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_SESSIONS_DIR?.trim()) return path.resolve(env.DSH_SESSIONS_DIR.trim());
  const home = resolveDshHome(env);
  if (path.basename(home) === 'sessions') return home;
  return path.join(home, 'sessions');
}

export function getDshSessionsRoot(): string {
  return resolveDshSessionsRoot();
}

export function getDshHome(): string {
  return resolveDshHome();
}

// ==================== 类型 ====================

export type DshHeader = {
  type: 'session';
  version: number;
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  isSeeded?: boolean;
  origin?: 'subagent';
  delegationDepth?: number;
  agentPreset?: string;
};

export type DshEvent = {
  type: string;
  seq?: number;
  time?: number;
  data?: any;
  ignorable?: true;
  surfaceOp?: unknown;
  sourceEventSeqs?: unknown;
};

export type DshSessionItem = {
  sessionId: string;
  sessionDir: string;
  logPath: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  parentId?: string;
  origin?: 'subagent';
  formatVersion: number;
  dirtyMark: string;
  mtimeMs: number;
  size: number;
};

const GEN_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/i;

export function parseDshLogFilename(name: string): { version: number; compressed: boolean } | null {
  const m = name.match(GEN_RE);
  if (!m) return null;
  return { version: m[1] ? Number(m[1]) : 0, compressed: Boolean(m[2]) };
}

function fileStat(p: string): { mtimeMs: number; size: number } {
  try {
    const st = fs.statSync(p);
    return { mtimeMs: Math.floor(st.mtimeMs), size: st.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

function dirtyMark(p: string): string {
  const { mtimeMs, size } = fileStat(p);
  return `${mtimeMs}:${size}`;
}

/** 目录内取最高 generation 日志 (v3 > v2 > v1 > v0) */
export function pickDshLogFile(sessionDir: string): { logPath: string; version: number } | null {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { name: string; version: number } | null = null;
  for (const e of ents) {
    if (!e.isFile()) continue;
    const g = parseDshLogFilename(e.name);
    if (!g) continue;
    if (!best || g.version > best.version) best = { name: e.name, version: g.version };
  }
  if (!best) return null;
  return { logPath: path.join(sessionDir, best.name), version: best.version };
}

type LogHit = { sessionDir: string; logPath: string; version: number };

function walkSessionLogs(root: string): LogHit[] {
  if (!fs.existsSync(root)) return [];
  const hits: LogHit[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let best: { name: string; version: number } | null = null;
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) {
        const g = parseDshLogFilename(e.name);
        if (!g) continue;
        if (!best || g.version > best.version) best = { name: e.name, version: g.version };
      }
    }
    if (best) hits.push({ sessionDir: dir, logPath: path.join(dir, best.name), version: best.version });
  };
  walk(root, 0);
  return hits;
}

// ==================== zstd ====================

/** Bun 能一次解开拼接帧; zlib 只解第一帧 (正好当 header); CLI 兜底 */
export function decompressDshZstd(buf: Buffer): string {
  const bunFn = (globalThis as any).Bun?.zstdDecompressSync as
    | ((d: Buffer | Uint8Array) => Uint8Array)
    | undefined;
  if (typeof bunFn === 'function') {
    try {
      return Buffer.from(bunFn(buf)).toString('utf8');
    } catch {
      /* fall through */
    }
  }
  const cli = spawnSync('zstd', ['-dc'], {
    input: buf,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!cli.error && cli.status === 0 && cli.stdout) {
    return Buffer.from(cli.stdout).toString('utf8');
  }
  // zlib 只解首帧, 总比空强 (短会话可能就一帧)
  try {
    return Buffer.from(zstdDecompressSync(buf)).toString('utf8');
  } catch (e) {
    const detail = (cli.stderr || (e as Error)?.message || 'zstd failed').toString().slice(0, 200);
    console.warn(`[dsh-code] zstd decompress failed: ${detail}`);
    return '';
  }
}

/** 仅解第一帧 (list header, zlib 正好) */
export function decompressDshZstdFirstFrame(buf: Buffer): string {
  try {
    return Buffer.from(zstdDecompressSync(buf)).toString('utf8');
  } catch {
    return decompressDshZstd(buf);
  }
}

export function readDshLogText(logPath: string): string {
  if (!logPath || !fs.existsSync(logPath)) return '';
  try {
    if (/\.zstd$/i.test(logPath) || /\.zst$/i.test(logPath)) {
      return decompressDshZstd(fs.readFileSync(logPath));
    }
    return fs.readFileSync(logPath, 'utf8');
  } catch (e) {
    console.warn(`[dsh-code] read failed ${logPath}:`, (e as Error)?.message);
    return '';
  }
}

function firstJsonLine(text: string): any | null {
  for (const line of splitLines(text)) {
    const t = line.trim();
    if (!t) continue;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
  return null;
}

export function readDshHeader(logPath: string): DshHeader | null {
  if (!logPath || !fs.existsSync(logPath)) return null;
  try {
    let text = '';
    if (/\.zstd$/i.test(logPath) || /\.zst$/i.test(logPath)) {
      text = decompressDshZstdFirstFrame(fs.readFileSync(logPath));
    } else {
      const fd = fs.openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        text = buf.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    }
    const obj = firstJsonLine(text);
    if (obj && obj.type === 'session' && typeof obj.id === 'string') return obj as DshHeader;
  } catch {
    /* ignore */
  }
  return null;
}

export function readDshEvents(logPath: string): { header: DshHeader | null; events: DshEvent[] } {
  const text = readDshLogText(logPath);
  const events: DshEvent[] = [];
  let header: DshHeader | null = null;
  for (const line of splitLines(text)) {
    const t = line.trim();
    if (!t) continue;
    let obj: any;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'session' && typeof obj.id === 'string' && header == null) {
      header = obj as DshHeader;
      continue;
    }
    if (typeof obj.type === 'string') events.push(obj as DshEvent);
  }
  return { header, events };
}

function sessionIdFromDir(sessionDir: string): string | undefined {
  const base = path.basename(sessionDir);
  if (/^session-[0-9a-f-]{20,}$/i.test(base)) return base;
  return undefined;
}

/** projcache 里的 title (list 预览, convert 仍以 session/title 事件为准) */
function readProjcacheTitle(sessionId: string): string | undefined {
  const p = path.join(getDshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const title = raw?.record?.rows?.title?.val;
    return typeof title === 'string' && title.trim() ? title.trim() : undefined;
  } catch {
    return undefined;
  }
}

function toItem(hit: LogHit): DshSessionItem | null {
  const header = readDshHeader(hit.logPath);
  const st = fileStat(hit.logPath);
  const sessionId = header?.id || sessionIdFromDir(hit.sessionDir);
  if (!sessionId) return null;
  const createdAt = header?.createdAt || st.mtimeMs;
  return {
    sessionId,
    sessionDir: hit.sessionDir,
    logPath: hit.logPath,
    cwd: header?.cwd || '',
    createdAt,
    updatedAt: st.mtimeMs || createdAt,
    title: readProjcacheTitle(sessionId),
    parentId: header?.parentSession || undefined,
    origin: header?.origin,
    formatVersion: header?.version ?? hit.version,
    dirtyMark: dirtyMark(hit.logPath),
    mtimeMs: st.mtimeMs,
    size: st.size,
  };
}

export async function listDshSessions(): Promise<DshSessionItem[]> {
  const hits = walkSessionLogs(getDshSessionsRoot());
  const out: DshSessionItem[] = [];
  for (const h of hits) {
    const it = toItem(h);
    if (it) out.push(it);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export async function listDshSessionRefs(): Promise<DshSessionItem[]> {
  return listDshSessions();
}

export async function getDshSession(sessionId: string): Promise<DshSessionItem | null> {
  const list = await listDshSessions();
  const exact = list.find((s) => s.sessionId === sessionId);
  if (exact) return exact;
  // 允许裸 uuid 命中 session-<uuid>
  return list.find((s) => s.sessionId === `session-${sessionId}` || s.sessionId.endsWith(sessionId)) || null;
}

export async function getDshSessionItemsByIds(ids: string[]): Promise<DshSessionItem[]> {
  if (ids.length === 0) return [];
  const want = new Set(ids);
  const list = await listDshSessions();
  return list.filter((s) => want.has(s.sessionId) || want.has(s.sessionId.replace(/^session-/, '')));
}
