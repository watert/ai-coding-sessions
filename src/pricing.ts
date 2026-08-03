/**
 * Session 计价钩子（M2）
 * 包内 convert 调用这些 API；真正 models.dev / 汇率实现由 server-hono configurePricing 注入。
 * M3 后 convert 将改为只产 usage_by_model，本钩子可收缩。
 */

export interface SessionPricing {
  usd: number;
  cny: number;
  details?: SessionPricingDetail[];
}

export interface SessionPricingDetail {
  modelKey: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
  cny: number;
  /** 各 token 类型对应成本(USD), 用于前端精确拆分 input/output/cache 花费 */
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
}

export interface MessagePricingInput {
  providerID?: string;
  modelID?: string;
  tokens: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  /**
   * 分档用 prompt/context 大小（如 xAI ≥200k 涨价）。
   * 缺省 = input + cacheRead。多 call 聚合时应传「平均单 call prompt」，
   * 勿把 turn 累加 token 当单次 prompt。
   */
  contextTokens?: number;
}

export type MessageCostResult = {
  totalCost: number;
  cny: number;
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
};

export interface PricingHooks {
  ensureModelsDevData?: () => Promise<unknown>;
  calculateSessionPricing?: (messages: MessagePricingInput[]) => SessionPricing;
  calculateSessionPricingFromUnifiedMessages?: (messages: any[]) => SessionPricing;
  calculateMessageCost?: (input: MessagePricingInput) => MessageCostResult;
  extractMessagePricingInput?: (msg: any) => MessagePricingInput | null;
  getUsdToCnyRate?: () => number;
}

const hooks: PricingHooks = {};

/** server-hono 启动时注入真实计价实现 */
export function configurePricing(partial: PricingHooks): void {
  Object.assign(hooks, partial);
}

export async function ensureModelsDevData(): Promise<unknown> {
  if (hooks.ensureModelsDevData) return hooks.ensureModelsDevData();
  return null;
}

export function calculateSessionPricing(messages: MessagePricingInput[]): SessionPricing {
  if (hooks.calculateSessionPricing) return hooks.calculateSessionPricing(messages);
  return { usd: 0, cny: 0, details: [] };
}

export function calculateSessionPricingFromUnifiedMessages(messages: any[]): SessionPricing {
  if (hooks.calculateSessionPricingFromUnifiedMessages) {
    return hooks.calculateSessionPricingFromUnifiedMessages(messages);
  }
  return { usd: 0, cny: 0, details: [] };
}

export function calculateMessageCost(input: MessagePricingInput): MessageCostResult {
  if (hooks.calculateMessageCost) return hooks.calculateMessageCost(input);
  return { totalCost: 0, cny: 0 };
}

/** 默认：只抽 token 结构（不依赖 server-hono）；有 hook 时优先 hook */
export function extractMessagePricingInput(msg: any): MessagePricingInput | null {
  if (hooks.extractMessagePricingInput) return hooks.extractMessagePricingInput(msg);
  const info = msg?.info || msg || {};
  const tokens = info.tokens || {};
  const providerID = info.model?.providerID || info.providerID;
  const modelID = info.model?.modelID || info.modelID;
  if (!modelID) return null;
  return {
    providerID,
    modelID,
    tokens: {
      input: tokens.input || 0,
      output: tokens.output || 0,
      cacheRead: tokens.cache?.read || tokens.cacheRead || 0,
      cacheWrite: tokens.cache?.write || tokens.cacheWrite || 0,
      total: tokens.total,
    },
    contextTokens: info.tokens?.context?.total,
  };
}

export function getUsdToCnyRate(): number {
  if (hooks.getUsdToCnyRate) return hooks.getUsdToCnyRate();
  // 与 core 静态兜底一致
  return 7.2;
}
