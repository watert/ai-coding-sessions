/**
 * jsonl 文件读取缓存: 按 mtime+size 校验失效, LRU 上限防内存膨胀
 * 用于 kimi wire.jsonl / grok updates.jsonl 等 session-list 高频重复读取场景
 * 优先用异步版 readJsonlCachedAsync, 同步版仅留给无法 async 的调用方 (缓存命中时无 IO)
 */
import fs from 'fs';

const MAX_ENTRIES = 400;
/**
 * 上限按「估算对象大小」记账：JSON.parse 后的 JS 对象通常是原始文本的 2~4 倍，
 * 旧实现拿文本字节当内存记账，LRU 以为还很空、进程实际已吃掉上 GB（grok 单次 1.9GB 尖峰）。
 */
const OBJECT_SIZE_FACTOR = 4;
const MAX_ESTIMATED_BYTES = 768 * 1024 * 1024;

interface CacheEntry { mtimeMs: number; size: number; /** 估算对象大小 = size × OBJECT_SIZE_FACTOR */ bytes: number; rows: any[] }
const cache = new Map<string, CacheEntry>();
let totalBytes = 0;

/** 缓存命中检查; 命中时移到 LRU 末尾并返回 rows */
function hitCache(filePath: string, st: fs.Stats): any[] | null {
  const hit = cache.get(filePath);
  if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) return null;
  cache.delete(filePath);
  cache.set(filePath, hit);
  return hit.rows;
}

/** 按行切分（兼容 CRLF / 裸 CR，避免 Windows 落盘残留 \\r） */
export function splitLines(raw: string): string[] {
  return raw.split(/\r\n|\n|\r/);
}

/** 解析 jsonl 文本并写入缓存 (含 LRU 淘汰; totalBytes 记的是估算对象大小) */
function parseAndStore(filePath: string, raw: string, st: fs.Stats): any[] {
  const rows: any[] = [];
  for (const line of splitLines(raw)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 忽略坏行 */ }
  }

  const bytes = Math.round(st.size * OBJECT_SIZE_FACTOR);
  const old = cache.get(filePath);
  if (old) totalBytes -= old.bytes;
  cache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, bytes, rows });
  totalBytes += bytes;

  // LRU 淘汰最老条目直到低于上限
  while (cache.size > MAX_ENTRIES || totalBytes > MAX_ESTIMATED_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const evicted = cache.get(oldest.value);
    if (evicted) totalBytes -= evicted.bytes;
    cache.delete(oldest.value);
  }
  return rows;
}

/** 诊断/测试用：当前 LRU 状态（条目数 + 估算对象字节） */
export function getJsonlCacheStats(): { entries: number; estimatedBytes: number } {
  return { entries: cache.size, estimatedBytes: totalBytes };
}

/** 测试用：清空缓存 */
export function clearJsonlCache(): void {
  cache.clear();
  totalBytes = 0;
}

/** 异步读取 jsonl 并解析为行对象数组; 文件不存在返回 null; 坏行跳过 */
export async function readJsonlCachedAsync(filePath: string): Promise<any[] | null> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(filePath);
  } catch {
    return null;
  }
  const hit = hitCache(filePath, st);
  if (hit) return hit;
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  return parseAndStore(filePath, raw, st);
}

/** 同步版: 仅供无法 async 的调用方使用; 缓存未命中时会阻塞事件循环 */
export function readJsonlCached(filePath: string): any[] | null {
  if (!fs.existsSync(filePath)) return null;
  const st = fs.statSync(filePath);
  const hit = hitCache(filePath, st);
  if (hit) return hit;
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseAndStore(filePath, raw, st);
}
