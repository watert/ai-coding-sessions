/** AI 模型单价表与 token 成本换算(USD 基准) */

/** 兜底汇率（宿主可注入动态汇率；静态展示估算用） */
export const USD_TO_CNY_RATE = 7.2;

export interface ModelPriceTier {
  currency: 'USD' | 'CNY'; maxContext: number;
  inputPrice: number; outputPrice: number;
  cacheReadPrice?: number; cacheWritePrice?: number;
  inputAudioPrice?: number; audioCachePrice?: number;
}

export interface ModelPricing {
  id: string; name: string; totalContext: string; maxOutput: string;
  inputPrice: number; outputPrice: number;
  cacheReadPrice?: number; cacheWritePrice?: number;
  inputAudioPrice?: number; audioCachePrice?: number;
  priceCurrency?: 'USD' | 'CNY';
  prices?: ModelPriceTier[];
}

export interface CostResult {
  totalCost: number; inputCost: number; outputCost: number;
  cacheReadCost: number; cacheWriteCost: number;
  tier: Partial<ModelPriceTier>;
}

/** 价格表首项 = 各端模型选择器与成本估算的默认模型 */
export const DEFAULT_AI_MODEL_PRICING_ID = 'kimi-k2.6';

export const AI_MODEL_PRICING_TABLE: ModelPricing[] = [
  {
    id: "k3", name: "Kimi K3", totalContext: "1M", maxOutput: "128K",
    priceCurrency: 'CNY', inputPrice: 20, outputPrice: 100, cacheReadPrice: 2,
  },
  {
    id: "kimi-k2.6", name: "Kimi K2.6", totalContext: "262K", maxOutput: "32K",
    priceCurrency: 'CNY', inputPrice: 6.5, outputPrice: 27.0, cacheReadPrice: 1.1,
  },
  {
    id: "kimi-for-coding-highspeed", name: "Kimi for Coding Highspeed", totalContext: "262K", maxOutput: "32K",
    priceCurrency: 'CNY', inputPrice: 6.5, outputPrice: 27.0, cacheReadPrice: 1.1,
    // priceCurrency: 'CNY', inputPrice: 19.5, outputPrice: 81.0, cacheReadPrice: 3.3, // 3x
  },
  {
    id: "kimi-for-coding", name: "Kimi for Coding", totalContext: "262K", maxOutput: "32K",
    priceCurrency: 'CNY', inputPrice: 6.5, outputPrice: 27.0, cacheReadPrice: 1.1,
    // priceCurrency: 'CNY', inputPrice: 19.5, outputPrice: 81.0, cacheReadPrice: 3.3, // 3x
  },
  {
    // 官方 docs.x.ai：prompt ≥200k 时整请求用高档（input/cache/output 均 ×2）
    id: "grok-4.5", name: "xAI Grok 4.5", totalContext: "500K", maxOutput: "64K",
    priceCurrency: 'USD', inputPrice: 2.0, outputPrice: 6.0, cacheReadPrice: 0.3,
    prices: [
      { currency: 'USD', maxContext: 199_999, inputPrice: 2.0, outputPrice: 6.0, cacheReadPrice: 0.3 },
      { currency: 'USD', maxContext: Infinity, inputPrice: 4.0, outputPrice: 12.0, cacheReadPrice: 0.6 },
    ],
  },
  {
    id: "grok-composer-2.5-fast", name: "xAI Grok Composer 2.5 Fast", totalContext: "256K", maxOutput: "128K",
    priceCurrency: 'USD', inputPrice: 0.5, outputPrice: 2.5, cacheReadPrice: 0.2,
    // priceCurrency: 'USD', inputPrice: 3, outputPrice: 15, cacheReadPrice: 0.5,
  },
  {
    id: "grok-composer-2.5", name: "xAI Grok Composer 2.5", totalContext: "256K", maxOutput: "128K",
    priceCurrency: 'USD', inputPrice: 0.5, outputPrice: 2.5, cacheReadPrice: 0.2,
  },
  {
    id: "minimax-m3", name: "MiniMax M3", totalContext: "512K", maxOutput: "128K",
    priceCurrency: 'CNY', inputPrice: 2.1, outputPrice: 8.4, cacheReadPrice: 0.42,
  },
  {
    id: "minimax-m2.7", name: "MiniMax M2.7", totalContext: "204.8K", maxOutput: "131.1K",
    inputPrice: 0.30, outputPrice: 1.20, cacheReadPrice: 0.06, cacheWritePrice: 0.375,
  },
  {
    id: "minimax-m2.5", name: "MiniMax M2.5", totalContext: "204.8K", maxOutput: "131.1K",
    inputPrice: 0.30, outputPrice: 1.20, cacheReadPrice: 0.03, cacheWritePrice: 0.375,
  },
  {
    id: "minimax-m2.1", name: "MiniMax M2.1", totalContext: "204.8K", maxOutput: "131.1K",
    inputPrice: 0.30, outputPrice: 1.20,
  },
  {
    id: "doubao-seed-2.0-code", name: "doubao-seed-2.0-code", totalContext: "256K", maxOutput: "4096",
    cacheReadPrice: 0.64, inputPrice: 3.2, outputPrice: 16, priceCurrency: 'CNY',
    prices: [
      { currency: 'CNY', maxContext: 32e3, cacheReadPrice: 0.05, inputPrice: 0.47, outputPrice: 2.37 },
      { currency: 'CNY', maxContext: 128e3, cacheReadPrice: 0.96, inputPrice: 4.8, outputPrice: 24.0 },
      { currency: 'CNY', maxContext: 256e3, cacheReadPrice: 1.92, inputPrice: 9.6, outputPrice: 48.0 },
    ],
  },
  {
    id: "glm-5.1", name: "GLM-5.1（官方）", totalContext: "200K", maxOutput: "65.5K",
    priceCurrency: 'CNY', inputPrice: 6.00, outputPrice: 24.00, cacheReadPrice: 1.3,
  },
  {
    id: "glm-5.2", name: "GLM-5.2（官方）", totalContext: "200K", maxOutput: "65.5K",
    priceCurrency: 'CNY', inputPrice: 8.00, outputPrice: 28.00, cacheReadPrice: 2,
  },
  {
    id: "claude-opus-4.6", name: "Claude Opus 4.6", totalContext: "1M", maxOutput: "128K",
    inputPrice: 5.0, outputPrice: 25.0, cacheReadPrice: 0.50, cacheWritePrice: 6.25,
  },
  {
    id: "deepseek-v3.2", name: "DeepSeek v3.2", totalContext: "163.8K", maxOutput: "163.8K",
    priceCurrency: 'CNY', inputPrice: 2, outputPrice: 3, cacheReadPrice: 0.2,
  },
  {
    id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", totalContext: "1M", maxOutput: "384K",
    priceCurrency: 'CNY', inputPrice: 1, outputPrice: 2, cacheReadPrice: 0.02,
  },
  {
    id: "deepseek-v4-pro", name: "DeepSeek V4 Pro（原价）", totalContext: "1M", maxOutput: "384K",
    priceCurrency: 'CNY', inputPrice: 3, outputPrice: 6, cacheReadPrice: 0.025,
  },
  {
    id: "deepseek-v4-pro-discount", name: "DeepSeek V4 Pro（2.5折）", totalContext: "1M", maxOutput: "384K",
    priceCurrency: 'CNY', inputPrice: 3, outputPrice: 6, cacheReadPrice: 0.025,
  },
  {
    // 与 deepseek-v4-flash 同档：cache:input:output = 0.02:1:2（CNY /M）
    id: "mimo-v2.5", name: "MiMo V2.5", totalContext: "1M", maxOutput: "65.5K",
    priceCurrency: 'CNY', inputPrice: 1, outputPrice: 2, cacheReadPrice: 0.02, cacheWritePrice: 0,
  },
  {
    id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", totalContext: "1M", maxOutput: "65.5K",
    priceCurrency: 'CNY', inputPrice: 7, outputPrice: 21, cacheReadPrice: 1.4, cacheWritePrice: 0,
  },
  {
    id: "mimo-v2-flash", name: "Mimo V2 Flash", totalContext: "262.1K", maxOutput: "65.5K",
    inputPrice: 0.1, outputPrice: 0.3, cacheReadPrice: 0.01,
  },
];

