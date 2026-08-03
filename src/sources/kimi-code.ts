/**
 * Kimi Code CLI 本地数据访问服务
 * 读取 ~/.kimi-code 下的 session_index.jsonl 和 sessions/{workdir}/{session}/agents/main/wire.jsonl
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import _ from 'lodash';
import { z } from 'zod';
import { readJsonlCachedAsync } from '../lib/jsonl-cache';
import { classifySoftToolError } from './tool-error-soft';

/**
 * Kimi 数据根：KIMI_DATA_DIR（逗号分隔取首个，对齐 ccusage）→ 否则 ~/.kimi-code
 * （ccusage 还会扫 ~/.kimi；本包 session_index 布局以 .kimi-code 为准）
 */
export function resolveKimiBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.KIMI_DATA_DIR?.split(',')[0]?.trim();
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), '.kimi-code');
}

const KIMI_BASE = resolveKimiBase();
const SESSION_INDEX_PATH = path.join(KIMI_BASE, 'session_index.jsonl');

// ==================== Zod Schema ====================

const KimiSessionIndexItemSchema = z.object({
  sessionId: z.string(),
  sessionDir: z.string(),
  workDir: z.string(),
});

const KimiSessionStateSchema = z.object({
  createdAt: z.string(),
  updatedAt: z.string(),
  title: z.string().default('Untitled'),
  isCustomTitle: z.boolean().optional(),
  lastPrompt: z.string().optional(),
});

const KimiUsageSchema = z.object({
  inputOther: z.number().default(0),
  output: z.number().default(0),
  inputCacheRead: z.number().default(0),
  inputCacheCreation: z.number().default(0),
});

const KimiContentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  think: z.string().optional(),
});

const KimiMessageContentSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.array(KimiContentPartSchema).default([]),
  toolCalls: z.array(z.unknown()).default([]),
  origin: z.object({ kind: z.string() }).passthrough(),
});

const KimiTurnPromptSchema = z.object({
  type: z.literal('turn.prompt'),
  input: z.array(KimiContentPartSchema).default([]),
  origin: z.object({ kind: z.string() }).passthrough(),
  time: z.number(),
});

const KimiAppendMessageSchema = z.object({
  type: z.literal('context.append_message'),
  message: KimiMessageContentSchema,
  time: z.number(),
});

const KimiLoopEventSchema = z.object({
  type: z.literal('context.append_loop_event'),
  event: z.record(z.unknown()),
  time: z.number(),
});

const KimiUsageRecordSchema = z.object({
  type: z.literal('usage.record'),
  model: z.string().optional(),
  usage: KimiUsageSchema,
  usageScope: z.string().optional(),
  time: z.number(),
});

const KimiWireEventSchema = z.union([
  KimiTurnPromptSchema,
  KimiAppendMessageSchema,
  KimiLoopEventSchema,
  KimiUsageRecordSchema,
  z.object({ type: z.string() }).passthrough(),
]);

// ==================== 导出类型 ====================

export type KimiSessionItem = {
  sessionId: string;
  sessionDir: string;
  workDir: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

/** main wire 中 Agent / AgentSwarm 工具调用对应的子会话元数据 */
export type KimiSubagentMeta = {
  virtualSessionId: string;
  rootSessionId: string;
  parentSessionId: string;
  agentDir: string;
  toolCallId: string;
  subagentType: string;
  description?: string;
  promptPreview?: string;
  /** AgentSwarm result 中声明的 outcome（completed / failed / aborted / started） */
  outcome?: string;
  /** AgentSwarm result 中的错误详情 */
  errorInfo?: string;
};

export type KimiUsage = z.infer<typeof KimiUsageSchema>;

export type KimiMessageRole = 'user' | 'assistant';

export type KimiToolCallItem = {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  description?: string;
};

export type KimiMessageItem = {
  uuid: string;
  sessionId: string;
  role: KimiMessageRole;
  timestamp: number;
  text: string;
  thinking?: string;
  /** thinking effort: on / low / high / max 等 */
  thinkingEffort?: string;
  toolCalls: KimiToolCallItem[];
  /** 按原始出现顺序组织的 OpenCode 风格 parts（text / reasoning / tool） */
  parts?: any[];
  usage?: KimiUsage; // 该 step 的用量
  lastStepUsage?: KimiUsage; // 最终 step 的用量(用于 context window 计算)
  model?: string;
  latencyMs?: number;
  streamDurationMs?: number;
  finishReason?: string;
  cwd?: string;
  parentID?: string;
};

// ==================== Session 列表 ====================

export async function listKimiCodeSessions(): Promise<KimiSessionItem[]> {
  if (!fs.existsSync(SESSION_INDEX_PATH)) {
    return [];
  }

  const indexContent = await fs.promises.readFile(SESSION_INDEX_PATH, 'utf-8');
  const indexItems = indexContent
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      try {
        return KimiSessionIndexItemSchema.parse(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter(Boolean) as z.infer<typeof KimiSessionIndexItemSchema>[];

  const sessions: KimiSessionItem[] = [];
  for (const item of indexItems) {
    const statePath = path.join(item.sessionDir, 'state.json');
    try {
      const stateRaw = JSON.parse(await fs.promises.readFile(statePath, 'utf-8'));
      const state = KimiSessionStateSchema.parse(stateRaw);
      sessions.push({
        sessionId: item.sessionId,
        sessionDir: item.sessionDir,
        workDir: item.workDir,
        title: state.title || state.lastPrompt || 'Untitled',
        createdAt: new Date(state.createdAt).getTime(),
        updatedAt: new Date(state.updatedAt).getTime(),
      });
    } catch {
      sessions.push({
        sessionId: item.sessionId,
        sessionDir: item.sessionDir,
        workDir: item.workDir,
        title: 'Untitled',
        createdAt: 0,
        updatedAt: 0,
      });
    }
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ==================== Wire 事件解析 ====================

const KIMI_SUBAGENT_ID_SEP = '__';

/** 判断是否为模型别名占位 (如 subagent 的 __secondary__)，真实 model 在 llm.request.model */
const isModelAlias = (m?: string) => !!m && /^__.+__$/.test(m);

export function parseKimiVirtualSessionId(sessionId: string): { rootSessionId: string; agentDir?: string } {
  const idx = sessionId.indexOf(KIMI_SUBAGENT_ID_SEP);
  if (idx === -1) return { rootSessionId: sessionId };
  return { rootSessionId: sessionId.slice(0, idx), agentDir: sessionId.slice(idx + KIMI_SUBAGENT_ID_SEP.length) };
}

export function buildKimiSubagentSessionId(rootSessionId: string, agentDir: string): string {
  return `${rootSessionId}${KIMI_SUBAGENT_ID_SEP}${agentDir}`;
}

export function parseAgentIdFromToolResult(output: unknown): string | undefined {
  if (typeof output !== 'string') return undefined;
  const m = output.match(/agent_id:\s*(agent-\d+)/);
  return m?.[1];
}

export type SwarmOutcomeInfo = { outcome?: string; errorInfo?: string; item?: string; bodyPreview?: string };

/** 解析 AgentSwarm tool result 中的 <subagent> 列表，提取 outcome / item / 错误信息 */
export function parseAgentSwarmResult(output: string): Record<string, SwarmOutcomeInfo> {
  const result: Record<string, SwarmOutcomeInfo> = {};
  // 匹配 <subagent agent_id="agent-N" ... outcome="...">...</subagent>
  const regex = /<subagent\s+([^>]*?)>([\s\S]*?)<\/subagent>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    const attrs = match[1];
    const body = match[2].trim();
    const agentDir = attrs.match(/agent_id="([^"]+)"/)?.[1];
    if (!agentDir) continue;
    const outcome = attrs.match(/outcome="([^"]+)"/)?.[1];
    const item = attrs.match(/item="([^"]*)"/)?.[1];
    const isErr = outcome === 'failed' || outcome === 'aborted';
    result[agentDir] = {
      outcome,
      item,
      errorInfo: isErr && body ? body : undefined,
      bodyPreview: body ? body.slice(0, 160).replace(/\s+/g, ' ') : undefined,
    };
  }
  return result;
}

/** tool result 可能是 string 或 { output, isError } */
export function extractKimiToolOutputString(result: unknown): string | undefined {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const o = result as { output?: unknown; content?: unknown };
    if (typeof o.output === 'string') return o.output;
    if (typeof o.content === 'string') return o.content;
  }
  return undefined;
}

