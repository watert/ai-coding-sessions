/**
* `~/.claude/history.jsonl` 可以拿到 session list with project & sessionId & timestamp, 作为基础数据
* `~/.claude/projects/[project_path]/[sessionId].jsonl` 可以拿到 session detail with messages
* `~/.claude/projects/[project_path]/[sessionId]/subagents/*.jsonl` 可以拿到 subagent detail with messages
 *
 * 路径：一律 path.join；CLAUDE_CONFIG_DIR / XDG+~/.claude 探测（对齐 ccusage）。
 */
import fs from 'fs';
import path from 'path';
import z from 'zod';
import _ from 'lodash';
import { resolveDataRoot, resolveHomeDir } from '../lib/home-paths';
import {
  parseClaudeJsonl,
  reconstructClaudeMainChain,
  type ClaudeChainMeta,
} from './claude-main-chain';

function normalizeClaudeConfigPath(p: string): string {
  const abs = path.resolve(p);
  if (path.basename(abs) === 'projects') return path.dirname(abs);
  return abs;
}

function claudeBaseOk(p: string): boolean {
  try {
    return fs.existsSync(path.join(p, 'projects')) || fs.existsSync(path.join(p, 'history.jsonl'));
  } catch {
    return false;
  }
}

/** 解析 Claude 配置根：env → XDG_CONFIG_HOME/claude → ~/.claude */
export function resolveClaudeBase(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveHomeDir(env);
  const xdg =
    env.XDG_CONFIG_HOME?.trim()
      ? path.resolve(env.XDG_CONFIG_HOME.trim())
      : path.join(home, '.config');
  const homeClaude = path.join(home, '.claude');
  return resolveDataRoot({
    envValue: env.CLAUDE_CONFIG_DIR,
    defaults: [path.join(xdg, 'claude'), homeClaude],
    fallback: homeClaude,
    normalize: normalizeClaudeConfigPath,
    isOk: claudeBaseOk,
  });
}

/** 每次调用 re-resolve，便于测试注入 CLAUDE_CONFIG_DIR / HOME */
function claudeBase(): string {
  return resolveClaudeBase();
}

function historyPath(): string {
  return path.join(claudeBase(), 'history.jsonl');
}

export type ClaudeSessionItem = {
  display: string;
  pastedContents: Record<string, any>;
  timestamp: number;
  project: string;
  sessionId: string;
  date?: Date;
  projectPath?: string;
}
export async function listClaudeCodeSessions() {
  const hp = historyPath();
  if (!fs.existsSync(hp)) return [];
  const history = await fs.promises.readFile(hp, 'utf-8');
  const sessions = history.split(/\r\n|\n|\r/).filter(line => line.trim() !== '').map(line => {
    const item: ClaudeSessionItem = JSON.parse(line);
    item.date = new Date(item.timestamp);
    item.projectPath = getProjectPath(item.project);
    return item;
  });
  return sessions;
}

/** project cwd → Claude projects 下目录名（/ 与 \\ 均换成 -） */
export function encodeClaudeProjectDir(project: string): string {
  return project.replace(/[/\\]/g, '-');
}

export function getProjectPath(project: string, base: string = claudeBase()) {
  return path.join(base, 'projects', encodeClaudeProjectDir(project));
}

export async function listClaudeCodeSubagents(project: string, sessionId: string) {
  const projectPath = getProjectPath(project);
  const subagents = await fs.promises.readdir(path.join(projectPath, sessionId, 'subagents'));
  return subagents;
}


export const UsageSchema = z.object({
  input_tokens: z.number(),                              // 输入 token 数
  cache_creation_input_tokens: z.number().optional(),    // 缓存创建消耗的输入 token
  cache_read_input_tokens: z.number().optional(),        // 缓存读取命中的输入 token
  output_tokens: z.number(),                             // 输出 token 数
  server_tool_use: z.object({
    web_search_requests: z.number().optional(),          // 服务端 web 搜索请求数
    web_fetch_requests: z.number().optional(),           // 服务端 web 抓取请求数
  }).optional(),
  service_tier: z.string().optional(),                   // 服务等级: "standard"/"priority" 等
  cache_creation: z.object({
    ephemeral_1h_input_tokens: z.number().optional(),    // 1小时临时缓存创建 token
    ephemeral_5m_input_tokens: z.number().optional(),    // 5分钟临时缓存创建 token
  }).optional(),
  inference_geo: z.string().optional(),                  // 推理地理位置标识
  iterations: z.array(z.any()).optional(),               // 迭代详情数组
  speed: z.string().optional(),                          // 推理速度等级: "standard"/"fast" 等
});
export type UsageItem = z.infer<typeof UsageSchema>;

