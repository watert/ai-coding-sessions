/**
 * 内容指纹：convert 后与缓存比对，避免无意义写库
 */

import { createHash } from 'node:crypto';
import type { UnifiedSessionInfo } from '../sources/types';
import type { UsageByModelEntry } from './schema';

/** 从 UnifiedSessionInfo 提取 usage_by_model（不依赖 pricing 固化） */
export function extractUsageByModel(session: UnifiedSessionInfo): UsageByModelEntry[] {
  const fromPricing = session.pricing?.details;
  if (fromPricing?.length) {
    return fromPricing.map((d) => {
      const parts = (d.modelKey || '').split('/');
      const provider = parts.length > 1 ? parts[0] : 'unknown';
      const model = parts.length > 1 ? parts.slice(1).join('/') : d.modelKey || 'unknown';
      return {
        provider,
        model,
        modelKey: d.modelKey,
        input: d.input || 0,
        output: d.output || 0,
        cache_read: d.cacheRead || 0,
        cache_write: d.cacheWrite || 0,
        tokens: (d.input || 0) + (d.output || 0) + (d.cacheRead || 0) + (d.cacheWrite || 0),
      };
    });
  }

  // 从 usage_by_day.byModel 聚合
  const map = new Map<string, UsageByModelEntry>();
  for (const day of session.usage_by_day || []) {
    for (const m of day.byModel || []) {
      const key = m.modelKey || 'unknown';
      const parts = key.split('/');
      const provider = parts.length > 1 ? parts[0] : 'unknown';
      const model = parts.length > 1 ? parts.slice(1).join('/') : key;
      const cur = map.get(key) || {
        provider,
        model,
        modelKey: key,
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        tokens: 0,
      };
      cur.input += m.input || 0;
      cur.output += m.output || 0;
      cur.cache_read += m.cacheRead || 0;
      cur.cache_write += m.cacheWrite || 0;
      cur.tokens = (cur.tokens || 0) + (m.tokens || 0);
      map.set(key, cur);
    }
  }
  return Array.from(map.values());
}

/** 列表 payload：剔除 pricing（缓存链路不固化价） */
export function stripPricingForPayload(session: UnifiedSessionInfo): Record<string, unknown> {
  const { pricing: _p, ...rest } = session as UnifiedSessionInfo & { pricing?: unknown };
  const usage_by_model = extractUsageByModel(session);
  return {
    ...rest,
    usage_by_model,
  };
}

/**
 * 内容指纹：活动边界 + 用量 + 标题 + 状态
 * （非密码学用途，稳定短 hash）
 */
export function contentFingerprint(session: UnifiedSessionInfo): string {
  const usage = extractUsageByModel(session);
  const material = [
    session.id,
    session.source,
    session.title || '',
    session.time_updated || 0,
    session.time_created || 0,
    session.last_active_at_iso || session.last_active_at || '',
    session.first_active_at_iso || '',
    session.session_status || '',
    session.models_used || '',
    session.total_tokens || 0,
    session.total_input || 0,
    session.total_output || 0,
    session.total_messages || 0,
    session.total_user_messages || 0,
    session.total_tool_calls || 0,
    session.usage_is_incomplete ? 1 : 0,
    session.parent_id || '',
    JSON.stringify(usage),
    // prompts 长度指纹（全文太大，取条数+总长+首尾 hash）
    promptSketch(session),
  ].join('|');
  return createHash('sha1').update(material).digest('hex').slice(0, 16);
}

function promptSketch(session: UnifiedSessionInfo): string {
  const parts = session.userParts || [];
  let totalLen = 0;
  let first = '';
  let last = '';
  for (let i = 0; i < parts.length; i++) {
    const t = String((parts[i] as any)?.text || '');
    totalLen += t.length;
    if (i === 0) first = t.slice(0, 64);
    if (i === parts.length - 1) last = t.slice(-64);
  }
  return `${parts.length}:${totalLen}:${first}:${last}`;
}

/** 从 userParts 提取完整 prompts */
export function extractPrompts(
  session: UnifiedSessionInfo,
): Array<{ idx: number; created_at: number | null; text: string }> {
  const parts = session.userParts || [];
  const out: Array<{ idx: number; created_at: number | null; text: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as any;
    const text = String(p?.text ?? '');
    if (!text) continue;
    const created =
      typeof p.startTime === 'number' && Number.isFinite(p.startTime)
        ? p.startTime
        : typeof p.endTime === 'number' && Number.isFinite(p.endTime)
          ? p.endTime
          : null;
    out.push({ idx: out.length, created_at: created, text });
  }
  return out;
}