/** 详情页 Agent / AgentSwarm tool part 上挂的子 agent 元数据 */
export type KimiSubagentToolAgentMeta = {
  agentDir?: string;
  item?: string;
  outcome?: string;
  errorInfo?: string;
  virtualSessionId?: string;
  /** completed body 摘要 / 错误预览 */
  bodyPreview?: string;
};

export type KimiSubagentToolMetadata = {
  kind: 'agent' | 'agentswarm';
  agents: KimiSubagentToolAgentMeta[];
  /** 单 Agent 时的子 session id（兼容 state.metadata.sessionId） */
  sessionId?: string;
  summary?: {
    completed: number;
    failed: number;
    aborted: number;
    started: number;
    total: number;
  };
};

function summarizeKimiSubagentAgents(agents: KimiSubagentToolAgentMeta[]): NonNullable<KimiSubagentToolMetadata['summary']> {
  const summary = { completed: 0, failed: 0, aborted: 0, started: 0, total: agents.length };
  for (const a of agents) {
    const o = (a.outcome || '').toLowerCase();
    if (o === 'completed' || o === 'done' || o === 'success') summary.completed += 1;
    else if (o === 'failed' || o === 'error') summary.failed += 1;
    else if (o === 'aborted') summary.aborted += 1;
    else summary.started += 1;
  }
  return summary;
}

/**
 * 从 Agent / AgentSwarm tool 的 args + result 构建前端可用的 metadata。
 * rootSessionId 可为虚拟 id，会自动取 root。
 */
export function buildKimiSubagentToolMetadata(params: {
  rootSessionId: string;
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
}): KimiSubagentToolMetadata | undefined {
  const name = (params.toolName || '').toLowerCase().replace(/[_-]/g, '');
  if (name !== 'agent' && name !== 'agentswarm') return undefined;

  const rootId = parseKimiVirtualSessionId(params.rootSessionId).rootSessionId;
  const args = params.args || {};
  const outStr = extractKimiToolOutputString(params.result);

  if (name === 'agent') {
    const agentDir = parseAgentIdFromToolResult(outStr);
    const outcome = outStr?.match(/status:\s*(\w+)/)?.[1];
    const desc = String(args.description || '').trim() || undefined;
    const agents: KimiSubagentToolAgentMeta[] = agentDir
      ? [{
          agentDir,
          item: desc,
          outcome,
          virtualSessionId: buildKimiSubagentSessionId(rootId, agentDir),
          bodyPreview: outcome === 'failed' || outcome === 'aborted'
            ? outStr?.slice(0, 160)
            : undefined,
          errorInfo: outcome === 'failed' || outcome === 'aborted' ? outStr?.slice(0, 2000) : undefined,
        }]
      : [];
    const sessionId = agentDir ? buildKimiSubagentSessionId(rootId, agentDir) : undefined;
    return {
      kind: 'agent',
      agents,
      sessionId,
      summary: summarizeKimiSubagentAgents(agents.length ? agents : [{ outcome: outStr ? undefined : 'started' }]),
    };
  }

  // AgentSwarm
  const items = Array.isArray(args.items) ? args.items.map(String) : [];
  const outcomeMap = outStr ? parseAgentSwarmResult(outStr) : {};
  const agents: KimiSubagentToolAgentMeta[] = [];

  if (Object.keys(outcomeMap).length > 0) {
    const dirs = Object.keys(outcomeMap).sort(
      (a, b) => parseInt(a.replace('agent-', ''), 10) - parseInt(b.replace('agent-', ''), 10),
    );
    for (const agentDir of dirs) {
      const info = outcomeMap[agentDir];
      agents.push({
        agentDir,
        item: info.item,
        outcome: info.outcome,
        errorInfo: info.errorInfo,
        bodyPreview: info.bodyPreview,
        virtualSessionId: buildKimiSubagentSessionId(rootId, agentDir),
      });
    }
  } else if (items.length > 0) {
    // 运行中 / 启动前被拒：按 items 占位，尚无 agentDir 则无法跳转
    const rejected = !!outStr && !outStr.includes('<subagent');
    for (const item of items) {
      agents.push({
        item,
        outcome: rejected ? 'failed' : 'started',
        bodyPreview: rejected ? outStr?.slice(0, 160) : undefined,
        errorInfo: rejected ? outStr?.slice(0, 2000) : undefined,
      });
    }
  }

  return {
    kind: 'agentswarm',
    agents,
    summary: summarizeKimiSubagentAgents(agents),
  };
}

