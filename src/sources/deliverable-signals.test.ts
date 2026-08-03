/**
 * deliverable-signals 纯函数单测
 * 覆盖工具、文件和文本三类证据，并验证强信号与启发式信号的区别。
 */
import { describe, expect, it } from 'bun:test';
import { inferDeliverableSignals } from './deliverable-signals';

const toolPart = (tool: string, input: Record<string, unknown> = {}) => ({
  type: 'tool',
  tool,
  state: { input, status: 'completed' },
});

describe('inferDeliverableSignals', () => {
  it('识别 gh issue/pr 的创建和评论工具调用', () => {
    const signals = inferDeliverableSignals({
      parts: [
        toolPart('gh', { command: 'issue create --title bug' }),
        toolPart('github', { subcommand: 'pr', action: 'comment', body: '已修复' }),
      ],
    });

    expect(signals.issue).toBe(1);
    expect(signals.comment).toBe(1);
    expect(signals.toolCalls.gh).toBe(2);
    expect(signals.evidence.tool).toBeGreaterThan(0);
    expect(signals.hasStrongSignal).toBe(true);
    expect(signals.categories).toEqual(['issue', 'comment']);
  });

  it('识别独立 issue/comment 工具，不依赖 gh 命令字符串', () => {
    const signals = inferDeliverableSignals({
      parts: [
        toolPart('create_issue', { title: 'bug' }),
        toolPart('add_comment', { body: '已处理' }),
      ],
    });

    expect(signals.issue).toBe(1);
    expect(signals.comment).toBe(1);
    expect(signals.toolCalls.gh).toBe(2);
    expect(signals.hasStrongSignal).toBe(true);
  });  it('识别 Write/Edit 的文档和配置文件路径', () => {
    const signals = inferDeliverableSignals({
      parts: [
        toolPart('write', { filePath: 'docs/release-notes.md', content: '# Release' }),
        toolPart('edit', { path: 'server/config/app.yaml', content: 'port: 3120' }),
        toolPart('write', { filePath: 'src/index.ts', content: 'export {}' }),
      ],
    });

    expect(signals.doc).toBe(1);
    expect(signals.config).toBe(1);
    expect(signals.toolCalls).toEqual({ gh: 0, write: 2, edit: 1 });
    expect(signals.hasStrongSignal).toBe(true);

    const codeOnly = inferDeliverableSignals({
      parts: [toolPart('write', { filePath: 'src/index.ts', content: 'export {}' })],
    });
    expect(codeOnly.hasDeliverable).toBe(false);
    expect(codeOnly.hasStrongSignal).toBe(false);
  });

  it('识别中文和英文文本中的分析、决策、文档语义', () => {
    const signals = inferDeliverableSignals({
      texts: [
        '这是本次故障的 analysis report，最终 decision 是采用方案 B。',
        '补充 README 使用说明。',
      ],
    });

    expect(signals.analysis).toBe(1);
    expect(signals.decision).toBe(1);
    expect(signals.doc).toBe(1);
    expect(signals.evidence.text).toBe(3);
    expect(signals.hasDeliverable).toBe(true);
    expect(signals.hasStrongSignal).toBe(false);
  });

  it('同一文本中的多个关键词按证据单元计数，不按命中词重复计数', () => {
    const signals = inferDeliverableSignals({
      texts: ['analysis report: decision and recommendation; 分析报告与最终决策。'],
    });

    expect(signals.analysis).toBe(1);
    expect(signals.decision).toBe(1);
    expect(signals.evidence.text).toBe(2);
  });

  it('无信号返回稳定零值', () => {
    expect(inferDeliverableSignals()).toEqual({
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
    });
  });
});
