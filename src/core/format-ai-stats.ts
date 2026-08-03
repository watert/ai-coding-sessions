/**
 * Token / 成本展示格式化（web 列表、server markdown 等共用）
 */

import { USD_TO_CNY_RATE } from './model-pricing';

/** 紧凑数字：1.2M / 1.1K / 739.6 */
export function formatCompact(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toFixed(1);
}

/**
 * USD 金额格式化为人民币展示
 * @param usdAmount 美元成本
 * @param usdToCny 汇率，默认 USD_TO_CNY_RATE
 */
export function formatUsdAsCny(usdAmount: number, usdToCny: number = USD_TO_CNY_RATE): string {
  const val = usdAmount * usdToCny;
  if (val < 0.01) return `¥${val.toFixed(4)}`;
  return `¥${val.toFixed(2)}`;
}

/** 报表/图表用：固定 3 位小数 */
export function formatUsdAsCnyPrecise(usdAmount: number, usdToCny: number = USD_TO_CNY_RATE): string {
  return `¥${(usdAmount * usdToCny).toFixed(3)}`;
}