function listKimiAgentDirs(sessionDir: string): string[] {
  const agentsDir = path.join(sessionDir, 'agents');
  if (!fs.existsSync(agentsDir)) return [];
  try {
    return fs.readdirSync(agentsDir)
      .filter(d => d !== 'main' && /^agent-\d+$/.test(d))
      .sort((a, b) => parseInt(a.replace('agent-', ''), 10) - parseInt(b.replace('agent-', ''), 10));
  } catch {
    return [];
  }
}

/** state.json.agents：运行中即可拿到 agentDir ↔ swarmItem 映射 */
function readKimiStateAgents(sessionDir: string): Record<string, { swarmItem?: string; type?: string; parentAgentId?: string | null }> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    return (raw?.agents && typeof raw.agents === 'object') ? raw.agents : {};
  } catch {
    return {};
  }
}

/**
 * 为一次 AgentSwarm 调用解析关联的 agent 目录。
 * - 已完成：优先用 result 中的 agent_id
 * - 运行中：用 state.json.swarmItem 对齐 items，再回退到尚未认领的 agent-* 目录
 */
function resolveSwarmAgentBindings(params: {
  items: string[];
  outcomeMap: Record<string, SwarmOutcomeInfo>;
  agentDirs: string[];
  stateAgents: Record<string, { swarmItem?: string }>;
  seen: Set<string>;
}): Array<{ agentDir: string; item?: string; outcome?: string; errorInfo?: string }> {
  const { items, outcomeMap, agentDirs, stateAgents, seen } = params;
  const bindings: Array<{ agentDir: string; item?: string; outcome?: string; errorInfo?: string }> = [];
  const used = new Set<string>();

  const push = (agentDir: string, item?: string, info?: SwarmOutcomeInfo) => {
    if (!agentDir || seen.has(agentDir) || used.has(agentDir)) return;
    used.add(agentDir);
    bindings.push({
      agentDir,
      item: item ?? info?.item,
      outcome: info?.outcome,
      errorInfo: info?.errorInfo,
    });
  };

  // 1) result 已返回：按 agent_id 绑定
  for (const [agentDir, info] of Object.entries(outcomeMap)) {
    push(agentDir, info.item, info);
  }
  if (bindings.length > 0) return bindings;

  // 2) 运行中：按 swarmItem / items 顺序绑定已出现的 agent 目录
  const unclaimed = agentDirs.filter(d => !seen.has(d));
  for (const item of items) {
    const byState = unclaimed.find(d => !used.has(d) && stateAgents[d]?.swarmItem === item);
    if (byState) {
      push(byState, item, { outcome: 'started' });
      continue;
    }
    const next = unclaimed.find(d => !used.has(d));
    if (next) push(next, item, { outcome: 'started' });
  }

  // items 为空时，仍把本轮尚未认领且在 state 中标记为 sub 的目录挂上
  if (items.length === 0) {
    for (const agentDir of unclaimed) {
      if (used.has(agentDir)) continue;
      if (stateAgents[agentDir] && stateAgents[agentDir].swarmItem === undefined) continue;
      push(agentDir, stateAgents[agentDir]?.swarmItem, { outcome: 'started' });
    }
  }

  return bindings;
}

