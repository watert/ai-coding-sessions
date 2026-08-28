/**
 * AI Coding Stats 通用工具函数
 */

export { isTimestamp, filterTimestampInRange } from '../lib/date-utils';
export { sanitizeUserTextParts } from '../core';

/**
 * part.state 在 wire 上有两种形态：字符串（如 'done'）或对象（工具详情）。
 * 取对象形态；字符串 / 空值时返回 undefined，与 `strState?.input` 的运行时行为一致。
 */
export interface ToolPartState {
  status?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
}

export function asToolPartState(state: unknown): ToolPartState | undefined {
  if (!state || typeof state !== 'object') return undefined;
  return state as ToolPartState;
}

/** 单条消息的 context window 规模（input + cacheRead；优先 tokens.context） */
export function getTokensContextSize(tokens?: {
  context?: { total?: number; input?: number; cacheRead?: number };
  input?: number;
  cache?: { read?: number };
} | null): number {
  if (!tokens) return 0;
  if (tokens.context) {
    if (typeof tokens.context.total === 'number' && tokens.context.total > 0) {
      return tokens.context.total;
    }
    return (tokens.context.input || 0) + (tokens.context.cacheRead || 0);
  }
  return (tokens.input || 0) + (tokens.cache?.read || 0);
}

/** session 内 assistant 消息的最大 context（compact 后会回落，故取 max） */
export function maxContextFromUnifiedMessages(
  messages: Array<{ info?: { role?: string; tokens?: any } }>,
): number {
  let max = 0;
  for (const m of messages) {
    if (m.info?.role !== 'assistant') continue;
    const c = getTokensContextSize(m.info.tokens);
    if (c > max) max = c;
  }
  return max;
}

/** 从 unified messages 中找出最后一条有 token 消耗的消息，提取 lastTokenInfo */
export function buildLastTokenInfo(
  messages: Array<{ info?: { tokens?: { total?: number; input?: number; output?: number; reasoning?: number; cache?: { read?: number } } } }>,
): { input: number; cacheRead: number; output: number; reasoning: number; total: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = messages[i].info?.tokens;
    if (tokens?.total) {
      return {
        input: tokens.input || 0,
        cacheRead: tokens.cache?.read || 0,
        output: tokens.output || 0,
        reasoning: tokens.reasoning || 0,
        total: tokens.total || 0,
      };
    }
  }
  return undefined;
}

/** 限制异步任务并发数，避免一次性加载所有 session 导致内存尖峰 */
export async function withConcurrencyLimit<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let index = 0;
  const workers: Promise<void>[] = [];

  async function worker() {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await fn(items[current]);
      } catch (e) {
        console.warn(`[withConcurrencyLimit] item ${current} failed:`, e);
      }
    }
  }

  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results.filter((r): r is R => r !== undefined);
}