/**
 * 列表/查询用的日期与毫秒时间戳判断
 */

import dayjs from 'dayjs';

/** 查询参数是否为纯数字毫秒时间戳 */
export function isTimestamp(v?: string): boolean {
  if (!v) return false;
  return /^\d+$/.test(v);
}

export interface TimestampRangeFilter {
  startDate?: string;
  endDate?: string;
}

function parseBoundary(v?: string, isEnd = false) {
  if (!v) return null;
  if (isTimestamp(v)) return dayjs(Number(v));
  // 日期字符串: start 取 00:00:00.000, end 取 23:59:59.999, 保证包含整天
  return isEnd ? dayjs(v).endOf('day') : dayjs(v).startOf('day');
}

/** session 的 time_updated 等毫秒时间戳是否在范围内 */
export function filterTimestampInRange(
  timestampMs: number,
  { startDate, endDate }: TimestampRangeFilter,
): boolean {
  if (!startDate && !endDate) return true;

  const date = dayjs(timestampMs);
  const start = parseBoundary(startDate, false);
  const end = parseBoundary(endDate, true);

  if (start && date.isBefore(start)) return false;
  if (end && date.isAfter(end)) return false;
  return true;
}

/**
 * Session 活动区间 [firstMs, lastMs] 是否与查询范围重叠。
 * 条件: last >= start && first <= end
 */
export function filterActivityOverlap(
  firstMs: number,
  lastMs: number,
  { startDate, endDate }: TimestampRangeFilter,
): boolean {
  if (!startDate && !endDate) return true;
  const first = dayjs(Number.isFinite(firstMs) ? firstMs : lastMs);
  const last = dayjs(Number.isFinite(lastMs) ? lastMs : firstMs);
  const start = parseBoundary(startDate, false);
  const end = parseBoundary(endDate, true);
  if (start && last.isBefore(start)) return false;
  if (end && first.isAfter(end)) return false;
  return true;
}

/**
 * 列表过滤用活动边界：优先 message 级 first/last_active，
 * 避免 session 行 time_updated 被 title 同步等刷新后误入窗口。
 */
export function getSessionActivityBounds(s: {
  first_active_at_iso?: string;
  last_active_at_iso?: string;
  time_created?: number;
  time_updated?: number;
}): { firstMs: number; lastMs: number } {
  const lastMs = s.last_active_at_iso
    ? new Date(s.last_active_at_iso).getTime()
    : (s.time_updated || 0);
  const firstMs = s.first_active_at_iso
    ? new Date(s.first_active_at_iso).getTime()
    : (s.time_created || lastMs);
  return { firstMs, lastMs };
}