/** 扫描 main wire，提取 Agent / AgentSwarm 子会话元数据（含运行中） */
export async function listKimiSubagentsFromMainWire(sessionDir: string, rootSessionId: string): Promise<KimiSubagentMeta[]> {
  const events = await readWireEvents(sessionDir, 'main');
  const loopEvents = events.filter(e => e.type === 'context.append_loop_event') as any[];
  const callById = new Map<string, any>();
  const resultByParentId = new Map<string, any>();
  for (const row of loopEvents) {
    const evt = row.event;
    if (evt?.type === 'tool.call') {
      const id = evt.toolCallId || evt.uuid;
      if (id) callById.set(id, evt);
    } else if (evt?.type === 'tool.result') {
      const parentId = evt.parentUuid || evt.toolCallId;
      if (parentId) resultByParentId.set(parentId, evt.result);
    }
  }

  const metas: KimiSubagentMeta[] = [];
  const seen = new Set<string>();
  const agentDirs = listKimiAgentDirs(sessionDir);
  const stateAgents = readKimiStateAgents(sessionDir);

  // 1. Agent tool 创建的子会话（已完成：靠 tool.result 中的 agent_id）
  for (const row of loopEvents) {
    const evt = row.event;
    if (evt?.type !== 'tool.result') continue;
    const parentUuid = evt.parentUuid || evt.toolCallId;
    const callEvt = parentUuid ? callById.get(parentUuid) : undefined;
    if (!callEvt || callEvt.name !== 'Agent') continue;
    const agentDir = parseAgentIdFromToolResult(evt.result?.output);
    if (!agentDir || seen.has(agentDir)) continue;
    seen.add(agentDir);
    const args = callEvt.args || {};
    const display = callEvt.display || {};
    const prompt = String(args.prompt || display.prompt || '');
    const out = typeof evt.result?.output === 'string' ? evt.result.output : '';
    const statusMatch = out.match(/status:\s*(\w+)/);
    const outcome = statusMatch?.[1];
    const isErr = outcome === 'failed' || outcome === 'aborted';
    metas.push({
      virtualSessionId: buildKimiSubagentSessionId(rootSessionId, agentDir),
      rootSessionId,
      parentSessionId: rootSessionId,
      agentDir,
      toolCallId: callEvt.toolCallId || callEvt.uuid,
      subagentType: String(args.subagent_type || display.agent_name || 'subagent'),
      description: (args.description || callEvt.description || display.description) as string | undefined,
      promptPreview: prompt.slice(0, 200),
      outcome,
      errorInfo: isErr ? out.slice(0, 2000) : undefined,
    });
  }

  // 1b. Agent tool 仍在运行：result 未到，但 agents/ 或 state.json 已有目录
  const pendingAgentCalls = Array.from(callById.values()).filter(c => {
    if (c?.name !== 'Agent') return false;
    const id = c.toolCallId || c.uuid;
    return id && !resultByParentId.has(id);
  });
  if (pendingAgentCalls.length > 0) {
    const unclaimed = agentDirs.filter(d => !seen.has(d));
    for (let i = 0; i < pendingAgentCalls.length; i++) {
      const callEvt = pendingAgentCalls[i];
      const agentDir = unclaimed[i];
      if (!agentDir) break;
      seen.add(agentDir);
      const args = callEvt.args || {};
      const display = callEvt.display || {};
      const prompt = String(args.prompt || display.prompt || '');
      metas.push({
        virtualSessionId: buildKimiSubagentSessionId(rootSessionId, agentDir),
        rootSessionId,
        parentSessionId: rootSessionId,
        agentDir,
        toolCallId: callEvt.toolCallId || callEvt.uuid,
        subagentType: String(args.subagent_type || display.agent_name || 'subagent'),
        description: (args.description || callEvt.description || display.description) as string | undefined,
        promptPreview: prompt.slice(0, 200),
        outcome: 'started',
      });
    }
  }

  // 2. AgentSwarm：完成态用 result；运行中用 items + 磁盘/state 即时暴露
  for (const callEvt of Array.from(callById.values())) {
    if (callEvt?.name !== 'AgentSwarm') continue;
    const args = callEvt.args || {};
    const display = callEvt.display || {};
    const items = Array.isArray(args.items) ? args.items.map(String) : [];
    const baseDesc = String(args.description || display.description || callEvt.description || 'AgentSwarm');
    const subagentType = String(args.subagent_type || display.agent_name || 'swarm');
    const promptTemplate = String(args.prompt_template || '');
    const toolCallId = callEvt.toolCallId || callEvt.uuid;
    const swarmResult = toolCallId ? resultByParentId.get(toolCallId) : undefined;
    const outcomeMap = typeof swarmResult?.output === 'string'
      ? parseAgentSwarmResult(swarmResult.output)
      : ({} as Record<string, SwarmOutcomeInfo>);

    // 无 result 且磁盘上也还没有任何未认领 agent → 可能被框架拒绝，跳过
    const hasOutcome = Object.keys(outcomeMap).length > 0;
    const hasLiveAgents = agentDirs.some(d => !seen.has(d));
    if (!hasOutcome && !hasLiveAgents && items.length === 0) continue;

    const bindings = resolveSwarmAgentBindings({
      items,
      outcomeMap,
      agentDirs,
      stateAgents,
      seen,
    });
    // 运行中但目录尚未创建：仍不生成空壳，等 agent 目录落地后再展示
    if (bindings.length === 0) continue;

    for (const binding of bindings) {
      if (seen.has(binding.agentDir)) continue;
      seen.add(binding.agentDir);
      const item = binding.item;
      const promptPreview = item
        ? promptTemplate.replace(/\{\{item\}\}/g, item).slice(0, 200)
        : promptTemplate.slice(0, 200);
      metas.push({
        virtualSessionId: buildKimiSubagentSessionId(rootSessionId, binding.agentDir),
        rootSessionId,
        parentSessionId: rootSessionId,
        agentDir: binding.agentDir,
        toolCallId: toolCallId || '',
        subagentType,
        description: item ? `${baseDesc} - ${item}` : baseDesc,
        promptPreview,
        outcome: binding.outcome || (hasOutcome ? undefined : 'started'),
        errorInfo: binding.errorInfo,
      });
    }
  }

  // 3. 兜底：磁盘上已有、但 wire 未关联到的 agent（异常路径 / 元数据缺失）
  for (const agentDir of agentDirs) {
    if (seen.has(agentDir)) continue;
    seen.add(agentDir);
    const swarmItem = stateAgents[agentDir]?.swarmItem;
    metas.push({
      virtualSessionId: buildKimiSubagentSessionId(rootSessionId, agentDir),
      rootSessionId,
      parentSessionId: rootSessionId,
      agentDir,
      toolCallId: '',
      subagentType: 'subagent',
      description: swarmItem ? `swarm: ${swarmItem}` : agentDir,
      outcome: 'started',
    });
  }

  return metas;
}

async function readWireEvents(sessionDir: string, agentKey = 'main'): Promise<z.infer<typeof KimiWireEventSchema>[]> {
  const wirePath = path.join(sessionDir, 'agents', agentKey, 'wire.jsonl');
  // mtime 校验缓存: 同一 session 的 main wire 在 list 流程中会被读多次 (subagent 枚举 + 消息重建)
  // 异步读取, 多 session 并发时 IO 与 parse 可交错
  return (await readJsonlCachedAsync(wirePath)) ?? [];
}

function extractTextFromContent(content: unknown[]): string {
  if (!Array.isArray(content)) return '';
  return content
    .map(c => (typeof c === 'object' ? (c as any).text || (c as any).think || '' : String(c)))
    .filter(Boolean)
    .join('\n');
}

function extractThinkingFromContent(content: unknown[]): string {
  if (!Array.isArray(content)) return '';
  return content
    .map(c => (typeof c === 'object' ? (c as any).think || '' : ''))
    .filter(Boolean)
    .join('\n');
}

