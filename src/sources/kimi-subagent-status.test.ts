import { describe, expect, it } from 'vitest';
import { resolveSubagentSessionStatus } from './kimi-source';

describe('resolveSubagentSessionStatus', () => {
  it('outcome 为 completed/缺失时保留 wire 判定', () => {
    expect(resolveSubagentSessionStatus('done', 'completed')).toBe('done');
    expect(resolveSubagentSessionStatus('in-progress', undefined)).toBe('in-progress');
    expect(resolveSubagentSessionStatus('error', '')).toBe('error');
  });

  it('outcome failed 覆盖为 error', () => {
    expect(resolveSubagentSessionStatus('done', 'failed')).toBe('error');
    expect(resolveSubagentSessionStatus('in-progress', 'failed')).toBe('error');
  });

  it('aborted + wire done → done（做完被父 agent 收割，不算中断）', () => {
    expect(resolveSubagentSessionStatus('done', 'aborted')).toBe('done');
  });

  it('aborted + wire 未完成 → aborted（真被取消，如 turn.cancel）', () => {
    expect(resolveSubagentSessionStatus('in-progress', 'aborted')).toBe('aborted');
    expect(resolveSubagentSessionStatus('unknown', 'aborted')).toBe('aborted');
  });

  it('outcome started/running 是占位信息, 不降级 wire 判定（main wire 缺失时兜底为 started）', () => {
    expect(resolveSubagentSessionStatus('done', 'started')).toBe('done');
    expect(resolveSubagentSessionStatus('done', 'running')).toBe('done');
    expect(resolveSubagentSessionStatus('in-progress', 'started')).toBe('in-progress');
    expect(resolveSubagentSessionStatus('error', 'started')).toBe('error');
  });
});