export function findPriceTier(pricing: ModelPricing, cumulativeContext: number): ModelPriceTier {
  if (!pricing.prices?.length) {
    return {
      currency: pricing.priceCurrency || 'USD', maxContext: Infinity,
      inputPrice: pricing.inputPrice, outputPrice: pricing.outputPrice,
      cacheReadPrice: pricing.cacheReadPrice, cacheWritePrice: pricing.cacheWritePrice,
    };
  }
  const sorted = [...pricing.prices].sort((a, b) => a.maxContext - b.maxContext);
  for (const tier of sorted) {
    if (cumulativeContext <= tier.maxContext) return tier;
  }
  return sorted[sorted.length - 1];
}

/** 将标价货币金额换算为 USD；usdToCnyRate 须与回算 CNY 时一致 */
function toUSD(amount: number, currency: 'USD' | 'CNY', usdToCnyRate: number): number {
  return currency === 'CNY' ? amount / usdToCnyRate : amount;
}

export function calculateCost(
  pricing: ModelPricing, inputTokens: number, outputTokens: number,
  cacheReadTokens: number = 0, cacheWriteTokens: number = 0, cumulativeContext?: number,
  usdToCnyRate: number = USD_TO_CNY_RATE,
): CostResult {
  if (!pricing) {
    return { totalCost: 0, inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, tier: {} };
  }
  const tier = cumulativeContext !== undefined
    ? findPriceTier(pricing, cumulativeContext)
    : {
        currency: pricing.priceCurrency || 'USD', maxContext: Infinity,
        inputPrice: pricing.inputPrice, outputPrice: pricing.outputPrice,
        cacheReadPrice: pricing.cacheReadPrice, cacheWritePrice: pricing.cacheWritePrice,
      };
  const inputCost = toUSD((inputTokens * tier.inputPrice) / 1_000_000, tier.currency, usdToCnyRate);
  const outputCost = toUSD((outputTokens * tier.outputPrice) / 1_000_000, tier.currency, usdToCnyRate);
  const cacheReadCost = tier.cacheReadPrice ? toUSD((cacheReadTokens * tier.cacheReadPrice) / 1_000_000, tier.currency, usdToCnyRate) : 0;
  const cacheWriteCost = tier.cacheWritePrice ? toUSD((cacheWriteTokens * tier.cacheWritePrice) / 1_000_000, tier.currency, usdToCnyRate) : 0;
  return {
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    inputCost, outputCost, cacheReadCost, cacheWriteCost,
    tier: { currency: tier.currency, maxContext: tier.maxContext, inputPrice: tier.inputPrice, outputPrice: tier.outputPrice, cacheReadPrice: tier.cacheReadPrice, cacheWritePrice: tier.cacheWritePrice },
  };
}

