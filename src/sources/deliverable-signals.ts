/**
 * 交付物嗅探信号（纯规则执行，非 LLM）。
 * 只输出计数和证据来源，不输出原文，供 session JSON 导出复盘。
 */

import type { DeliverableSignals } from '../core';

export type { DeliverableSignals } from '../core';
export type DeliverableSignalKind = 'issue' | 'comment' | 'doc' | 'analysis' | 'decision' | 'config';
export type DeliverableEvidenceSource = 'tool' | 'file' | 'text';

export interface DeliverableScanInput {
  messages?: unknown[];
  parts?: unknown[];
  texts?: unknown[];
  files?: string[];
}

const KINDS: DeliverableSignalKind[] = ['issue', 'comment', 'doc', 'analysis', 'decision', 'config'];
const DOC_RE = /(^|\/)(docs?|documentation|wiki)(\/|$)|\.(md|mdx|rst|adoc|txt)$/i;
const CONFIG_RE = /(^|\/)(\.env[^/]*|.*\.ya?ml|.*\.toml|.*\.config\.[a-z0-9]+|tsconfig.*\.json|package\.json|dockerfile|compose.*\.ya?ml)$/i;

const TEXT_RULES: Array<{ kind: DeliverableSignalKind; re: RegExp }> = [
  { kind: 'issue', re: /\b(?:create|open|file|report|track)\s+(?:a\s+)?(?:github\s+)?(?:issue|bug)|(?:新建|创建|提交|提报|跟踪).{0,12}(?:issue|问题|缺陷|bug)/i },
  { kind: 'comment', re: /\b(?:issue|pr|pull\s+request|review)\s+comment|\bcomment(?:s|ary)?\b|(?:评论|回复|评审意见|留言)/i },
  { kind: 'doc', re: /\b(?:write|update|add|生成|创建|补充).{0,18}(?:documentation|docs?|readme|changelog)|(?:文档|说明文档|README|变更记录|使用说明)/i },
  { kind: 'analysis', re: /\b(?:analysis|analyze|report|findings|postmortem|review\s+report)\b|(?:分析|报告|调查结果|复盘|统计结论)/i },
  { kind: 'decision', re: /\b(?:decision|decide|trade[- ]?off|recommendation|chosen approach)\b|(?:决策|决定|取舍|方案选择|最终方案|建议采用)/i },
];

const TOOL_NAMES = {
  gh: new Set(['gh', 'github', 'github-cli']),
  write: new Set(['write', 'write_file', 'file_write', 'create_file']),
  edit: new Set(['edit', 'edit_file', 'editfile', 'apply_patch', 'multi_edit', 'multi-write', 'patch']),
};

function emptySignals(): DeliverableSignals {
  return {
    issue: 0,
    comment: 0,
    doc: 0,
    analysis: 0,
    decision: 0,
    config: 0,
    categories: [],
    evidence: { tool: 0, file: 0, text: 0 },
    toolCalls: { gh: 0, write: 0, edit: 0 },
    hasDeliverable: false,
    hasStrongSignal: false,
  };
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const item = asRecord(value);
  return typeof item.text === 'string' ? item.text : '';
}

function partInput(part: Record<string, any>): Record<string, any> {
  return asRecord(part.state?.input || part.input || {});
}

function partTool(part: Record<string, any>): string {
  return String(part.tool || part.name || part.state?.tool || '').trim().toLowerCase();
}

function partFilePath(input: Record<string, any>, part: Record<string, any>): string {
  return String(
    input.filePath || input.file_path || input.path || input.filename
    || part.state?.metadata?.filediff?.path || part.state?.title || '',
  );
}

function partText(part: Record<string, any>): string {
  const input = partInput(part);
  return [
    part.text,
    input.content,
    input.body,
    input.message,
    input.title,
    input.description,
    part.state?.title,
  ].filter(value => typeof value === 'string').join('\n');
}

function isToolPart(value: unknown): boolean {
  const part = asRecord(value);
  return part.type === 'tool' || !!part.tool || !!part.name || !!part.state?.input;
}