// ==================== 消息重建 ====================

export async function listKimiCodeMessages(params: {
  sessionId: string;
  sessionDir?: string;
  agentKey?: string;
}): Promise<KimiMessageItem[]> {
  const { sessionId, sessionDir, agentKey: agentKeyParam } = params;
  const parsed = parseKimiVirtualSessionId(sessionId);
  const agentKey = agentKeyParam || parsed.agentDir || 'main';
  const rootSessionId = parsed.rootSessionId;
  const dir = sessionDir || await findSessionDir(rootSessionId);
  if (!dir) {
    throw new Error(`Kimi session not found: ${sessionId}`);
  }
  const messageSessionId = parsed.agentDir ? sessionId : rootSessionId;

  const events = await readWireEvents(dir, agentKey);
  const messages: KimiMessageItem[] = [];

  const isSubagentWire = agentKey !== 'main';

  // 从 context.append_message / turn.prompt 中提取用户消息
  for (const event of events) {
    if (event.type === 'context.append_message') {
      const msg = (event as any).message;
      const okUser = msg?.role === 'user' && (
        msg?.origin?.kind === 'user' || (isSubagentWire && msg?.origin?.kind === 'system_trigger')
      );
      if (okUser) {
        messages.push({
          uuid: crypto.randomUUID(),
          sessionId: messageSessionId,
          role: 'user',
          timestamp: (event as any).time || Date.now(),
          text: extractTextFromContent(msg.content),
          thinking: undefined,
          toolCalls: [],
          cwd: undefined,
        });
      }
    }
  }

  // 如果没有用户消息，尝试 turn.prompt
  if (messages.length === 0) {
    for (const event of events) {
      if (event.type === 'turn.prompt') {
        const e = event as any;
        const okPrompt = e.origin?.kind === 'user' || !e.origin?.kind
          || (isSubagentWire && (e.origin?.kind === 'system_trigger' || e.origin?.name === 'subagent'));
        if (okPrompt) {
          messages.push({
            uuid: crypto.randomUUID(),
            sessionId: messageSessionId,
            role: 'user',
            timestamp: e.time || Date.now(),
            text: extractTextFromContent(e.input),
            thinking: undefined,
            toolCalls: [],
          });
        }
      }
    }
  }

  // 按时间排序用户消息
  messages.sort((a, b) => a.timestamp - b.timestamp);

  // 保存 user 消息 uuid，避免后续插入 assistant 消息后索引错位
  const userMessageUuids = messages.map(m => m.uuid);

  // 按 turnId 聚合 assistant loop events
  const loopEvents = events.filter(e => e.type === 'context.append_loop_event') as any[];
  const usageRecords = events.filter(e => e.type === 'usage.record') as any[];

  // thinkingEffort: llm.request.turnStep → effort；config.update 作 fallback
  // model: usage.record 的 model 可能是别名 (如 subagent 的 __secondary__)，真实 model 在 llm.request
  const effortByTurnStep = new Map<string, string>();
  const llmRequestEfforts: Array<{ time: number; effort: string }> = [];
  const modelByTurnStep = new Map<string, string>();
  const llmRequestModels: Array<{ time: number; model: string }> = [];
  let lastConfigEffort: string | undefined;
  for (const e of events as any[]) {
    if (e.type === 'config.update' && e.thinkingEffort) {
      lastConfigEffort = String(e.thinkingEffort);
    } else if (e.type === 'llm.request') {
      if (e.thinkingEffort) {
        const effort = String(e.thinkingEffort);
        if (e.turnStep) effortByTurnStep.set(String(e.turnStep), effort);
        if (typeof e.time === 'number') llmRequestEfforts.push({ time: e.time, effort });
      }
      if (e.model && !isModelAlias(String(e.model))) {
        const m = String(e.model);
        if (e.turnStep) modelByTurnStep.set(String(e.turnStep), m);
        if (typeof e.time === 'number') llmRequestModels.push({ time: e.time, model: m });
      }
    }
  }
  llmRequestEfforts.sort((a, b) => a.time - b.time);
  llmRequestModels.sort((a, b) => a.time - b.time);

  // 识别 Kimi Code 的 context compaction 区间，避免其产生的 usage.record 被误配给普通 step
  const compactRanges = getKimiCompactRanges(events);
  const compactUsageRecords: typeof usageRecords = [];
  const normalUsageRecords: typeof usageRecords = [];
  for (const u of usageRecords) {
    const inCompact = compactRanges.some(r => u.time >= r.beginTime && u.time <= r.completeTime);
    if (inCompact) {
      compactUsageRecords.push(u);
    } else {
      normalUsageRecords.push(u);
    }
  }

  // 每个 step 通过 stepUuid 聚合，保留外层 event time
  // tool.result 通常只有 parentUuid/toolCallId，无 stepUuid，需回挂到对应 tool.call 的 step
  const stepsByUuid = new Map<string, any[]>();
  const toolCallStepMap = new Map<string, string>(); // toolCallId -> stepUuid
  for (const e of loopEvents) {
    const evt = { ...e.event, _outerTime: e.time };
    if (evt.type === 'tool.call') {
      const callId = evt.toolCallId || evt.uuid;
      const callStep = evt.stepUuid;
      if (callId && callStep) toolCallStepMap.set(callId, callStep);
    }
  }
  for (const e of loopEvents) {
    const evt = { ...e.event, _outerTime: e.time };
    let stepUuid = evt.stepUuid || evt.uuid;
    if (!stepUuid && evt.type === 'tool.result') {
      stepUuid = toolCallStepMap.get(evt.toolCallId || evt.parentUuid);
    }
    if (!stepUuid) continue;
    if (!stepsByUuid.has(stepUuid)) {
      stepsByUuid.set(stepUuid, []);
    }
    stepsByUuid.get(stepUuid)!.push(evt);
  }

  // 构建 step 元数据列表，便于按时间排序并与 usage.record 匹配
  type StepBuilder = {
    uuid: string;
    turnId: string;
    events: any[];
    beginTime: number;
    endTime?: number;
    stepUsage: KimiUsage;
    model?: string;
    thinkingEffort?: string;
  };

  const allSteps: StepBuilder[] = [];
  for (const [uuid, stepEvents] of stepsByUuid) {
    const first = stepEvents[0];
    const turnId = first?.turnId || 'unknown';
    const beginEvt = stepEvents.find(e => e.type === 'step.begin');
    const endEvt = stepEvents.find(e => e.type === 'step.end');
    const beginTime = beginEvt?._outerTime || stepEvents[0]?._outerTime || 0;
    const endTime = endEvt?._outerTime;
    allSteps.push({
      uuid,
      turnId,
      events: stepEvents,
      beginTime,
      endTime,
      stepUsage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
    });
  }

  // 将 usage.record 按最近 step.end / step.begin 时间匹配到 step，每条记录只使用一次。
  // 这样 messages 累加结果才会与 wire.jsonl 直接累加一致。
  const sortedSteps = allSteps.sort((a, b) => a.beginTime - b.beginTime);
  const sortedUsage = normalUsageRecords.sort((a, b) => (a.time || 0) - (b.time || 0));
  const usedUsage = new Set<number>();

  for (const step of sortedSteps) {
    const targetTime = step.endTime || step.beginTime;
    let bestIdx = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < sortedUsage.length; i++) {
      if (usedUsage.has(i)) continue;
      const diff = Math.abs((sortedUsage[i].time || 0) - targetTime);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      usedUsage.add(bestIdx);
      const u = sortedUsage[bestIdx].usage;
      step.stepUsage = {
        inputOther: u?.inputOther || 0,
        output: u?.output || 0,
        inputCacheRead: u?.inputCacheRead || 0,
        inputCacheCreation: u?.inputCacheCreation || 0,
      };
      if (sortedUsage[bestIdx].model) {
        step.model = sortedUsage[bestIdx].model;
      }
    }
  }

  // 剩余未匹配的 usage record 归到时间最近的 step（保证 wire 总量全部被 messages 覆盖）
  for (let i = 0; i < sortedUsage.length; i++) {
    if (usedUsage.has(i)) continue;
    const u = sortedUsage[i];
    let bestStep = sortedSteps[0];
    let bestDiff = Infinity;
    for (const step of sortedSteps) {
      const targetTime = step.endTime || step.beginTime;
      const diff = Math.abs((u.time || 0) - targetTime);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestStep = step;
      }
    }
    if (bestStep) {
      const usage = u.usage;
      bestStep.stepUsage = {
        inputOther: bestStep.stepUsage.inputOther + (usage?.inputOther || 0),
        output: bestStep.stepUsage.output + (usage?.output || 0),
        inputCacheRead: bestStep.stepUsage.inputCacheRead + (usage?.inputCacheRead || 0),
        inputCacheCreation: bestStep.stepUsage.inputCacheCreation + (usage?.inputCacheCreation || 0),
      };
      if (!bestStep.model && u.model) bestStep.model = u.model;
    }
  }

  // 把 step 按 turnId 分组，并匹配 thinkingEffort（优先 turnStep，其次时间最近 llm.request）
  const stepsByTurn = new Map<string, StepBuilder[]>();
  for (const step of sortedSteps) {
    const turnId = step.turnId;
    if (turnId === 'unknown') continue;
    if (!stepsByTurn.has(turnId)) {
      stepsByTurn.set(turnId, []);
    }
    stepsByTurn.get(turnId)!.push(step);
  }
  Array.from(stepsByTurn.entries()).forEach(([turnId, steps]) => {
    steps.forEach((step, idx) => {
      // model 别名 (__xxx__) 修正：优先 turnStep 精确匹配，其次时间最近的 llm.request
      if (!step.model || isModelAlias(step.model)) {
        let realModel = modelByTurnStep.get(`${turnId}.${idx + 1}`);
        if (!realModel) {
          const mEnd = step.endTime ?? step.beginTime + 60_000;
          let mBest: { model: string; diff: number } | null = null;
          for (const r of llmRequestModels) {
            if (r.time < step.beginTime - 50) continue;
            if (r.time > mEnd + 2_000) break;
            const diff = Math.abs(r.time - step.beginTime);
            if (!mBest || diff < mBest.diff) mBest = { model: r.model, diff };
          }
          realModel = mBest?.model;
        }
        if (realModel) step.model = realModel;
      }

      const byKey = effortByTurnStep.get(`${turnId}.${idx + 1}`);
      if (byKey) {
        step.thinkingEffort = byKey;
        return;
      }
      // 时间匹配：step 区间内或 begin 后最近的 llm.request
      const end = step.endTime ?? step.beginTime + 60_000;
      let best: { effort: string; diff: number } | null = null;
      for (const r of llmRequestEfforts) {
        if (r.time < step.beginTime - 50) continue;
        if (r.time > end + 2_000) break;
        const diff = Math.abs(r.time - step.beginTime);
        if (!best || diff < best.diff) best = { effort: r.effort, diff };
      }
      step.thinkingEffort = best?.effort || lastConfigEffort;
    });
  });

  // kimi 的 turnId 从 0 开始，对应第 1 条用户消息后的 assistant 回复
  // 每个 step 生成一条独立的 assistant message，与 opencode 多 step 消息语义对齐
  const assistantMessages: KimiMessageItem[] = [];

  for (const [turnId, steps] of stepsByTurn) {
    if (turnId === 'unknown') continue;

    const turnIdx = parseInt(turnId, 10);
    const parentUserUuid = !isNaN(turnIdx) && turnIdx >= 0 && turnIdx < userMessageUuids.length ? userMessageUuids[turnIdx] : undefined;

    for (const step of steps) {
      const stepEvents = step.events;
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: KimiToolCallItem[] = [];
      const parts: any[] = [];
      const toolPartIndexByCallId = new Map<string, number>();
      const pendingToolCalls = new Map<string, KimiToolCallItem>();
      let latencyMs: number | undefined;
      let streamDurationMs: number | undefined;
      let finishReason: string | undefined;
      let lastStepEndTime: number | undefined;
      let model: string | undefined;

      for (const evt of stepEvents) {
        if (evt.type === 'content.part') {
          const part = evt.part;
          if (part?.type === 'text' && part.text) {
            textParts.push(part.text);
            parts.push({
              type: 'text',
              text: part.text,
              state: 'done',
            });
          } else if (part?.type === 'think' && part.think) {
            thinkingParts.push(part.think);
            parts.push({
              type: 'reasoning',
              text: part.think,
              state: 'done',
            });
          }
        } else if (evt.type === 'tool.call') {
          const tc: KimiToolCallItem = {
            toolCallId: evt.toolCallId || evt.uuid,
            name: evt.name,
            args: evt.args || {},
            description: evt.description,
          };
          toolCalls.push(tc);
          pendingToolCalls.set(tc.toolCallId, tc);
          const toolPart: any = {
            type: 'tool',
            tool: tc.name,
            callID: tc.toolCallId,
            state: {
              status: 'calling',
              input: tc.args,
              output: undefined,
              title: tc.description,
            },
          };
          toolPartIndexByCallId.set(tc.toolCallId, parts.length);
          parts.push(toolPart);
        } else if (evt.type === 'tool.result') {
          const tcId = evt.toolCallId || evt.parentUuid;
          const isError = !!(evt.result && typeof evt.result === 'object' && (evt.result as any).isError);
          const soft = isError
            ? classifySoftToolError({ result: evt.result })
            : { soft: false as const };
          // soft（用户中断等）→ completed，不计入 hard fail
          const status = isError && !soft.soft ? 'failed' : (evt.result !== undefined ? 'completed' : 'calling');
          const tc = pendingToolCalls.get(tcId);
          if (tc) {
            tc.result = evt.result;
          } else {
            // 尝试在全局 toolCalls 中回填（跨 step 的 tool result）
            const existing = toolCalls.find(t => t.toolCallId === tcId);
            if (existing) {
              existing.result = evt.result;
            }
          }
          // 回填 parts 中对应的 tool part
          const partIdx = toolPartIndexByCallId.get(tcId);
          if (partIdx !== undefined) {
            const toolPart = parts[partIdx];
            if (toolPart && toolPart.type === 'tool') {
              toolPart.state.status = status;
              toolPart.state.output = evt.result;
              if (isError && !soft.soft) toolPart.state.error = evt.result;
              if (soft.soft) {
                toolPart.state.metadata = {
                  ...(toolPart.state.metadata || {}),
                  errorSeverity: 'soft',
                  errorKind: soft.kind,
                };
              }
            }
          }
        } else if (evt.type === 'step.end') {
          if (evt.llmFirstTokenLatencyMs) {
            latencyMs = evt.llmFirstTokenLatencyMs;
          }
          if (evt.llmStreamDurationMs) {
            streamDurationMs = evt.llmStreamDurationMs;
          }
          finishReason = evt.finishReason;
          lastStepEndTime = evt._outerTime || lastStepEndTime;
          if (evt.model && !isModelAlias(evt.model)) model = evt.model;
        }
      }

      // 使用已匹配的 usage.record；若 step.end 里带 model 也保留
      const stepUsage = step.stepUsage;
      if (!model && step.model) model = step.model;
      if (isModelAlias(model)) model = undefined;

      assistantMessages.push({
        uuid: crypto.randomUUID(),
        sessionId: messageSessionId,
        role: 'assistant',
        timestamp: lastStepEndTime || step.beginTime || Date.now(),
        text: textParts.join('\n'),
        thinking: thinkingParts.join('\n') || undefined,
        thinkingEffort: step.thinkingEffort,
        toolCalls,
        parts,
        usage: stepUsage,
        lastStepUsage: stepUsage,
        model,
        latencyMs,
        streamDurationMs,
        finishReason,
        parentID: parentUserUuid,
      });
    }
  }

  // 解析并附加 Kimi Code 的 context compaction 事件，使其在 detail messages 中可见
  const compactAssistantMessages = buildKimiCompactMessages(events, messageSessionId, compactUsageRecords, messages);

  return [...messages, ...assistantMessages, ...compactAssistantMessages].sort((a, b) => a.timestamp - b.timestamp);
}