export function calculateCostForMessage(
  pricing: ModelPricing,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
  cumulativeContextBeforeMsg: number,
  usdToCnyRate: number = USD_TO_CNY_RATE,
): CostResult {
  const tier = findPriceTier(pricing, cumulativeContextBeforeMsg);
  const inputCost = toUSD((tokens.input * tier.inputPrice) / 1_000_000, tier.currency, usdToCnyRate);
  const outputCost = toUSD((tokens.output * tier.outputPrice) / 1_000_000, tier.currency, usdToCnyRate);
  const cacheReadCost = tier.cacheReadPrice ? toUSD((tokens.cacheRead * tier.cacheReadPrice) / 1_000_000, tier.currency, usdToCnyRate) : 0;
  const cacheWriteCost = tier.cacheWritePrice ? toUSD((tokens.cacheWrite * tier.cacheWritePrice) / 1_000_000, tier.currency, usdToCnyRate) : 0;
  return {
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    inputCost, outputCost, cacheReadCost, cacheWriteCost,
    tier: { currency: tier.currency, maxContext: tier.maxContext, inputPrice: tier.inputPrice, outputPrice: tier.outputPrice, cacheReadPrice: tier.cacheReadPrice, cacheWritePrice: tier.cacheWritePrice },
  };
}

/** 成本分档展示标签(供 token 统计聚合用) */
export function tierLabel(tier: Partial<ModelPriceTier>): string {
  const ctx = tier.maxContext === Infinity ? 'Base' : tier.maxContext ? `≤${tier.maxContext >= 1000 ? (tier.maxContext / 1000) + 'K' : tier.maxContext}` : '?';
  return `${ctx} ${tier.currency || 'USD'}`;
}