function addKind(
  result: DeliverableSignals,
  kind: DeliverableSignalKind,
  source: DeliverableEvidenceSource,
  strongKinds?: Set<DeliverableSignalKind>,
) {
  result[kind]++;
  result.evidence[source]++;
  if (strongKinds && (source === 'tool' || source === 'file')) strongKinds.add(kind);
}

function addTextKinds(
  result: DeliverableSignals,
  text: string,
  source: DeliverableEvidenceSource,
  strongKinds?: Set<DeliverableSignalKind>,
) {
  if (!text.trim()) return;
  for (const { kind, re } of TEXT_RULES) {
    if (re.test(text)) addKind(result, kind, source, strongKinds);
  }
}

function scanTool(result: DeliverableSignals, value: unknown, strongKinds: Set<DeliverableSignalKind>) {
  const part = asRecord(value);
  const tool = partTool(part);
  const input = partInput(part);
  const command = String(input.command || input.cmd || input.script || part.state?.command || '');
  const normalized = `${tool} ${command} ${String(input.subcommand || '')} ${String(input.action || '')}`.toLowerCase();
  const isGh = TOOL_NAMES.gh.has(tool)
    || /(?:^|\s)gh\s+(?:issue|pr|api|repo|release)\b/i.test(command)
    || /(?:issue|comment|github|pull_request)/i.test(tool);
  const isWrite = TOOL_NAMES.write.has(tool);
  const isEdit = TOOL_NAMES.edit.has(tool);

  if (isGh) {
    result.toolCalls.gh++;
    result.evidence.tool++;
    if (/(?:gh\s+)?(?:issue|pr)\s+(?:create|open|edit|close|reopen)|\b(?:create|open|file)[ _-]+issue\b/i.test(normalized)) {
      addKind(result, 'issue', 'tool', strongKinds);
    }
    if (/(?:gh\s+)?(?:issue|pr)[ _-]+comment|\b(?:add|create|post)[ _-]+comment\b|\bcomment\b/i.test(normalized)) {
      addKind(result, 'comment', 'tool', strongKinds);
    }
  }

  if (isWrite) result.toolCalls.write++;
  if (isEdit) result.toolCalls.edit++;
  if (isWrite || isEdit) {
    result.evidence.tool++;
    const filePath = partFilePath(input, part);
    if (DOC_RE.test(filePath)) addKind(result, 'doc', 'file', strongKinds);
    if (CONFIG_RE.test(filePath)) addKind(result, 'config', 'file', strongKinds);
    addTextKinds(result, partText(part), 'tool', strongKinds);
  }

  if (isGh && !isWrite && !isEdit) addTextKinds(result, partText(part), 'tool', strongKinds);
}

function finishSignals(result: DeliverableSignals, strongKinds: Set<DeliverableSignalKind>): DeliverableSignals {
  result.categories = KINDS.filter(kind => result[kind] > 0);
  result.hasDeliverable = result.categories.length > 0;
  result.hasStrongSignal = strongKinds.size > 0;
  return result;
}

/** 从统一消息、tool parts、文本和编辑文件路径生成可解释的交付物信号。 */
export function inferDeliverableSignals(input: DeliverableScanInput = {}): DeliverableSignals {
  const result = emptySignals();
  const strongKinds = new Set<DeliverableSignalKind>();
  const messages = input.messages || [];
  const parts = [...(input.parts || [])];

  for (const message of messages) {
    const msg = asRecord(message);
    for (const part of Array.isArray(msg.parts) ? msg.parts : []) parts.push(part);
  }

  for (const part of parts) {
    if (isToolPart(part)) scanTool(result, part, strongKinds);
    else addTextKinds(result, textOf(part), 'text');
  }
  for (const text of input.texts || []) addTextKinds(result, textOf(text), 'text');

  for (const file of input.files || []) {
    if (DOC_RE.test(file)) addKind(result, 'doc', 'file', strongKinds);
    if (CONFIG_RE.test(file)) addKind(result, 'config', 'file', strongKinds);
  }

  return finishSignals(result, strongKinds);
}
