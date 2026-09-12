/**
 * OpenCode SQLite 只读层（session 列表/详情、checkSessionStatus）
 * 统一 API 见 ai-coding-stats；本文档: docs/opencode.md，总览: docs/ai-coding-architecture.md
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import _ from 'lodash';
import { z } from 'zod';
import {
  stripOpencodeUserPromptInjection,
  sampleUserPartsForList,
  countUserPartsByDay,
} from '../core';
import { initSqliteDb, getSqliteDb, closeSqliteDb } from '../lib/sqlite';
import { ensureModelsDevData, calculateSessionPricing, type SessionPricing } from '../pricing';
import { buildActivitySpanFromTimingStats } from './usage-by-day';
import { classifyBashCommands, extractBashCommands } from './bash-signals';
import { inferDeliverableSignals } from './deliverable-signals';
import { buildOpenCodeSoftErrorSql } from './tool-error-soft';
import { isTimestamp } from '../lib/date-utils';
import {
  createTimingLists,
  pushAssistantTimingSample,
  summarizeTimingLists,
  MAX_DECODE_TPS,
} from '../lib/timing-stats';

// TTFT / decode TPS 口径与护栏统一在 lib/timing-stats.ts；本文件只做窗口提取
const MAX_LATENCY_MS = 300_000; // 单步 TTFT 上限 5min

// ==================== Zod Schema 定义 ====================

const OpenCodeModelSchema = z.object({
  providerID: z.string(), // AI 提供商ID, 如 "gemini"/"openrouter"
  modelID: z.string(), // 模型ID, 如 "gemini-1.5-flash"
});

const OpenCodeTokensSchema = z.object({
  total: z.number().optional(), // 总token数（可选，可以由 input + output 计算）
  input: z.number(), // 输入token数
  output: z.number(), // 输出token数
  reasoning: z.number().optional(), // 推理token数 (o1等模型)
  cache: z.object({
    read: z.number(), // 缓存读取token数
    write: z.number(), // 缓存写入token数
  }).optional(),
  // 最终 step 的真实请求上下文(input + cacheRead)，与总消耗(total)区分；Kimi 等多 step 数据源使用
  context: z.object({
    total: z.number(),
    input: z.number(),
    cacheRead: z.number(),
  }).optional(),
});

const OpenCodeMessageInfoSchema = z.object({
  role: z.enum(['user', 'assistant']), // 消息角色
  time: z.object({
    created: z.number(), // 创建时间戳 (毫秒)
    completed: z.number().optional(), // 完成时间戳 (毫秒)
    decodeStart: z.number().optional(), // 首个模型输出 part 开始时间 / 官方 decodeStart (毫秒)
    decodeEnd: z.number().optional(), // 纯解码精确终点：最后模型输出 part 的 end (毫秒)，剔除消息尾部工具执行
  }),
  summary: z.object({
    diffs: z.array(z.unknown()), // diff 信息数组
  }).optional(),
  agent: z.string().optional(), // agent 名称
  model: OpenCodeModelSchema.optional(), // 模型信息
  id: z.string(), // 消息ID
  sessionID: z.string(), // 会话ID
  parentID: z.string().optional(), // 父消息ID (用于线程回复)
  modelID: z.string().optional(), // 模型ID (历史字段)
  providerID: z.string().optional(), // 提供商ID (历史字段)
  mode: z.string().optional(), // 消息模式
  path: z.object({
    cwd: z.string(), // 当前工作目录
    root: z.string(), // 项目根目录
  }).optional(),
  cost: z.number().optional(), // 消息成本
  tokens: OpenCodeTokensSchema.optional(), // token 统计
  tps: z.object({
    prefill: z.number().optional(), // 输入预填充速度 (tokens/s)
    decode: z.number().optional(), // 输出解码速度 (tokens/s)
  }).optional(), // TPS 统计
  finish: z.string().optional(), // 结束原因
  error: z.any().optional(), // 错误信息（消息失败时）
  compaction: z.boolean().optional(), // context compact 消息（OpenCode agent=compaction / Kimi）
  /** thinking effort（Kimi 等）：on / low / high / max */
  thinkingEffort: z.string().optional(),
  /** 限流重试（Kimi 429 等）：该逻辑 step 前的失败重试聚合 */
  retry: z.object({
    count: z.number(), // 重试次数
    waitMs: z.number(), // 重试 backoff 总等待 (毫秒)
    rateLimit: z.boolean().optional(), // 是否含 429 限流
  }).optional(),
});

const OpenCodePartSchema = z.object({
  type: z.string(), // part 类型: text/tool/snapshot等
  id: z.string(), // part ID
  sessionID: z.string(), // 会话ID
  messageID: z.string(), // 所属消息ID
  text: z.string().optional(), // 文本内容
  snapshot: z.string().optional(), // 快照内容
  time: z.object({
    start: z.number().optional(), // 开始时间戳 (毫秒)
    end: z.number().optional(), // 结束时间戳 (毫秒)
  }).optional(),
  callID: z.string().optional(), // 工具调用ID
  tool: z.string().optional(), // 工具名称: edit/write/bash等
  state: z.union([
    z.string(),
    z.object({
      status: z.string().optional(), // 状态: pending/running/completed/failed，可选
      input: z.record(z.string(), z.unknown()).optional(), // 工具输入参数
      output: z.unknown().optional(), // 工具输出结果
      title: z.string().optional(), // 操作标题 (显示用)
      metadata: z.record(z.string(), z.unknown()).optional(), // 元数据: filediff等
      time: z.object({
        start: z.number().optional(), // 工具开始时间
        end: z.number().optional(), // 工具结束时间
      }).optional(),
    }),
  ]).optional(),
  reason: z.string().optional(), // 拒绝/失败原因
});

const OpenCodeMessageSchema = z.object({
  info: OpenCodeMessageInfoSchema, // 消息信息
  parts: z.array(OpenCodePartSchema), // 消息包含的所有parts
});

const OpenCodeSessionInfoSchema = z.object({
  id: z.string(), // 会话ID
  project_id: z.string(), // 项目ID
  parent_id: z.string().optional().nullable(), // 父会话ID (fork时)，可为 null
  slug: z.string(), // 会话slug (URL友好)
  directory: z.string(), // 项目目录
  title: z.string(), // 会话标题
  version: z.string(), // 会话版本
  share_url: z.string().optional().nullable(), // 分享URL，可为 null
  summary_additions: z.number().optional().nullable(), // 新增行数汇总，可为 null
  summary_deletions: z.number().optional().nullable(), // 删除行数汇总，可为 null
  summary_files: z.number().optional().nullable(), // 修改文件数汇总，可为 null
  summary_diffs: z.string().optional().nullable(), // diff 汇总文本，可为 null
  revert: z.string().optional().nullable(), // 回退信息，可为 null
  permission: z.string().optional().nullable(), // 权限级别，可为 null
  time_created: z.number(), // 创建时间戳 (毫秒)
  time_updated: z.number(), // 更新时间戳 (毫秒)
  time_compacting: z.number().optional().nullable(), // 压缩时间戳，可为 null
  time_archived: z.number().optional().nullable(), // 归档时间戳，可为 null
  workspace_id: z.string().optional().nullable(), // 工作区ID，可为 null
  project_name: z.string().optional().nullable(), // 项目名称，可为 null
  project_worktree: z.string().optional().nullable(), // 项目工作树路径，可为 null
  session_status: z.enum(['in-progress', 'done', 'error', 'aborted', 'unknown']).optional(),
});

const EditDiffsSchema = z.object({
  additions: z.number(), // 新增总行数
  deletions: z.number(), // 删除总行数
  filesChanged: z.number(), // 修改的文件数
  files: z.array(z.string()).optional(), // 修改文件路径
});

const SessionPricingSchema = z.object({
  usd: z.number(),
  cny: z.number(),
  details: z.array(z.object({
    modelKey: z.string(),
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    usd: z.number(),
    cny: z.number(),
    inputCost: z.number().optional(),
    outputCost: z.number().optional(),
    cacheReadCost: z.number().optional(),
    cacheWriteCost: z.number().optional(),
  })).optional(),
});

const DeliverableSignalsSchema = z.object({
  issue: z.number(),
  comment: z.number(),
  doc: z.number(),
  analysis: z.number(),
  decision: z.number(),
  config: z.number(),
  categories: z.array(z.enum(['issue', 'comment', 'doc', 'analysis', 'decision', 'config'])),
  evidence: z.object({ tool: z.number(), file: z.number(), text: z.number() }),
  toolCalls: z.object({ gh: z.number(), write: z.number(), edit: z.number() }),
  hasDeliverable: z.boolean(),
  hasStrongSignal: z.boolean(),
});