/** 最近一次 compaction 的 apply 时间（ms），用于 session.time_compacting */
export function getKimiLastCompactionApplyTime(events: any[]): number | undefined {
  const ranges = getKimiCompactRanges(events);
  if (ranges.length === 0) return undefined;
  return ranges[ranges.length - 1].applyTime;
}

function getKimiCompactRanges(events: any[]): Array<{
  beginTime: number;
  applyTime: number;
  completeTime: number;
  source?: string;
}> {
  const ranges: Array<{ beginTime: number; applyTime: number; completeTime: number; source?: string }> = [];
  let currentBegin: number | undefined;
  let currentApply: number | undefined;
  let currentSource: string | undefined;
  for (const event of events) {
    if (event.type === 'full_compaction.begin') {
      currentBegin = event.time;
      currentSource = typeof event.source === 'string' ? event.source : undefined;
    } else if (event.type === 'context.apply_compaction') {
      currentApply = event.time;
    } else if (event.type === 'full_compaction.complete') {
      if (currentBegin !== undefined && currentApply !== undefined) {
        ranges.push({
          beginTime: currentBegin,
          applyTime: currentApply,
          completeTime: event.time,
          source: currentSource,
        });
      }
      currentBegin = undefined;
      currentApply = undefined;
      currentSource = undefined;
    }
  }
  return ranges;
}

