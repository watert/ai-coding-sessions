/**
 * jsonl 文件读取缓存: 按 mtime+size 校验失效, LRU 上限防内存膨胀
 * 用于 kimi wire.jsonl / grok updates.jsonl 等 session-list 高频重复读取场景
 * 优先用异步版 readJsonlCachedAsync, 同步版仅留给无法 async 的调用方 (缓存命中时无 IO)
 */
import fs from 'fs';

const MAX_ENTRIES = 150;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024; // 按原始文本大小估算上限

interface CacheEntry { mtimeMs: number; size: number; rows: any[] }
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

/** 解析 jsonl 文本并写入缓存 (含 LRU 淘汰) */
function parseAndStore(filePath: string, raw: string, st: fs.Stats): any[] {
  const rows: any[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 忽略坏行 */ }
  }

  const old = cache.get(filePath);
  if (old) totalBytes -= old.size;
  cache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, rows });
  totalBytes += st.size;

  // LRU 淘汰最老条目直到低于上限
  while (cache.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const evicted = cache.get(oldest.value);
    if (evicted) totalBytes -= evicted.size;
    cache.delete(oldest.value);
  }
  return rows;
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