const OpenCodeSessionExportSchema = z.object({
  info: OpenCodeSessionInfoSchema, // 会话信息
  messages: z.array(OpenCodeMessageSchema), // 所有消息
  editDiffs: EditDiffsSchema, // edit/write操作的diff统计
  deliverableSignals: DeliverableSignalsSchema.optional(),
  pricing: SessionPricingSchema.optional(),
});

const TextPartSchema = z.object({
  role: z.string(), // 消息角色: user/assistant
  text: z.string(), // 文本内容
  tool: z.string(), // 工具名称 (空表示普通文本)
  duration: z.number(), // 持续时间 (毫秒)
  startTime: z.number(), // 开始时间戳 (毫秒)
  endTime: z.number(), // 结束时间戳 (毫秒)
  origin: z.enum(['insert', 'queued', 'interrupt']).optional(), // 运行中插入 / 排队 / 打断
});

const SessionListItemSchema = z.object({
  session_id: z.string(), // 会话ID
  session_title: z.string(), // 会话标题
  session_dir: z.string(), // 项目目录
  project_id: z.string(), // 项目ID
  project_name: z.string(), // 项目名称
  project_worktree: z.string(), // 项目工作树路径
  parent_id: z.string().optional(), // 父会话ID
  /** subagent 并发分组：父 session 中 task 工具的 message_id */
  spawn_group_id: z.string().optional(),
  total_messages: z.number(), // 总消息数
  total_user_messages: z.number(), // 用户消息数
  total_tool_calls: z.number(), // 工具调用次数
  total_tool_calls_success: z.number().optional(), // 成功工具调用次数
  total_tool_calls_failed: z.number().optional(), // 失败工具调用次数
  total_tokens: z.number(), // 总token数
  total_input: z.number(), // 输入token数
  total_output: z.number(), // 输出token数
  total_reasoning: z.number(), // 推理token数
  total_cache_read: z.number(), // 缓存读取token数
  total_cache_write: z.number().optional(), // 缓存写入token数
  last_active_at_iso: z.string().optional(),
  last_active_at: z.string(), // 最后活跃时间 ISO
  models_used: z.string(), // 使用的模型 (逗号分隔)
  last_message_tokens: z.number().optional(), // 最后一条消息的token数
  /** session 内最大 context window（input+cacheRead；compact 前峰值） */
  max_context_tokens: z.number().optional(),
  /** compact 次数（assistant summary / agent=compaction） */
  compact_count: z.number().optional(),
  /** 最近一次 compact 时间 ms */
  time_compacting: z.number().optional().nullable(),
  /** 运行中插入的 user 条数 */
  insert_count: z.number().optional(),
  /** 排队等本轮结束再送 */
  queued_count: z.number().optional(),
  /** 打断当前轮后再说 */
  interrupt_count: z.number().optional(),
  last_message: z.any().optional(), // 最后一条消息的完整数据
  textParts: z.array(TextPartSchema).optional(), // 所有文本parts
  userParts: z.array(TextPartSchema).optional(), // 用户文本parts (去重后)
  user_messages_by_day: z.record(z.string(), z.number()).optional(),
  avg_tps: z.number().optional(), // 平均 decode TPS (tokens per second)
  avg_latency_ms: z.number().optional(), // 平均延迟 (毫秒)
  avg_prefill_tps: z.number().optional(), // 平均 prefill TPS (tokens/s)
  assistant_tps_list: z.array(z.number()).optional(), // 所有assistant消息的TPS列表
  latency_list: z.array(z.number()).optional(), // 所有延迟列表 (毫秒)
  prefill_tps_list: z.array(z.number()).optional(), // 所有prefill TPS列表
  editDiffs: EditDiffsSchema.optional(), // edit diff统计
  deliverableSignals: DeliverableSignalsSchema.optional(), // 交付物嗅探
  session_status: z.enum(['in-progress', 'done', 'error', 'aborted', 'unknown']), // 会话状态
});

// ==================== 导出类型 ====================

export type OpenCodeMessageInfo = z.infer<typeof OpenCodeMessageInfoSchema>;
export type OpenCodePart = z.infer<typeof OpenCodePartSchema>;
export type OpenCodeMessage = z.infer<typeof OpenCodeMessageSchema>;
export type OpenCodeSessionInfo = z.infer<typeof OpenCodeSessionInfoSchema>;
export type OpenCodeSessionExport = z.infer<typeof OpenCodeSessionExportSchema>;
export type SessionListItem = z.infer<typeof SessionListItemSchema>;

// ==================== 导出 Schema ====================

export { OpenCodeMessageInfoSchema, OpenCodePartSchema, OpenCodeMessageSchema, OpenCodeSessionInfoSchema, OpenCodeSessionExportSchema, SessionListItemSchema, EditDiffsSchema };

/**
 * 获取最新一条 message 的更新时间
 */
export async function checkLastUpdateTime(): Promise<Date> {
  const database = getOpencodeDb();
  const row = database.prepare("SELECT time_updated FROM message ORDER BY time_updated DESC LIMIT 1").get() as any;
  return row ? new Date(row.time_updated) : new Date(0);
}

// ==================== DB 初始化 ====================

/**
 * 获取 opencode 数据库路径。
 * 优先 `OPENCODE_DB_PATH`（hermetic 测试 / 自定义安装）；否则 `opencode db path`。
 */
export function getOpencodeDbPath(): string {
  const fromEnv = process.env.OPENCODE_DB_PATH?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  try {
    return execSync('opencode db path', { encoding: 'utf-8' }).trim();
  } catch (e) {
    throw new Error(`获取 opencode db path 失败: ${e}`);
  }
}