function buildKimiCompactMessages(
  events: any[],
  sessionId: string,
  compactUsageRecords: any[] = [],
  userMessages: KimiMessageItem[] = [],
): KimiMessageItem[] {
  const ranges = getKimiCompactRanges(events);
  if (ranges.length === 0) return [];

  const applyEvents = new Map<number, any>();
  for (const event of events) {
    if (event.type === 'context.apply_compaction') {
      applyEvents.set(event.time, event);
    }
  }

  const sortedUserMessages = [...userMessages].sort((a, b) => a.timestamp - b.timestamp);

  const messages: KimiMessageItem[] = [];
  for (const range of ranges) {
    const applyEvent = applyEvents.get(range.applyTime);
    if (!applyEvent) continue;

    const {
      summary,
      contextSummary,
      compactedCount,
      tokensBefore,
      tokensAfter,
      keptUserMessageCount,
    } = applyEvent;
    const sourceLabel = range.source === 'manual' ? '手动' : range.source === 'auto' ? '自动' : undefined;
    const lines: string[] = [
      sourceLabel ? `[Context Compacted] ${sourceLabel}压缩` : '[Context Compacted]',
    ];
    if (compactedCount !== undefined && tokensBefore !== undefined && tokensAfter !== undefined) {
      lines.push(`压缩了 ${compactedCount} 条消息，上下文从 ${tokensBefore} tokens 缩减到 ${tokensAfter} tokens（保留 ${keptUserMessageCount ?? '?'} 条用户消息）。`);
    }
    const durationMs = range.completeTime - range.beginTime;
    if (durationMs >= 0) {
      lines.push(`耗时 ${durationMs}ms。`);
    }
    if (summary) {
      lines.push('', '## 摘要', summary);
    }
    if (contextSummary && contextSummary !== summary) {
      lines.push('', '## 上下文摘要', contextSummary);
    }
    const text = lines.join('\n');

    // 累加本次 compact 期间产生的 usage.record（生成 summary 的 LLM 调用）
    const rangeUsage = compactUsageRecords.filter(u => u.time >= range.beginTime && u.time <= range.completeTime);
    const compactUsage: KimiUsage = {
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    };
    for (const u of rangeUsage) {
      const usage = u.usage;
      if (!usage) continue;
      compactUsage.inputOther += usage.inputOther || 0;
      compactUsage.output += usage.output || 0;
      compactUsage.inputCacheRead += usage.inputCacheRead || 0;
      compactUsage.inputCacheCreation += usage.inputCacheCreation || 0;
    }

    // compact 发生在两条 user 之间，应挂到 apply 之前最后一条 user（不是下一条 prompt）
    const prevUserMsg = [...sortedUserMessages].reverse().find(u => u.timestamp < range.applyTime);
    const parentMsg = prevUserMsg;

    messages.push({
      uuid: crypto.randomUUID(),
      sessionId,
      role: 'assistant',
      timestamp: range.applyTime,
      text,
      thinking: undefined,
      toolCalls: [],
      parts: [{
        type: 'text',
        text,
        state: 'done',
      }],
      usage: compactUsage,
      lastStepUsage: compactUsage,
      parentID: parentMsg?.uuid,
      // compact 已结束 → finish + completed，避免无下一句 prompt 时被判 in-progress
      finishReason: 'end_turn',
      streamDurationMs: Math.max(0, (range.completeTime || range.applyTime) - range.beginTime),
      latencyMs: Math.max(0, range.applyTime - range.beginTime),
    });
  }

  return messages;
}

