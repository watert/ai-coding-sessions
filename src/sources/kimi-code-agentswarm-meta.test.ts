/**
 * Agent / AgentSwarm tool metadata 构建
 */
import { describe, it, expect } from 'bun:test';
import {
  buildKimiSubagentToolMetadata,
  parseAgentSwarmResult,
  buildKimiSubagentSessionId,
} from './kimi-code';

const ROOT = 'session_test-root';

const SWARM_XML = `<agent_swarm_result>
<summary>completed: 2, failed: 1</summary>
<subagent agent_id="agent-0" item="felina" outcome="completed">done ok</subagent>
<subagent agent_id="agent-1" item="sue" outcome="failed">boom error</subagent>
<subagent agent_id="agent-2" item="vigee" outcome="completed">ok</subagent>
</agent_swarm_result>`;

describe('buildKimiSubagentToolMetadata', () => {
  it('parseAgentSwarmResult 提取 outcome/item', () => {
    const map = parseAgentSwarmResult(SWARM_XML);
    expect(Object.keys(map)).toEqual(['agent-0', 'agent-1', 'agent-2']);
    expect(map['agent-0'].item).toBe('felina');
    expect(map['agent-1'].outcome).toBe('failed');
    expect(map['agent-1'].errorInfo).toContain('boom');
  });

  it('AgentSwarm completed: 按 result 展开 agents + virtualSessionId', () => {
    const meta = buildKimiSubagentToolMetadata({
      rootSessionId: ROOT,
      toolName: 'AgentSwarm',
      args: {
        description: 'Parallel gen',
        subagent_type: 'coder',
        items: ['felina', 'sue', 'vigee'],
        prompt_template: 'do {{item}}',
      },
      result: { output: SWARM_XML },
    });
    expect(meta?.kind).toBe('agentswarm');
    expect(meta?.agents.length).toBe(3);
    expect(meta?.agents[0]).toMatchObject({
      agentDir: 'agent-0',
      item: 'felina',
      outcome: 'completed',
      virtualSessionId: buildKimiSubagentSessionId(ROOT, 'agent-0'),
    });
    expect(meta?.agents[1].outcome).toBe('failed');
    expect(meta?.summary).toMatchObject({ completed: 2, failed: 1, total: 3 });
  });

  it('AgentSwarm pending: 按 items 占位 started', () => {
    const meta = buildKimiSubagentToolMetadata({
      rootSessionId: ROOT,
      toolName: 'AgentSwarm',
      args: { items: ['a', 'b'], description: 'x' },
    });
    expect(meta?.agents.length).toBe(2);
    expect(meta?.agents.every(a => a.outcome === 'started')).toBe(true);
    expect(meta?.agents[0].virtualSessionId).toBeUndefined();
  });

  it('AgentSwarm rejected: items 标 failed', () => {
    const meta = buildKimiSubagentToolMetadata({
      rootSessionId: ROOT,
      toolName: 'AgentSwarm',
      args: { items: ['only-one'], description: 'x' },
      result: { output: 'AgentSwarm requires at least 2 items unless resume_agent_ids is provided.', isError: true },
    });
    expect(meta?.agents.length).toBe(1);
    expect(meta?.agents[0].outcome).toBe('failed');
  });

  it('单 Agent: sessionId + agentDir', () => {
    const meta = buildKimiSubagentToolMetadata({
      rootSessionId: ROOT,
      toolName: 'Agent',
      args: { description: 'explore auth', subagent_type: 'explore' },
      result: { output: 'agent_id: agent-3\nstatus: completed\n...' },
    });
    expect(meta?.kind).toBe('agent');
    expect(meta?.sessionId).toBe(buildKimiSubagentSessionId(ROOT, 'agent-3'));
    expect(meta?.agents[0]?.agentDir).toBe('agent-3');
  });

  it('非 subagent tool 返回 undefined', () => {
    expect(buildKimiSubagentToolMetadata({
      rootSessionId: ROOT,
      toolName: 'Bash',
      args: { command: 'ls' },
    })).toBeUndefined();
  });
});
