/**
 * Agent / AgentSwarm tool metadata 构建
 */
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  buildKimiSubagentToolMetadata,
  parseAgentSwarmResult,
  buildKimiSubagentSessionId,
  listKimiSubagentsFromMainWire,
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

describe('listKimiSubagentsFromMainWire tool.result 配对', () => {
  it('toolCallId 与 uuid 不同时, result 按 parentUuid(uuid) 仍能配到 call, outcome 不丢', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kimi-swarm-'));
    const callUuid = 'uuid-aaaa-bbbb';
    const wireRows = [
      { type: 'context.append_loop_event', time: 1000, event: {
        type: 'tool.call', uuid: callUuid, toolCallId: 'call_swarm_01', name: 'AgentSwarm',
        args: { items: ['a', 'b'], description: 'd', prompt_template: 'x {{item}}' },
      } },
      { type: 'context.append_loop_event', time: 2000, event: {
        type: 'tool.result', parentUuid: callUuid, toolCallId: 'call_swarm_01',
        result: { output: SWARM_XML },
      } },
    ];
    mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), wireRows.map(r => JSON.stringify(r)).join('\n'));
    const metas = await listKimiSubagentsFromMainWire(dir, ROOT);
    expect(metas.map(m => [m.agentDir, m.outcome])).toEqual([
      ['agent-0', 'completed'],
      ['agent-1', 'failed'],
      ['agent-2', 'completed'],
    ]);
    expect(metas.find(m => m.agentDir === 'agent-1')?.errorInfo).toContain('boom');
  });
});
