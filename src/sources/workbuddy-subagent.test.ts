/**
 * WorkBuddy Agent tool → subagent 虚拟 session
 */
import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import {
  buildWorkbuddySubagentSessionId,
  parseWorkbuddyVirtualSessionId,
  parseWorkbuddyAgentIdFromResult,
  listWorkbuddySubagentsFromMainJsonl,
  initWorkbuddyDb,
  closeWorkbuddyDb,
  listWorkbuddySessions,
  type WorkbuddySessionItem,
} from './workbuddy-code';
import {
  convertWorkbuddySession,
  convertWorkbuddySubagentSession,
  getWorkbuddySessionDetail,
  convertWorkbuddyEventsToMessages,
} from './workbuddy-source';
import { createWorkbuddyFixture } from './__fixtures__/sources';

const ROOT = 'wb-root-sess-001';
const AGENT = 'agent-aabbcc11';

async function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('WorkBuddy subagent id helpers', () => {
  test('build / parse virtual session id', () => {
    const id = buildWorkbuddySubagentSessionId(ROOT, AGENT);
    expect(id).toBe(`${ROOT}__${AGENT}`);
    expect(parseWorkbuddyVirtualSessionId(id)).toEqual({
      rootSessionId: ROOT,
      agentId: AGENT,
    });
    expect(parseWorkbuddyVirtualSessionId(ROOT)).toEqual({ rootSessionId: ROOT });
  });

  test('parse agent id from tool result text / providerData', () => {
    expect(parseWorkbuddyAgentIdFromResult({
      output: { type: 'text', text: 'done\n\n[Agent ID: agent-200abb04]' },
    })).toBe('agent-200abb04');

    expect(parseWorkbuddyAgentIdFromResult({
      output: 'x',
      providerData: {
        toolResult: {
          content: 'ok',
          subAgent: { sessionId: 'agent-bbad3a35', lastId: 'x' },
        },
      } as any,
    })).toBe('agent-bbad3a35');
  });
});

describe('WorkBuddy subagent list + convert', () => {
  test('expands Agent tools into child sessions with parent_id + tokens', async () => {
    const fx = createWorkbuddyFixture();
    const parentId = fx.sessionId;
    const agentId = 'agent-fixture01';
    const messageId = 'msg-asst-1';
    const callId = 'call-agent-1';
    const T0 = 1_700_000_000_000;

    // parent jsonl：user + Agent call/result（覆盖 fixture 简陋内容）
    const parentEvents = [
      {
        type: 'message',
        role: 'user',
        id: 'u1',
        timestamp: T0,
        content: [{ type: 'input_text', text: '<user_query>research please</user_query>' }],
        providerData: { agent: 'cli' },
      },
      {
        type: 'function_call',
        name: 'Agent',
        callId,
        id: 'fc1',
        parentId: 'u1',
        timestamp: T0 + 1000,
        arguments: JSON.stringify({
          description: '调研模块 A',
          subagent_type: 'general-purpose',
          prompt: 'do research A',
        }),
        providerData: { messageId, model: 'hy3', agent: 'cli' },
      },
      {
        type: 'function_call_result',
        name: 'Agent',
        callId,
        id: 'fr1',
        parentId: 'fc1',
        timestamp: T0 + 5000,
        status: 'completed',
        output: { type: 'text', text: `done\n\n[Agent ID: ${agentId}]` },
        providerData: {
          messageId,
          model: 'hy3',
          agent: 'cli',
          toolResult: {
            content: `done\n\n[Agent ID: ${agentId}]`,
            subAgent: { sessionId: agentId, lastId: 'last1' },
          },
        },
      },
    ];
    fs.writeFileSync(fx.jsonlPath, parentEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');

    // subagent jsonl
    const subJsonl = path.join(
      path.dirname(fx.jsonlPath),
      parentId,
      'subagents',
      `${agentId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(subJsonl), { recursive: true });
    const subEvents = [
      {
        type: 'message',
        role: 'user',
        id: 'su1',
        timestamp: T0 + 1100,
        content: [{ type: 'input_text', text: 'do research A' }],
        providerData: { agent: 'cli' },
      },
      {
        type: 'message',
        role: 'assistant',
        id: 'sa1',
        timestamp: T0 + 2000,
        content: [{ type: 'output_text', text: 'report body' }],
        providerData: {
          messageId: 'sub-msg-1',
          model: 'hy3',
          agent: 'cli',
          rawUsage: {
            prompt_tokens: 1000,
            completion_tokens: 200,
            total_tokens: 1200,
            credit: 1.5,
          },
        },
      },
    ];
    fs.writeFileSync(subJsonl, subEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');

    await withEnv({ WORKBUDDY_HOME: fx.root }, async () => {
      closeWorkbuddyDb();
      expect(await initWorkbuddyDb()).toBe(true);
      const list = await listWorkbuddySessions();
      const sess = list.find((s) => s.sessionId === parentId)!;
      expect(sess).toBeTruthy();

      const metas = listWorkbuddySubagentsFromMainJsonl(sess as WorkbuddySessionItem);
      expect(metas).toHaveLength(1);
      expect(metas[0].agentId).toBe(agentId);
      expect(metas[0].parentSessionId).toBe(parentId);
      expect(metas[0].description).toBe('调研模块 A');
      expect(metas[0].virtualSessionId).toBe(buildWorkbuddySubagentSessionId(parentId, agentId));

      const parentInfo = await convertWorkbuddySession(sess);
      expect(parentInfo.parent_id == null || parentInfo.parent_id === '').toBe(true);

      const childInfo = await convertWorkbuddySubagentSession(sess, metas[0]);
      expect(childInfo.parent_id).toBe(parentId);
      expect(childInfo.spawn_group_id).toBe(messageId);
      expect(childInfo.id).toBe(metas[0].virtualSessionId);
      expect(childInfo.title).toContain('调研模块 A');
      expect(childInfo.total_tokens).toBeGreaterThan(0);
      expect(childInfo.total_user_messages).toBeGreaterThanOrEqual(1);

      // detail by virtual id
      const detail = await getWorkbuddySessionDetail(metas[0].virtualSessionId);
      expect(detail).toBeTruthy();
      expect(detail!.info.parent_id).toBe(parentId);
      expect(detail!.messages.length).toBeGreaterThanOrEqual(1);

      // parent tool part carries metadata.sessionId
      const parentMsgs = convertWorkbuddyEventsToMessages(parentId, parentEvents as any, '/tmp', 'hy3');
      const agentPart = parentMsgs
        .flatMap((m) => m.parts || [])
        .find((p: any) => p.type === 'tool' && String(p.tool).toLowerCase() === 'agent') as any;
      expect(agentPart?.state?.metadata?.sessionId).toBe(metas[0].virtualSessionId);
    });
  });
});