export const MsgItemSchema = z.object({
  uuid: z.string(), // 消息唯一标识, 如 "393065b7-bb30-47a3-8714-426e45aa0b21"
  parentUuid: z.string().nullable(), // 父消息UUID(用于线程回复), 无父则为 null
  timestamp: z.string(), // ISO 8601 格式时间戳, 如 "2026-04-07T07:51:18.192Z"
  isSidechain: z.boolean(), // 是否为 sidechain 分支消息
  type: z.enum(["user", "assistant"]), // 消息发送者类型: user-用户, assistant-AI
  cwd: z.string(), // 当前工作目录绝对路径
  sessionId: z.string(), // 会话唯一标识
  version: z.string(), // claude-code CLI 版本号, 如 "2.1.92"
  gitBranch: z.string(), // 当前 git 分支名, 如 "main"
  userType: z.string(), // 用户来源类型: "external"/"cli"等
  entrypoint: z.string().optional(), // 入口来源: "cli"/"vscode"等
  promptId: z.string().optional(), // 提示模板ID(用于追踪预设提示)
  permissionMode: z.string().optional(), // 权限模式, 如 "default"
  message: z.object({ // 核心消息对象
    role: z.enum(["user", "assistant"]), // 消息角色, 同外层 type
    type: z.string().optional(), // 消息子类型(如有)
    id: z.string().optional(), // 消息内部ID
    model: z.string().optional(), // AI 模型名称(在 message 内部)
    stop_reason: z.string().nullable().optional(),       // 生成停止原因(在 message 内部)
    stop_sequence: z.any().optional(), // 触发停止的序列(在 message 内部)
    usage: UsageSchema.optional(),                       // Token 使用量统计(在 message 内部)
    content: z.union([ // 消息内容: 字符串(用户)或数组(AI)
      z.string(), // 用户消息纯文本内容
      z.array( // AI消息结构化内容数组
        z.discriminatedUnion("type", [
          z.object({ // AI推理过程(带签名防篡改)
            type: z.literal("thinking"),
            thinking: z.string(), // 推理文本内容
            signature: z.string().optional(),              // 签名验证
          }),
          z.object({ // AI调用工具
            type: z.literal("tool_use"),
            id: z.string(), // 工具调用唯一ID
            name: z.string(), // 工具名称, 如 "Read"/"Edit"
            input: z.record(z.string(), z.any()),          // 工具输入参数
          }),
          z.object({ // 工具执行结果(用户消息中)
            type: z.literal("tool_result"),
            tool_use_id: z.string(), // 对应 tool_use 的 id
            content: z.string(), // 工具返回内容(通常是JSON或文本)
          }),
          z.object({ // AI纯文本回复
            type: z.literal("text"),
            text: z.string(), // 文本内容
          }),
        ])
      ),
    ]),
  }),
});

// 从 Schema 推导出 TypeScript 类型
export type MsgItem = z.infer<typeof MsgItemSchema>;

/**
 * 读 session jsonl 并重建主链（P1 #5）。
 * 跳过 sidechain、处理 compact/snip、沿 parentUuid 取 leaf 链、回收并行 tool sibling。
 */
export async function listClaudeCodeMessages(params: {
  project: string;
  sessionId: string;
}): Promise<any[]> {
  const result = await listClaudeCodeMessagesWithMeta(params);
  return result.messages;
}

/** 同 listClaudeCodeMessages，附带重建 meta */
export async function listClaudeCodeMessagesWithMeta(params: {
  project: string;
  sessionId: string;
}): Promise<{ messages: any[]; meta: ClaudeChainMeta }> {
  const { project, sessionId } = params;
  const projectPath = getProjectPath(project);
  const sessFilePath = path.join(projectPath, `${sessionId}.jsonl`);
  const content = await fs.promises.readFile(sessFilePath, 'utf-8');
  const records = parseClaudeJsonl(content);
  return reconstructClaudeMainChain(records);
}

/** 测试/调试：直接对 records 做主链重建 */
export { reconstructClaudeMainChain, parseClaudeJsonl } from './claude-main-chain';
export type { ClaudeChainMeta, ClaudeChainResult } from './claude-main-chain';

if (require.main === module) { // call from cli script

  (async () => {
    const sessions = await listClaudeCodeSessions();
    const sess = _.last(sessions);
    if (!sess) {
      console.log('no claude sessions found');
      return;
    }
    const {project, sessionId} = sess;
    const projectPath = getProjectPath(project);
    const sessFilePath = path.join(projectPath, `${sessionId}.jsonl`);

    console.log({ HISTORY_PATH: historyPath(), sess, sessFilePath });
    const msgs = await listClaudeCodeMessages({project, sessionId});

    // 采样分析 msg 结构，帮助完善 schema 注释
    console.log(`\n共 ${msgs.length} 条消息`);
    
    // 采样分析包含 usage 的消息 (usage 在 message 对象内部)
    const usageMsgs = msgs.filter((m: any) => m.message?.usage);
    console.log(`\n包含 usage 的消息: ${usageMsgs.length} 条`);
    
    if (usageMsgs.length > 0) {
      const sample = usageMsgs[0];
      console.log('\n=== 采样验证 usage ===');
      const result = UsageSchema.safeParse(sample.message.usage);
      if (result.success) {
        console.log('✅ 验证通过:', JSON.stringify(result.data, null, 2));
      } else {
        console.log('❌ 验证失败:', result.error.flatten());
        console.log('原始数据:', JSON.stringify(sample.message.usage, null, 2));
      }
      
      // 统计所有 usage 字段的分布
      console.log('\n=== Usage 字段分布 ===');
      const fieldCounts: Record<string, number> = {};
      usageMsgs.forEach((m: any) => {
        Object.keys(m.message.usage).forEach(key => {
          fieldCounts[key] = (fieldCounts[key] || 0) + 1;
        });
      });
      console.log(fieldCounts);
      
      // 输出前 3 条原始 usage 数据供参考
      console.log('\n=== 前 3 条原始 usage 数据 ===');
      usageMsgs.slice(0, 3).forEach((m: any, i: number) => {
        console.log(`\n[${i + 1}]`, JSON.stringify(m.message.usage, null, 2));
      });
    }
    
    // console.log('\nMsgs', JSON.stringify(msgs, null, 2));

    
  })();

}