/** 初始化数据库连接 */
export async function initOpencodeDb(): Promise<void> {
  await initSqliteDb('opencode', getOpencodeDbPath, false);
  // 创建只读优化索引：加速 session list 的 tool 统计
  try {
    const db = getOpencodeDb();
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_part_session_tool_status
      ON part (session_id, json_extract(data, '$.state.status'))
      WHERE json_extract(data, '$.type') = 'tool'
    `);
  } catch (e) {
    console.warn('[opencode] 创建优化索引失败:', e);
  }
  // 预加载价格数据，列表成本计算依赖它
  try {
    await ensureModelsDevData();
  } catch (e) {
    console.warn('[opencode] 价格数据初始化失败:', e);
  }
}

/** 获取数据库实例 */
export function getOpencodeDb() {
  return getSqliteDb('opencode');
}

// ==================== 工具函数 ====================

/**
 * 计算 edit/write tool 的 diff 统计
 * @param parts part 列表
 */
export function calculateEditDiffs(parts: OpenCodePart[]): { additions: number; deletions: number; filesChanged: number; files: string[] } {
  const editToolParts = parts.filter(part => ['edit', 'write'].includes(part.tool || ''));
  let totalAdditions = 0;
  let totalDeletions = 0;
  const filesChanged = new Set<string>();

  for (const part of editToolParts) {
    let additions = _.get(part, 'state.metadata.filediff.additions', 0);
    let deletions = _.get(part, 'state.metadata.filediff.deletions', 0);
    let filePath = (_.get(part, 'state.metadata.filediff.path', '') as string) ||
                     (_.get(part, 'state.input.path', '') as string) ||
                     (_.get(part, 'state.title', '') as string);
    if (part.tool === 'write') {
      filePath = filePath || _.get(part, 'state.input.filePath', '') as string;
      if (!additions) {
        const stateObj = typeof part.state === 'object' && part.state !== null ? part.state : {};
        const { content = '' } = (stateObj as { input?: { content?: string } }).input || {};
        additions = content.split('\n').length;
      }
    }
    totalAdditions += additions;
    totalDeletions += deletions;
    if (filePath) filesChanged.add(filePath);
  }

  return {
    additions: totalAdditions,
    deletions: totalDeletions,
    filesChanged: filesChanged.size,
    files: [...filesChanged],
  };
}

/** 判断是否是用户中断错误 */
function isMessageAbortedError(err: any): boolean {
  if (!err) return false;
  if (typeof err === 'string') return err.includes('Aborted') || err.includes('aborted');
  return err.name === 'MessageAbortedError' || err?.data?.message === 'Aborted';
}

/** finish 是否表示正常结束（兼容 kimi end_turn / zcode completed） */
function isFinishDone(finish?: string): boolean {
  return finish === 'stop' || finish === 'end_turn' || finish === 'completed';
}

/** finish 是否表示仍在 tool 循环中（兼容 kimi tool_use） */
function isFinishInProgress(finish?: string): boolean {
  return finish === 'tool-calls' || finish === 'tool_use';
}

/** finish 是否表示用户中断 / 取消（kimi step.end interrupted + turn.cancel） */
function isFinishAborted(finish?: string): boolean {
  return finish === 'interrupted' || finish === 'cancelled' || finish === 'aborted' || finish === 'abort';
}

/** tool 仍在执行中（opencode: calling/pending；zcode: running） */
function isToolInProgressStatus(status?: string): boolean {
  return status === 'calling' || status === 'pending' || status === 'running';
}

/** 是否 context compact 消息（已完成压缩，会话空闲） */
function isCompactionMessage(msg: { info?: any; parts?: any[] } | null | undefined): boolean {
  if (!msg) return false;
  if (msg.info?.compaction) return true;
  if (msg.info?.agent === 'compaction' || msg.info?.mode === 'compaction') return true;
  const parts = msg.parts || [];
  if (parts.some((p: any) => p.type === 'compaction')) return true;
  return parts.some((p: any) => String(p.text || '').startsWith('[Context Compacted]'));
}

/** 判断会话状态 */
export function checkSessionStatus(messages: OpenCodeMessage[]): 'in-progress' | 'done' | 'error' | 'aborted' | 'unknown' {
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg) return 'done';
  if (!lastMsg.info) return 'unknown';

  // compact 已落地（assistant 摘要）→ done；仅有 user 侧 compact 触发、尚无摘要 → 仍进行中
  if (isCompactionMessage(lastMsg)) {
    return lastMsg.info.role === 'assistant' ? 'done' : 'in-progress';
  }

  // 只有 user 消息，没有 assistant 回复 → 进行中
  if (lastMsg.info.role === 'user') return 'in-progress';

  // 异常结束: 只检查最后一条消息的 error，tool call 失败不算异常结束
  const getError = (m: OpenCodeMessage) => m.info.error;
  const lastError = getError(lastMsg);
  if (isMessageAbortedError(lastError)) return 'aborted';
  if (lastError && !isMessageAbortedError(lastError)) return 'error';

  // 用户取消必须先于 tool 扫描 / 空 parts：kimi turn.cancel 常留下
  // finish=interrupted 的空 step，或取消瞬间 tool 仍 calling。
  if (isFinishAborted(lastMsg.info.finish)) return 'aborted';

  // tool 仍在执行 → 进行中（含 zcode 的 running）。
  // 全局扫描而非只看最后一条：后台任务（grok [bg]/<status>running</status>）启动后
  // agent 可继续输出文本结束本轮，未终态 tool 散落在历史消息里，仍算 in-progress。
  const hasInProgressTools = messages.some(
    (m) => m.parts?.some(
      (p: any) => p.type === 'tool' && isToolInProgressStatus(p.state?.status),
    ),
  );
  if (hasInProgressTools) return 'in-progress';

  // 明确结束 / 未结束
  if (isFinishDone(lastMsg.info.finish)) return 'done';
  if (isFinishInProgress(lastMsg.info.finish)) return 'in-progress';

  // parts 为空 → 刚开始，进行中
  if (!lastMsg.parts?.length) return 'in-progress';

  // fallback: 没有 completed 时间则认为进行中
  return lastMsg.info.time?.completed ? 'done' : 'in-progress';
}

// ==================== 查询方法 ====================

/**
 * 获取指定消息的 parts
 * @param messageIds 消息 ID 列表
 * @param types part 类型，默认 ["text"]
 */
export function getMsgParts(messageIds: string[], types: string[] = ["text"]): OpenCodePart[] {
  const database = getOpencodeDb();

  if (messageIds.length === 0) return [];

  const placeholders = messageIds.map(() => '?').join(',');
  const typePlaceholders = types.map(() => '?').join(',');

  const sql = `
    SELECT id, message_id, session_id, time_created, time_updated, data
    FROM part
    WHERE message_id IN (${placeholders})
      AND json_extract(data, '$.type') IN (${typePlaceholders})
    ORDER BY time_created ASC
  `;

  const rows = database.prepare(sql).all(...messageIds, ...types) as any[];

  return rows.map(row => {
    const partData = JSON.parse(row.data);
    return {
      ...partData,
      id: row.id,
      sessionID: row.session_id,
      messageID: row.message_id,
      time: { start: row.time_created, end: row.time_updated },
    };
  });
}

/**
 * 一条消息的模型输出窗口（ms）—— TTFT / decode 口径的唯一数据源。
 * 新版本 opencode 仅 text/reasoning 等输出类 part 在 data 内带 time；
 * step-start/tool/patch/step-finish 一律无 —— 故“带 time 的 part”即模型解码段。
 */
export interface MessageOutputWindow {
  /** 首个输出 part 的 start（真首 token 时刻，TTFT 终点 / decode 起点） */
  outStart?: number;
  /** 末个输出 part 的 end（纯 decode 终点，不含尾部工具执行） */
  outEnd?: number;
  /** part 表最早落库时间（step-start）；无输出 part 的消息用它做整段近似兜底 */
  dbFirst?: number;
}

/**
 * 批量取模型输出窗口。三个值一次 SQL 拿全（json_extract 走 part(message_id, id) 索引）。
 * 无输出 part（纯工具轮 / 老版本单 part）时 outStart 退化为 dbFirst（整段近似）。
 */
export function getMessageOutputWindows(messageIds: string[]): Map<string, MessageOutputWindow> {
  const database = getOpencodeDb();
  const result = new Map<string, MessageOutputWindow>();
  if (messageIds.length === 0) return result;

  const placeholders = messageIds.map(() => '?').join(',');
  const rows = database.prepare(`
    SELECT message_id,
      MIN(json_extract(data, '$.time.start')) AS out_start,
      MAX(COALESCE(json_extract(data, '$.time.end'), json_extract(data, '$.time.start'))) AS out_end,
      MIN(time_created) AS db_first
    FROM part
    WHERE message_id IN (${placeholders})
    GROUP BY message_id
  `).all(...messageIds) as any[];

  for (const row of rows) {
    const win: MessageOutputWindow = {};
    if (typeof row.out_start === 'number') win.outStart = row.out_start;
    if (typeof row.out_end === 'number') win.outEnd = row.out_end;
    if (typeof row.db_first === 'number') win.dbFirst = row.db_first;
    result.set(row.message_id, win);
  }
  return result;
}

/**
 * 统一 TTFT / decode 解析（口径见 lib/timing-stats.ts）。
 * - TTFT   = 首 token(输出 part.start) − created；无输出 part 时退化用 part 落库时间
 * - decode = 纯输出段(end − start)；无 outEnd 时退化用 completed − start
 * 只做有效性判断，不作业务裁剪；TPS 上限由 pushAssistantTimingSample 兜底。
 */
export function resolveStepTiming(args: {
  created?: number;
  completed?: number;
  window?: MessageOutputWindow;
}): { ttftMs?: number; decodeMs?: number } {
  const { created, completed, window: win } = args;
  const start = win?.outStart ?? win?.dbFirst;
  const ttftMs = created && start && start > created && start - created < MAX_LATENCY_MS
    ? start - created
    : undefined;
  let decodeMs: number | undefined;
  if (start && win?.outEnd && win.outEnd > start) decodeMs = win.outEnd - start;
  else if (start && completed && completed > start) decodeMs = completed - start;
  return { ttftMs, decodeMs };
}

/**
 * 从消息 parts 提取模型输出时序窗口（detail 内存版，等价 getMessageOutputWindows 的 SQL 版）。
 * @returns firstStart=首个输出 part 开始（decode 起点/TTFT 参考），lastEnd=末个输出 part 结束（纯 decode 终点）
 */
function pickPartTimingWindow(parts: OpenCodePart[]): { firstStart?: number; lastEnd?: number } {
  let firstStart: number | undefined;
  let lastEnd: number | undefined;
  for (const p of parts) {
    const s = p.time?.start;
    if (typeof s !== 'number') continue;
    if (firstStart === undefined || s < firstStart) firstStart = s;
    const end = typeof p.time?.end === 'number' ? p.time.end! : s;
    if (lastEnd === undefined || end > lastEnd) lastEnd = end;
  }
  return { firstStart, lastEnd };
}

/** 列表预览：按日头尾采样（见 user-part-list-preview） */
function capUserParts(parts: z.infer<typeof TextPartSchema>[]): z.infer<typeof TextPartSchema>[] {
  return sampleUserPartsForList(parts);
}

const TASK_SESSION_ID_RE = /<task\s+id="([^"]+)"/;

/**
 * 从父 session 的 task tool parts 推导 child session → spawn_group_id(message_id)
 * 同一 message 下多个 task = 一轮并发
 */
export function getChildSessionSpawnGroups(parentSessionIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (parentSessionIds.length === 0) return map;
  const database = getOpencodeDb();
  const placeholders = parentSessionIds.map(() => '?').join(',');
  const sql = `
    SELECT message_id, data
    FROM part
    WHERE session_id IN (${placeholders})
      AND json_extract(data, '$.type') = 'tool'
      AND json_extract(data, '$.tool') = 'task'
  `;
  const rows = database.prepare(sql).all(...parentSessionIds) as Array<{ message_id: string; data: string }>;
  for (const row of rows) {
    let childId: string | undefined;
    try {
      const partData = JSON.parse(row.data);
      const metaSid = partData?.state?.metadata?.sessionId;
      if (typeof metaSid === 'string' && metaSid) {
        childId = metaSid;
      } else {
        const output = partData?.state?.output;
        if (typeof output === 'string') {
          const m = output.match(TASK_SESSION_ID_RE);
          if (m?.[1]) childId = m[1];
        }
      }
    } catch {
      // ignore
    }
    if (childId && row.message_id) {
      map.set(childId, row.message_id);
    }
  }
  return map;
}

/** 按 session 批量获取 tool parts，compact 模式下供 diff、Bash 和交付物信号复用 */
function getToolPartsBySession(sessionIds: string[]): OpenCodePart[] {
  const database = getOpencodeDb();
  if (sessionIds.length === 0) return [];
  const placeholders = sessionIds.map(() => '?').join(',');
  const sql = `
    SELECT id, message_id, session_id, time_created, time_updated, data
    FROM part
    WHERE session_id IN (${placeholders})
      AND json_extract(data, '$.type') = 'tool'
    ORDER BY time_created ASC
  `;
  const rows = database.prepare(sql).all(...sessionIds) as any[];
  return rows.map(row => {
    const partData = JSON.parse(row.data);
    return {
      ...partData,
      id: row.id,
      sessionID: row.session_id,
      messageID: row.message_id,
      time: { start: row.time_created, end: row.time_updated },
    };
  });
}

type SessionUserPartsPayload = {
  parts: z.infer<typeof TextPartSchema>[];
  byDay: Record<string, number>;
};

/** 按 session 批量获取用户文本 parts，compact 模式下避免加载所有 text parts */
function getUserTextPartsBySession(sessionIds: string[]): Map<string, SessionUserPartsPayload> {
  const database = getOpencodeDb();
  const result = new Map<string, SessionUserPartsPayload>();
  if (sessionIds.length === 0) return result;

  const placeholders = sessionIds.map(() => '?').join(',');
  // 先从 message 表取 user 消息 id (session_id 有索引)，避免 part JOIN message 时逐行 json_extract
  const userMsgRows = database.prepare(`
    SELECT id FROM message
    WHERE session_id IN (${placeholders})
      AND json_extract(data, '$.role') = 'user'
  `).all(...sessionIds) as Array<{ id: string }>;
  if (userMsgRows.length === 0) return result;

  const msgIds = userMsgRows.map(r => r.id);
  const msgPlaceholders = msgIds.map(() => '?').join(',');
  // message_id 有 part_message_id_id_idx 索引
  const sql = `
    SELECT p.id, p.message_id, p.session_id, p.time_created, p.time_updated, p.data
    FROM part p
    WHERE p.message_id IN (${msgPlaceholders})
      AND json_extract(p.data, '$.type') = 'text'
    ORDER BY p.time_created ASC
  `;
  const rows = database.prepare(sql).all(...msgIds) as any[];
  const rawBySession = new Map<string, z.infer<typeof TextPartSchema>[]>();

  rows.forEach(row => {
    const partData = JSON.parse(row.data);
    const part: z.infer<typeof TextPartSchema> = {
      role: 'user',
      text: stripOpencodeUserPromptInjection(partData.text || ''),
      tool: partData.tool || '',
      duration: (row.time_updated || 0) - (row.time_created || 0),
      startTime: row.time_created || 0,
      endTime: row.time_updated || 0,
    };
    if (!part.text.trim()) return;
    const list = rawBySession.get(row.session_id) || [];
    list.push(part);
    rawBySession.set(row.session_id, list);
  });

  rawBySession.forEach((parts, sessionId) => {
    const deduped = parts.filter((r, i) => {
      const prevText = i > 0 ? parts[i - 1].text : '';
      return prevText !== r.text;
    });
    result.set(sessionId, { parts: capUserParts(deduped), byDay: countUserPartsByDay(deduped) });
  });
  return result;
}

interface MessageTimingStat {
  messageID: string;
  sessionID: string;
  role: string;
  created: number;
  completed?: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  providerID?: string;
  modelID?: string;
}

/** 轻量获取用于 TPS/latency/pricing 计算的消息元数据，避免解析完整 message data 和 JOIN part */
function getMessageTimingStats(sessionIds: string[]): Map<string, MessageTimingStat[]> {
  const database = getOpencodeDb();
  const result = new Map<string, MessageTimingStat[]>();
  if (sessionIds.length === 0) return result;

  const placeholders = sessionIds.map(() => '?').join(',');
  const sql = `
    SELECT
      m.id,
      m.session_id,
      json_extract(m.data, '$.role') AS role,
      json_extract(m.data, '$.time.created') AS created,
      json_extract(m.data, '$.time.completed') AS completed,
      json_extract(m.data, '$.tokens.input') AS input,
      json_extract(m.data, '$.tokens.output') AS output,
      json_extract(m.data, '$.tokens.reasoning') AS reasoning,
      json_extract(m.data, '$.tokens.cache.read') AS cache_read,
      json_extract(m.data, '$.tokens.cache.write') AS cache_write,
      COALESCE(json_extract(m.data, '$.model.providerID'), json_extract(m.data, '$.providerID')) AS provider_id,
      COALESCE(json_extract(m.data, '$.model.modelID'), json_extract(m.data, '$.modelID')) AS model_id
    FROM message m
    WHERE m.session_id IN (${placeholders})
  `;
  const rows = database.prepare(sql).all(...sessionIds) as any[];
  rows.forEach(row => {
    const stat: MessageTimingStat = {
      messageID: row.id,
      sessionID: row.session_id,
      role: row.role,
      created: row.created,
      completed: row.completed,
      input: row.input || 0,
      output: row.output || 0,
      reasoning: row.reasoning || 0,
      cacheRead: row.cache_read || 0,
      cacheWrite: row.cache_write || 0,
      providerID: row.provider_id || undefined,
      modelID: row.model_id || undefined,
    };
    const list = result.get(row.session_id) || [];
    list.push(stat);
    result.set(row.session_id, list);
  });
  return result;
}

/** 仅根据最后一条消息判断 session 状态，避免 compact 模式加载全部 parts */
export function determineSessionStatusFromLastMessage(lastMsg: any): 'in-progress' | 'done' | 'error' | 'aborted' | 'unknown' {
  if (!lastMsg) return 'done';
  // list 侧 last_message 可能是 message.data（无 parts）；靠 agent/mode/compaction 识别
  if (lastMsg.compaction || lastMsg.agent === 'compaction' || lastMsg.mode === 'compaction') {
    return lastMsg.role === 'assistant' ? 'done' : 'in-progress';
  }
  if (lastMsg.role === 'user') return 'in-progress';
  const lastError = lastMsg.error;
  if (isMessageAbortedError(lastError)) return 'aborted';
  if (lastError) return 'error';
  if (isFinishAborted(lastMsg.finish)) return 'aborted';
  if (isFinishDone(lastMsg.finish)) return 'done';
  if (isFinishInProgress(lastMsg.finish)) return 'in-progress';
  return lastMsg.time?.completed ? 'done' : 'in-progress';
}

/**
 * 获取 session 列表 
 * @param startDate 开始日期 (YYYY-MM-DD)，不传默认今天
 * @param endDate 结束日期 (YYYY-MM-DD)，不传默认今天
 * 如果只传 startDate，endDate 默认为今天
 */
export function getSessionList(
  startDate?: string,
  endDate?: string,
  compact = false,
  models?: string[],
  /** 限定 session id（sync 增量 convert 用）；给定时跳过其余 session 的 CTE 扫描 */
  sessionIds?: string[],
): { list: SessionListItem[]; total: number; lastUpdatedAt: Date } {
  const database = getOpencodeDb();
  let whereClause: string;
  let params: any[];

  const startIsTimestamp = isTimestamp(startDate);
  const endIsTimestamp = isTimestamp(endDate);

  // 区间重叠: last_active >= start AND first_active <= end（用 session.time_created 近似 first）
  // 无日期：全量（full sync / orphan 扫描依赖此语义；切勿默认「仅今天」）
  if (!startDate && !endDate) {
    whereClause = '1=1';
    params = [];
  } else if (startIsTimestamp && !endDate) {
    whereClause = `s.time_updated >= ${startDate}`;
    params = [];
  } else if (startIsTimestamp && endIsTimestamp) {
    whereClause = `s.time_updated >= ${startDate} AND s.time_created <= ${endDate}`;
    params = [];
  } else if (!startIsTimestamp && endIsTimestamp) {
    whereClause = `s.time_created <= ${endDate}`;
    params = [];
  } else if (startDate && !endDate) {
    const start = `strftime('%s', '${startDate}') * 1000`;
    whereClause = `s.time_updated >= ${start}`;
    params = [];
  } else if (startDate && endDate) {
    const start = `strftime('%s', '${startDate}') * 1000`;
    const end = `strftime('%s', '${endDate}', '+1 day', 'start of day') * 1000 - 1`;
    whereClause = `s.time_updated >= ${start} AND s.time_created <= ${end}`;
    params = [];
  } else {
    const end = `strftime('%s', '${endDate}', '+1 day', 'start of day') * 1000 - 1`;
    whereClause = `s.time_created <= ${end}`;
    params = [];
  }

  // 增量收窄：whereClause 在 5 处 CTE 复用，统一追加 id 过滤（id 为源侧主键，转义单引号防注入）
  if (sessionIds && sessionIds.length > 0) {
    const ids = sessionIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
    whereClause = `(${whereClause}) AND s.id IN (${ids})`;
  }

  // 模型过滤：只要 session 里任意一条 assistant 消息的 modelID 命中即可
  const modelFilter = models && models.length > 0
    ? `AND EXISTS (
      SELECT 1 FROM message mm
      WHERE mm.session_id = s.id
        AND json_extract(mm.data, '$.role') = 'assistant'
        AND COALESCE(json_extract(mm.data, '$.model.modelID'), json_extract(mm.data, '$.modelID')) IN (${models.map(() => '?').join(',')})
    )`
    : '';

  const sql = `
    WITH msg_stats AS (
      SELECT
        m.session_id,
        COUNT(DISTINCT m.id) AS total_messages,
        COUNT(DISTINCT CASE WHEN json_extract(m.data, '$.role') = 'user' THEN m.id END) AS total_user_messages,
        SUM(CAST(COALESCE(json_extract(m.data, '$.tokens.total'), 0) AS INTEGER)) AS total_tokens,
        SUM(CAST(COALESCE(json_extract(m.data, '$.tokens.input'), 0) AS INTEGER)) AS total_input,
        SUM(CAST(COALESCE(json_extract(m.data, '$.tokens.output'), 0) AS INTEGER)) AS total_output,
        SUM(CAST(COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0) AS INTEGER)) AS total_reasoning,
        SUM(CAST(COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) AS INTEGER)) AS total_cache_read,
        SUM(CAST(COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0) AS INTEGER)) AS total_cache_write,
        MAX(
          CASE
            WHEN json_extract(m.data, '$.role') != 'assistant' THEN 0
            WHEN json_extract(m.data, '$.tokens.context.total') IS NOT NULL
              THEN CAST(json_extract(m.data, '$.tokens.context.total') AS INTEGER)
            ELSE CAST(COALESCE(json_extract(m.data, '$.tokens.input'), 0) AS INTEGER)
              + CAST(COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) AS INTEGER)
          END
        ) AS max_context_tokens,
        SUM(CASE
          WHEN json_extract(m.data, '$.role') = 'assistant'
            AND (
              json_extract(m.data, '$.agent') = 'compaction'
              OR json_extract(m.data, '$.mode') = 'compaction'
              OR json_extract(m.data, '$.summary') = 1
              OR json_extract(m.data, '$.summary') = 'true'
            )
          THEN 1 ELSE 0
        END) AS compact_count,
        MAX(CASE
          WHEN json_extract(m.data, '$.role') = 'assistant'
            AND (
              json_extract(m.data, '$.agent') = 'compaction'
              OR json_extract(m.data, '$.mode') = 'compaction'
              OR json_extract(m.data, '$.summary') = 1
              OR json_extract(m.data, '$.summary') = 'true'
            )
          THEN COALESCE(
            CAST(json_extract(m.data, '$.time.completed') AS INTEGER),
            m.time_created
          )
          ELSE NULL
        END) AS time_compacting_msg,
        GROUP_CONCAT(DISTINCT COALESCE(
          json_extract(m.data, '$.model.modelID'),
          json_extract(m.data, '$.modelID')
        )) AS models_used,
        GROUP_CONCAT(m.id) AS message_ids
      FROM message m
      WHERE m.session_id IN (
        SELECT s.id FROM session s
        INNER JOIN project p ON s.project_id = p.id
        WHERE ${whereClause}
        ${modelFilter}
      )
      GROUP BY m.session_id
    ),
    part_stats AS (
      SELECT
        tp.session_id,
        COUNT(*) AS total_tool_calls,
        -- soft（abort/rg-json-too-large）计入 success，不计入 failed
        COUNT(CASE
          WHEN json_extract(tp.data, '$.state.status') = 'completed' THEN 1
          WHEN json_extract(tp.data, '$.state.status') IN ('failed', 'error')
            AND (
              ${buildOpenCodeSoftErrorSql("COALESCE(json_extract(tp.data, '$.state.error'), json_extract(tp.data, '$.state.output'), '')")}
            ) THEN 1
        END) AS total_tool_calls_success,
        COUNT(CASE
          WHEN json_extract(tp.data, '$.state.status') IN ('failed', 'error')
            AND NOT (
              ${buildOpenCodeSoftErrorSql("COALESCE(json_extract(tp.data, '$.state.error'), json_extract(tp.data, '$.state.output'), '')")}
            ) THEN 1
        END) AS total_tool_calls_failed
      FROM (
        SELECT session_id, data
        FROM part
        WHERE json_extract(data, '$.type') = 'tool'
      ) tp
      WHERE tp.session_id IN (
        SELECT s.id FROM session s
        INNER JOIN project p ON s.project_id = p.id
        WHERE ${whereClause}
        ${modelFilter}
      )
      GROUP BY tp.session_id
    ),
    last_msg AS (
      SELECT
        m.session_id,
        json(m.data) AS last_message_json
      FROM message m
      INNER JOIN (
        SELECT session_id, MAX(time_created) AS max_time
        FROM message
        WHERE json_extract(data, '$.tokens.total') > 0
          -- 限定候选 session 范围，避免全表扫描 (45k+ 消息): 1.3s -> ~25ms
          AND session_id IN (
            SELECT s.id FROM session s
            WHERE ${whereClause}
          )
        GROUP BY session_id
      ) latest ON m.session_id = latest.session_id AND m.time_created = latest.max_time
    ),
    -- 异常 session (429/API error/被杀) 全程 0 token, 上面的 tokens 过滤取不到 → 裸 NULL 会被判 done;
    -- fallback 到字面最后一条消息, error/未回复 user 才能被识别
    last_msg_fallback AS (
      SELECT
        m.session_id,
        json(m.data) AS last_message_json
      FROM message m
      INNER JOIN (
        SELECT session_id, MAX(time_created) AS max_time
        FROM message
        WHERE session_id IN (
          SELECT s.id FROM session s
          WHERE ${whereClause}
        )
        GROUP BY session_id
      ) latest ON m.session_id = latest.session_id AND m.time_created = latest.max_time
      WHERE m.session_id NOT IN (SELECT session_id FROM last_msg)
    )
    SELECT
      s.id AS session_id,
      s.title AS session_title,
      s.directory AS session_dir,
      s.parent_id,
      p.id AS project_id,
      p.name AS project_name,
      p.worktree AS project_worktree,
      COALESCE(ms.total_messages, 0) AS total_messages,
      COALESCE(ms.total_user_messages, 0) AS total_user_messages,
      COALESCE(ps.total_tool_calls, 0) AS total_tool_calls,
      COALESCE(ps.total_tool_calls_success, 0) AS total_tool_calls_success,
      COALESCE(ps.total_tool_calls_failed, 0) AS total_tool_calls_failed,
      COALESCE(ms.total_tokens, 0) AS total_tokens,
      COALESCE(ms.total_input, 0) AS total_input,
      COALESCE(ms.total_output, 0) AS total_output,
      COALESCE(ms.total_reasoning, 0) AS total_reasoning,
      COALESCE(ms.total_cache_read, 0) AS total_cache_read,
      COALESCE(ms.total_cache_write, 0) AS total_cache_write,
      COALESCE(ms.max_context_tokens, 0) AS max_context_tokens,
      COALESCE(ms.compact_count, 0) AS compact_count,
      COALESCE(s.time_compacting, ms.time_compacting_msg) AS time_compacting,
      s.time_created AS session_time_created,
      s.time_updated AS session_time_updated,
      datetime(s.time_updated / 1000, 'unixepoch', 'localtime') AS last_active_at,
      COALESCE(lm.last_message_json, lf.last_message_json) AS last_message_json,
      ms.models_used,
      ms.message_ids
    FROM session s
    INNER JOIN project p ON s.project_id = p.id
    LEFT JOIN msg_stats ms ON ms.session_id = s.id
    LEFT JOIN part_stats ps ON ps.session_id = s.id
    LEFT JOIN last_msg lm ON lm.session_id = s.id
    LEFT JOIN last_msg_fallback lf ON lf.session_id = s.id
    WHERE ${whereClause}
    ${modelFilter}
    GROUP BY s.id, p.id
    ORDER BY s.time_updated DESC
  `;

  const rows = database.prepare(sql).all(...params, ...(models || []), ...params, ...(models || []), ...params, ...(models || [])) as any[];
  
  const buildLastTokenInfo = (msg: any) => {
    const tokens = msg?.tokens;
    if (!tokens || !tokens.total) return undefined;
    return {
      input: tokens.input || 0,
      cacheRead: tokens.cache?.read || 0,
      output: tokens.output || 0,
      reasoning: tokens.reasoning || 0,
      total: tokens.total || 0,
    };
  };

  const results = rows.map(row => {
    let last_message_tokens: number | undefined;
    let last_message: any = undefined;
    let lastTokenInfo: { input: number; cacheRead: number; output: number; reasoning: number; total: number } | undefined;

    if (row.last_message_json) {
      try {
        const lastMsg = typeof row.last_message_json === 'string'
          ? JSON.parse(row.last_message_json)
          : row.last_message_json;
        last_message_tokens = lastMsg?.tokens?.total;
        last_message = lastMsg;
        lastTokenInfo = buildLastTokenInfo(lastMsg);
      } catch (e) {
        // 解析失败忽略
      }
    }

    const result = { ...row, last_message_tokens, last_message, lastTokenInfo };
    delete result.last_message_json;
    return result;
  });

  // compact 模式：列表视图只返回必要字段，避免加载全部 text parts 和完整 message data
  if (compact) {
    const sessionIds = results.map(r => r.session_id);
    const toolPartsBySession = _.groupBy(getToolPartsBySession(sessionIds), 'sessionID');
    const userPartsBySession = getUserTextPartsBySession(sessionIds);
    const timingStatsBySession = getMessageTimingStats(sessionIds);

    // 模型输出窗口（TTFT 终点 / 纯 decode 段）：一次 SQL 拿全，避免 JOIN part 导致性能骤降
    const allMessageIds: string[] = [];
    for (const stats of Array.from(timingStatsBySession.values())) {
      for (const s of stats) allMessageIds.push(s.messageID);
    }
    const windowsByMessage = getMessageOutputWindows(allMessageIds);

    const pricingBySession = new Map<string, SessionPricing>();
    for (const [sessionId, stats] of Array.from(timingStatsBySession.entries())) {
      const inputs = stats
        .filter(s => s.modelID)
        .map(s => ({
          providerID: s.providerID,
          modelID: s.modelID,
          tokens: {
            input: s.input,
            output: s.output,
            cacheRead: s.cacheRead,
            cacheWrite: s.cacheWrite,
          },
        }));
      pricingBySession.set(sessionId, calculateSessionPricing(inputs));
    }

    const parentIdsForSpawn = Array.from(new Set(
      results.map((r: any) => r.parent_id).filter(Boolean) as string[],
    ));
    const spawnGroupByChild = getChildSessionSpawnGroups(parentIdsForSpawn);

    const list = results.map(row => {
      const sessionId = row.session_id;
      const userPayload = userPartsBySession.get(sessionId);
      const userParts = userPayload?.parts ?? [];
      const user_messages_by_day = userPayload?.byDay;
      const toolParts = toolPartsBySession[sessionId] || [];
      const timingStats = timingStatsBySession.get(sessionId) || [];
      const spawn_group_id = spawnGroupByChild.get(sessionId);

      // 统一 TTFT / decode 口径（见 lib/timing-stats.ts）：全部 assistant 采样。
      // 勿按 user 轮次只取首条 —— agent loop 一轮多步时会把其余步的 TPS/TTFT 整批丢掉
      const timingLists = createTimingLists();
      const sortedStats = timingStats
        .filter(s => s.role)
        .sort((a, b) => a.created - b.created);

      for (const msg of sortedStats) {
        if (msg.role !== 'assistant') continue;
        const { ttftMs, decodeMs } = resolveStepTiming({
          created: msg.created,
          completed: msg.completed,
          window: windowsByMessage.get(msg.messageID),
        });
        pushAssistantTimingSample(timingLists, {
          latencyMs: ttftMs,
          outputTokens: msg.output + msg.reasoning,
          decodeDurationMs: decodeMs,
          inputTokens: ttftMs ? msg.input : 0,
        });
      }

      const {
        avg_tps: avgTps,
        avg_latency_ms: avgLatency,
        avg_prefill_tps: avgPrefillTps,
      } = summarizeTimingLists(timingLists);

      const editDiffs = calculateEditDiffs(toolParts);
      const bashSignals = classifyBashCommands(extractBashCommands(toolParts));
      const deliverableSignals = inferDeliverableSignals({
        parts: toolParts,
        texts: userParts,
      });
      const session_status = determineSessionStatusFromLastMessage(row.last_message);
      const fallbackLast = row.session_time_updated || Date.now();
      const fallbackFirst = row.session_time_created || fallbackLast;
      const activity = buildActivitySpanFromTimingStats(timingStats, fallbackLast, fallbackFirst);
      const lastActiveIso = activity.last_active_at_iso
        || (row.session_time_updated ? new Date(row.session_time_updated).toISOString() : new Date().toISOString());

      // 剔除列表视图不需要的大字段
      const { message_ids, last_message: _, ...rest } = row;

      return {
        ...rest,
        last_active_at_iso: lastActiveIso,
        last_active_at: lastActiveIso,
        first_active_at_iso: activity.first_active_at_iso,
        span_days: activity.span_days,
        usage_by_day: activity.usage_by_day,
        userParts,
        user_messages_by_day,
        avg_tps: avgTps,
        avg_latency_ms: avgLatency,
        avg_prefill_tps: avgPrefillTps,
        editDiffs,
        bashSignals,
        deliverableSignals,
        session_status,
        pricing: pricingBySession.get(sessionId) || { usd: 0, cny: 0 },
        ...(spawn_group_id ? { spawn_group_id } : {}),
      };
    });

    const lastMsgRow = database.prepare("SELECT time_updated FROM message ORDER BY time_updated DESC LIMIT 1").get() as any;
    const lastUpdatedAt = lastMsgRow ? new Date(lastMsgRow.time_updated) : new Date(0);
    return { list, total: list.length, lastUpdatedAt };
  }

  const allMessageIds = results.flatMap(row => row.message_ids ? row.message_ids.split(',') : []);
  const allParts = getMsgParts(allMessageIds, ['text', 'tool']);
  // 模型输出窗口（TTFT 终点 / 纯 decode 段）：一条 SQL 拿全，不 JOIN part
  const windowsByMessage = getMessageOutputWindows(allMessageIds);

  // 与 checkLastUpdateTime 同源：从 message 表取全局最新更新时间
  const lastMsgRow = database.prepare("SELECT time_updated FROM message ORDER BY time_updated DESC LIMIT 1").get() as any;
  const lastUpdatedAt = lastMsgRow ? new Date(lastMsgRow.time_updated) : new Date(0);

  const partsByMessageId = _.groupBy(allParts, 'messageID');
  
  // 按 session 分组 parts 用于统计
  const partsBySession = _.groupBy(allParts, 'sessionID');

  const parentIdsForSpawnFull = Array.from(new Set(
    results.map((r: any) => r.parent_id).filter(Boolean) as string[],
  ));
  const spawnGroupByChildFull = getChildSessionSpawnGroups(parentIdsForSpawnFull);
  
  const messageRoles = new Map<string, string>();
  if (allMessageIds.length > 0) {
    const placeholders = allMessageIds.map(() => '?').join(',');
    const messageSql = `
      SELECT id, json_extract(data, '$.role') AS role
      FROM message
      WHERE id IN (${placeholders})
    `;
    const messageRows = database.prepare(messageSql).all(...allMessageIds) as any[];
    messageRows.forEach(row => {
      if (row.role) messageRoles.set(row.id, row.role);
    });
  }
  
  // 获取所有消息完整信息包含时间、tokens 和模型
  const allMessageData: Map<string, { role: string; created: number; completed?: number; tokens?: { total: number; input: number; output: number; reasoning?: number; cache?: { read?: number; write?: number } }; finish?: number; error?: string; providerID?: string; modelID?: string }> = new Map();
  if (allMessageIds.length > 0) {
    const placeholders = allMessageIds.map(() => '?').join(',');
    const messageSql = `
      SELECT id, data 
      FROM message
      WHERE id IN (${placeholders})
    `;
    const messageRows = database.prepare(messageSql).all(...allMessageIds) as any[];
    messageRows.forEach(row => {
      try {
         const msgData = JSON.parse(row.data);
         allMessageData.set(row.id, {
           role: msgData.role,
           created: msgData.time?.created || row.time_created,
           completed: msgData.time?.completed,
           tokens: msgData.tokens,
           finish: msgData.finish,
           error: msgData.error,
           providerID: msgData.model?.providerID || msgData.providerID,
           modelID: msgData.model?.modelID || msgData.modelID,
         });
      } catch (e) {
        // 解析失败忽略
      }
    });
  }

  const list = results.map(row => {
    const messageIds = row.message_ids ? row.message_ids.split(',') : [];
    const textParts = messageIds.flatMap(msgId => {
      const parts = partsByMessageId[msgId] || [];
      const role = messageRoles.get(msgId) || 'unknown';
      return parts.map(part => ({
        role,
        text: part.text || '', tool: part.tool || '',
        duration: (part.time?.end || 0) - (part.time?.start || 0),
        startTime: part.time?.start || 0,
        endTime: part.time?.end || 0,
      }));
    });
    let userParts = textParts
      .filter(part => part.role === 'user')
      .map(part => ({ ...part, text: stripOpencodeUserPromptInjection(part.text || '') }))
      .filter(part => part.text.trim() !== '');
    userParts = userParts.filter((r, i) => {
      const prevText = i > 0 ? userParts[i - 1].text : '';
      return prevText !== r.text;
    });

    // 计算延迟数据和 TPS（统一口径见 lib/timing-stats.ts；全部 assistant 采样）
    const timingLists = createTimingLists();

    // 按时间顺序遍历消息
    const sortedMessages = messageIds
      .map(id => ({ id, ...allMessageData.get(id) }))
      .filter(m => m.role)
      .sort((a, b) => (a.created || 0) - (b.created || 0));

    for (const msg of sortedMessages) {
      if (msg.role !== 'assistant') continue;
      const { ttftMs, decodeMs } = resolveStepTiming({
        created: msg.created,
        completed: msg.completed,
        window: windowsByMessage.get(msg.id),
      });
      pushAssistantTimingSample(timingLists, {
        latencyMs: ttftMs,
        outputTokens: (msg.tokens?.output || 0) + (msg.tokens?.reasoning || 0),
        decodeDurationMs: decodeMs,
        inputTokens: ttftMs ? (msg.tokens?.input || 0) : 0,
      });
    }

    const timingSummary = summarizeTimingLists(timingLists);
    const avgTps = timingSummary.avg_tps;
    const avgLatency = timingSummary.avg_latency_ms;
    const avgPrefillTps = timingSummary.avg_prefill_tps;
    const tpsList = timingSummary.assistant_tps_list ?? [];
    const latencyList = timingSummary.latency_list ?? [];
    const prefillTpsList = timingSummary.prefill_tps_list ?? [];

    // 统计该 session 的 edit diff
    const sessionParts = partsBySession[row.session_id] || [];
    const editDiffs = calculateEditDiffs(sessionParts);

    // 计算会话状态
    const statusMessages = sortedMessages.map(msg => {
      const msgParts = partsByMessageId[msg.id] || [];
      return {
        info: {
          role: msg.role,
          finish: (msg as any).finish,
          time: { completed: msg.completed },
          error: (msg as any).error,
        },
        parts: msgParts,
      } as OpenCodeMessage;
    });
    const session_status = checkSessionStatus(statusMessages);
    const deliverableSignals = inferDeliverableSignals({
      messages: statusMessages,
    });
    const lastActiveIso = row.session_time_updated
      ? new Date(row.session_time_updated).toISOString()
      : new Date().toISOString();

    // 按实际使用模型计算会话成本
    const pricingInputs = sortedMessages
      .filter(m => m.modelID)
      .map(m => ({
        providerID: m.providerID,
        modelID: m.modelID!,
        tokens: {
          input: m.tokens?.input || 0,
          output: m.tokens?.output || 0,
          cacheRead: m.tokens?.cache?.read || 0,
          cacheWrite: m.tokens?.cache?.write || 0,
        },
      }));
    const pricing = calculateSessionPricing(pricingInputs);

    const spawn_group_id = spawnGroupByChildFull.get(row.session_id);
    return { 
      ...row,
      last_active_at_iso: lastActiveIso,
      last_active_at: lastActiveIso,
      textParts, 
      userParts,
      avg_tps: avgTps,
      avg_latency_ms: avgLatency,
      avg_prefill_tps: avgPrefillTps,
      assistant_tps_list: tpsList.length > 0 ? tpsList : undefined,
      latency_list: latencyList.length > 0 ? latencyList : undefined,
      prefill_tps_list: prefillTpsList.length > 0 ? prefillTpsList : undefined,
      editDiffs,
      deliverableSignals,
      session_status,
      pricing,
      ...(spawn_group_id ? { spawn_group_id } : {}),
    };
  });
  return { list, total: list.length, lastUpdatedAt };
}

/** OpenCode compact：user 有 part.type=compaction；assistant 为 agent/mode=compaction 或 summary=true */
export function isOpencodeCompactionMessage(msgData: any, parts: Array<{ type?: string }> = []): boolean {
  if (parts.some(p => p.type === 'compaction')) return true;
  if (msgData?.agent === 'compaction' || msgData?.mode === 'compaction') return true;
  // assistant.summary 为 true/1；user.summary 是 {diffs} 对象
  const s = msgData?.summary;
  return s === true || s === 1;
}

/** user 侧 compaction part → 可见文本（manual/auto） */
function enrichOpencodeCompactionUserParts(parts: OpenCodePart[]): OpenCodePart[] {
  return parts.map(p => {
    if ((p as any).type !== 'compaction') return p;
    const auto = (p as any).auto === true;
    const mode = auto ? '自动' : '手动';
    const tail = (p as any).tail_start_id ? ` tail=${(p as any).tail_start_id}` : '';
    return {
      ...p,
      type: 'text',
      text: `[Context Compacted] ${mode}压缩${tail}`,
    } as OpenCodePart;
  });
}

/** assistant 摘要前缀 [Context Compacted]，便于与 Kimi 对齐识别 */
function enrichOpencodeCompactionAssistantParts(parts: OpenCodePart[]): OpenCodePart[] {
  let prefixed = false;
  return parts.map(p => {
    if (p.type !== 'text' || !p.text || prefixed) return p;
    if (String(p.text).startsWith('[Context Compacted]')) return p;
    prefixed = true;
    return { ...p, text: `[Context Compacted]\n${p.text}` };
  });
}

function deriveOpencodeTimeCompacting(messages: OpenCodeMessage[]): number | undefined {
  let max = 0;
  for (const m of messages) {
    if (!m.info?.compaction) continue;
    const t = m.info.time?.completed || m.info.time?.created || 0;
    if (t > max) max = t;
  }
  return max > 0 ? max : undefined;
}

/**
 * 获取 session 详情 (包含所有 messages 和 parts)
 * @param sessionId session ID
 */
export function getSessionDetail(sessionId: string): OpenCodeSessionExport | null {
  const database = getOpencodeDb();

  // 1. 获取 session 基础信息
  const sessionSql = `
    SELECT 
      s.*,
      p.name AS project_name,
      p.worktree AS project_worktree
    FROM session s
    INNER JOIN project p ON s.project_id = p.id
    WHERE s.id = ?
  `;
  const session = database.prepare(sessionSql).get(sessionId) as any;
  if (!session) return null;

  // 2. 获取 messages
  const messagesSql = `
    SELECT id, session_id, time_created, time_updated, data
    FROM message
    WHERE session_id = ?
    ORDER BY time_created ASC
  `;
  const messageRows = database.prepare(messagesSql).all(sessionId) as any[];

  // 3. 获取 parts (按 message_id 分组)
  const partsSql = `
    SELECT id, message_id, session_id, time_created, time_updated, data
    FROM part
    WHERE session_id = ?
    ORDER BY time_created ASC
  `;
  const partRows = database.prepare(partsSql).all(sessionId) as any[];

  // 4. 组装数据
  const partsByMessageId = new Map<string, OpenCodePart[]>();
  for (const part of partRows) {
    const partData = JSON.parse(part.data);
    const partInfo: OpenCodePart = {
      ...partData,
      id: part.id,
      sessionID: part.session_id,
      messageID: part.message_id,
    };

    const existing = partsByMessageId.get(part.message_id) || [];
    existing.push(partInfo);
    partsByMessageId.set(part.message_id, existing);
  }

  // 记录各消息在 part 表的最早落库时间：decodeStart 的第三级兑底（纯工具/step-start 类 part 的 data 无 time）
  const partDbFirstByMsg = new Map<string, number>();
  for (const part of partRows) {
    const cur = partDbFirstByMsg.get(part.message_id);
    if (cur === undefined || part.time_created < cur) partDbFirstByMsg.set(part.message_id, part.time_created);
  }

  const messages: OpenCodeMessage[] = messageRows.map(row => {
    const msgData = JSON.parse(row.data);
    let msgParts = partsByMessageId.get(row.id) || [];
    // 模型输出时序窗口：仅认 data 自带 time 的 part（text/reasoning 等）
    const { firstStart: modelFirstStart, lastEnd: modelLastEnd } = pickPartTimingWindow(msgParts);
    // decodeStart 三级兑底：官方 data.decodeStart > 首个模型输出 part.start > part 表最早落库；纯工具轮也用 step-start 近似
    const decodeStart = msgData.time?.decodeStart ?? modelFirstStart ?? partDbFirstByMsg.get(row.id);

    // OpenCode manual/auto compact: user 侧 part.type=compaction；assistant 侧 agent/mode=compaction
    const compactPart = msgParts.find((p: any) => p.type === 'compaction');
    const isCompactionMsg = isOpencodeCompactionMessage(msgData, msgParts);
    if (compactPart) {
      msgParts = enrichOpencodeCompactionUserParts(msgParts);
    } else if (isCompactionMsg && msgData.role === 'assistant') {
      msgParts = enrichOpencodeCompactionAssistantParts(msgParts);
    }

    const messageInfo: OpenCodeMessageInfo = {
      ...msgData,
      id: row.id,
      sessionID: row.session_id,
      time: {
        ...msgData.time,
        decodeStart,
        // 纯 decode 精确终点：最后模型输出 part 的 end（剔尾工具执行）；无输出段则不设
        ...(modelLastEnd ? { decodeEnd: modelLastEnd } : {}),
      },
      ...(isCompactionMsg ? { compaction: true } : {}),
    };

    // assistant 消息计算 prefill / decode TPS（口径见 lib/timing-stats.ts）
    if (messageInfo.role === 'assistant' && messageInfo.tokens) {
      const { created, decodeStart: ds, decodeEnd, completed } = messageInfo.time || {};
      const { input = 0, output = 0, reasoning = 0 } = messageInfo.tokens;
      const tps: { prefill?: number; decode?: number } = {};
      if (created && ds && ds > created && input > 0) {
        tps.prefill = Number((input / ((ds - created) / 1000)).toFixed(2));
      }
      // decode 窗口 = 纯输出段（decodeEnd - decodeStart），尾部工具执行/等待不计入；
      // 无输出 part（老版本）退化用 completed 兜底，与 list 侧 resolveStepTiming 保持一致
      const decodeEndTs = decodeEnd ?? (completed && ds && completed > ds ? completed : undefined);
      if (ds && decodeEndTs && decodeEndTs > ds && (output + reasoning) > 0) {
        const tpsVal = (output + reasoning) / ((decodeEndTs - ds) / 1000);
        if (tpsVal > 0 && tpsVal < MAX_DECODE_TPS) {
          tps.decode = Number(tpsVal.toFixed(2));
        }
      }
      if (tps.prefill || tps.decode) {
        messageInfo.tps = tps;
      }
    }

    return {
      info: messageInfo,
      parts: msgParts,
    };
  });

  // DB 的 time_compacting 常为空，从 compaction 消息回填
  const derivedTimeCompacting = deriveOpencodeTimeCompacting(messages);
  const time_compacting = session.time_compacting || derivedTimeCompacting || null;

  const sessionInfo: OpenCodeSessionInfo = {
    id: session.id,
    project_id: session.project_id,
    parent_id: session.parent_id,
    slug: session.slug,
    directory: session.directory,
    title: session.title,
    version: session.version,
    share_url: session.share_url,
    summary_additions: session.summary_additions,
    summary_deletions: session.summary_deletions,
    summary_files: session.summary_files,
    summary_diffs: session.summary_diffs,
    revert: session.revert,
    permission: session.permission,
    time_created: session.time_created,
    time_updated: session.time_updated,
    time_compacting,
    time_archived: session.time_archived,
    workspace_id: session.workspace_id,
    project_name: session.project_name,
    project_worktree: session.project_worktree,
    session_status: checkSessionStatus(messages),
  };

  const editDiffs = calculateEditDiffs(partRows.map(part => {
    const partData = JSON.parse(part.data);
    return {
      ...partData,
      id: part.id,
      sessionID: part.session_id,
      messageID: part.message_id,
    };
  }));

  const pricingInputs = messages
    .filter(m => m.info.modelID || m.info.model?.modelID)
    .map(m => ({
      providerID: m.info.providerID || m.info.model?.providerID,
      modelID: m.info.modelID || m.info.model?.modelID!,
      tokens: {
        input: m.info.tokens?.input || 0,
        output: m.info.tokens?.output || 0,
        cacheRead: m.info.tokens?.cache?.read || 0,
        cacheWrite: m.info.tokens?.cache?.write || 0,
      },
    }));
  const pricing = calculateSessionPricing(pricingInputs);

  return {
    info: sessionInfo,
    messages,
    editDiffs,
    deliverableSignals: inferDeliverableSignals({ messages }),
    pricing,
  };
}

/**
 * 获取每日 session 统计
 * @param days 天数，默认 60 天
 */
export function getSessionStats(days: number = 60): {
  data: Array<{
    date: string;
    totalTokens: number;
    totalMsgs: number;
    totalUserPrompts: number;
    totalFileDiff: { additions: number; deletions: number; filesChanged: number };
    totalCostCNY: number;
  }>;
} {
  const database = getOpencodeDb();

  // 计算日期范围：从今天往前推 days 天
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (days - 1));
  const startDateStr = startDate.toISOString().split('T')[0];

  const sql = `
    SELECT 
      date(s.time_updated / 1000, 'unixepoch', 'localtime') AS date,
      COUNT(DISTINCT s.id) AS total_sessions,
      COUNT(DISTINCT m.id) AS total_messages,
      COUNT(DISTINCT CASE WHEN json_extract(m.data, '$.role') = 'user' THEN m.id END) AS total_user_messages,
      SUM(CAST(COALESCE(json_extract(m.data, '$.tokens.total'), 0) AS INTEGER)) AS total_tokens,
      SUM(CAST(COALESCE(json_extract(m.data, '$.tokens.input'), 0) AS INTEGER)) AS total_input,
      SUM(CAST(COALESCE(json_extract(m.data, '$.tokens.output'), 0) AS INTEGER)) AS total_output,
      SUM(CAST(COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) AS INTEGER)) AS total_cache_read,
      GROUP_CONCAT(m.id) AS message_ids
    FROM session s
    INNER JOIN project p ON s.project_id = p.id
    LEFT JOIN message m ON s.id = m.session_id
    WHERE date(s.time_updated / 1000, 'unixepoch', 'localtime') >= '${startDateStr}'
    GROUP BY date(s.time_updated / 1000, 'unixepoch', 'localtime')
    ORDER BY date ASC
  `;

  const rows = database.prepare(sql).all() as any[];

  // 获取所有 message ids 以获取 parts 用于计算 file diff
  const allMessageIds = rows.flatMap(row => row.message_ids ? row.message_ids.split(',') : []);
  const allParts = getMsgParts(allMessageIds, ['tool']);
  const partsByMessageId = _.groupBy(allParts, 'messageID');

  // 获取所有消息的 model 信息用于成本计算
  const messageModelMap = new Map<string, { modelID?: string; providerID?: string }>();
  if (allMessageIds.length > 0) {
    const placeholders = allMessageIds.map(() => '?').join(',');
    const messageSql = `
      SELECT id, data 
      FROM message
      WHERE id IN (${placeholders})
    `;
    const messageRows = database.prepare(messageSql).all(...allMessageIds) as any[];
    messageRows.forEach(row => {
      try {
        const msgData = JSON.parse(row.data);
        messageModelMap.set(row.id, {
          modelID: msgData.model?.modelID || msgData.modelID,
          providerID: msgData.model?.providerID || msgData.providerID,
        });
      } catch (e) {
        // 解析失败忽略
      }
    });
  }

  // 按日期分组 message ids
  const messageIdsByDate = new Map<string, string[]>();
  rows.forEach(row => {
    if (row.message_ids) {
      messageIdsByDate.set(row.date, row.message_ids.split(','));
    }
  });

  // 计算每日的 file diff 和成本
  const data = rows.map(row => {
    const dateMessageIds = messageIdsByDate.get(row.date) || [];
    const dateParts = dateMessageIds.flatMap(msgId => partsByMessageId[msgId] || []);
    const totalFileDiff = calculateEditDiffs(dateParts);

    // 简化成本计算：使用默认模型价格表中的第一个模型
    // 实际项目中可能需要根据消息使用的模型来计算
    const totalCostCNY = 0; // 暂时简化为 0，后续可扩展

    return {
      date: row.date,
      totalTokens: row.total_tokens || 0,
      totalMsgs: row.total_messages || 0,
      totalUserPrompts: row.total_user_messages || 0,
      totalFileDiff,
      totalCostCNY,
    };
  });

  return { data };
}

/** 关闭数据库连接 */
export function closeOpencodeDb(): void {
  closeSqliteDb('opencode');
}

/**
 * 更新会话标题
 * @param sessionId 会话ID
 * @param newTitle 新标题
 * @returns 是否更新成功
 */
export function updateSessionTitle(sessionId: string, newTitle: string): boolean {
  const database = getOpencodeDb();
  
  try {
    const result = database.prepare(
      'UPDATE session SET title = ? WHERE id = ?'
    ).run(newTitle, sessionId);
    
    return result.changes > 0;
  } catch (e) {
    console.error('[opencode] 更新会话标题失败:', e);
    return false;
  }
}