/**
 * 直接累加 wire.jsonl 中所有 usage.record，获取 session 级别总用量
 * 比从重建消息中累加更准确（一个 turn 可能包含多个 step/usage record）
 */
export async function getKimiSessionUsageSummary(
  sessionIdOrDir: string,
  agentKey = 'main',
): Promise<{
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
  total: number;
  model?: string;
}> {
  let dir = sessionIdOrDir;
  if (!fs.existsSync(dir)) {
    const parsed = parseKimiVirtualSessionId(sessionIdOrDir);
    const found = await findSessionDir(parsed.rootSessionId);
    if (!found) throw new Error(`Kimi session not found: ${sessionIdOrDir}`);
    dir = found;
    if (!agentKey || agentKey === 'main') {
      agentKey = parsed.agentDir || 'main';
    }
  }

  const events = await readWireEvents(dir, agentKey);
  const summary = {
    inputOther: 0,
    output: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
    total: 0,
    model: undefined as string | undefined,
  };

  for (const event of events) {
    if (event.type === 'usage.record') {
      const u = (event as any).usage;
      summary.inputOther += u.inputOther || 0;
      summary.output += u.output || 0;
      summary.inputCacheRead += u.inputCacheRead || 0;
      summary.inputCacheCreation += u.inputCacheCreation || 0;
      const m = (event as any).model;
      if (m && !summary.model && !isModelAlias(m)) {
        summary.model = m;
      }
    } else if (event.type === 'llm.request') {
      // llm.request.model 为真实 model (usage.record 可能是 __secondary__ 别名)，优先采用
      const m = (event as any).model;
      if (m && !isModelAlias(m)) {
        summary.model = m;
      }
    }
  }

  summary.total = summary.inputOther + summary.inputCacheRead + summary.output;
  return summary;
}

async function findSessionDir(sessionId: string): Promise<string | null> {
  if (!fs.existsSync(SESSION_INDEX_PATH)) {
    return null;
  }
  const content = await fs.promises.readFile(SESSION_INDEX_PATH, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim() !== '');
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item.sessionId === sessionId) {
        return item.sessionDir;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

// ==================== CLI 测试入口 ====================

if (require.main === module) {
  (async () => {
    const sessions = await listKimiCodeSessions();
    console.log(`共 ${sessions.length} 个 kimi sessions`);
    if (sessions.length > 0) {
      const last = sessions[0];
      console.log('最新 session:', last);
      const msgs = await listKimiCodeMessages({ sessionId: last.sessionId, sessionDir: last.sessionDir });
      console.log(`共 ${msgs.length} 条消息`);
      for (const m of msgs.slice(0, 10)) {
        console.log(`[${m.role}] ${m.text.slice(0, 80).replace(/\n/g, ' ')}... tokens=${JSON.stringify(m.usage)} tools=${m.toolCalls.length}`);
      }
    }
  })();
}
