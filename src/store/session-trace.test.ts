import { describe, expect, test } from 'bun:test';
import {
  buildTraceSteps,
  shapeDetailMessages,
  summarizeTraceTools,
  summarizeTraceTurns,
  classifyToolPartSoft,
} from './session-trace';

const sampleMessages = [
  {
    info: {
      id: 'u1',
      role: 'user',
      time: { created: 1000, completed: 1000 },
    },
    parts: [{ type: 'text', text: 'please fix the bug in auth' }],
  },
  {
    info: {
      id: 'a1',
      role: 'assistant',
      model: { modelID: 'k3' },
      time: { created: 1100, completed: 2100, decodeStart: 1200 },
      tokens: { input: 10, output: 20, cacheRead: 5, total: 35 },
      tps: 12.5,
      cost: 0.01,
      parentID: 'u1',
    },
    parts: [
      { type: 'reasoning', text: 'thinking about auth flow…' },
      { type: 'text', text: 'I will read the file' },
      {
        type: 'tool',
        tool: 'Read',
        callID: 'c1',
        state: {
          status: 'completed',
          input: { path: 'auth.ts' },
          output: 'export function login() { /* long body */ }'.repeat(5),
        },
      },
      {
        type: 'tool',
        tool: 'Bash',
        callID: 'c2',
        state: { status: 'error', input: { command: 'false' }, error: 'exit 1' },
      },
      {
        type: 'tool',
        tool: 'AskUser',
        callID: 'cSoft',
        state: {
          status: 'completed',
          output: 'Interrupted by user',
          metadata: { errorSeverity: 'soft', errorKind: 'aborted_user' },
        },
      },
    ],
  },
  {
    info: {
      id: 'a2',
      role: 'assistant',
      time: { created: 2200, completed: 2500 },
      tokens: { input: 1, output: 2, total: 3 },
      parentID: 'u1',
    },
    parts: [
      { type: 'step-start' },
      {
        type: 'tool',
        tool: 'Edit',
        callID: 'c3',
        state: { status: 'completed', input: { path: 'auth.ts' }, output: 'ok' },
      },
      { type: 'step-finish' },
    ],
  },
  {
    info: {
      id: 'u2',
      role: 'user',
      time: { created: 3000, completed: 3000 },
    },
    parts: [{ type: 'text', text: 'second turn please' }],
  },
  {
    info: {
      id: 'a3',
      role: 'assistant',
      time: { created: 3100, completed: 3200 },
      parentID: 'u2',
    },
    parts: [{ type: 'text', text: 'done' }],
  },
];

describe('buildTraceSteps', () => {
  test('default skeleton has tools without io', () => {
    const steps = buildTraceSteps(sampleMessages);
    expect(steps).toHaveLength(5);
    expect(steps[0].role).toBe('user');
    expect(steps[0].text_preview).toContain('fix the bug');
    expect(steps[1].tools.map((t) => t.name)).toEqual(['Read', 'Bash', 'AskUser']);
    expect(steps[1].tools[0].input_preview).toBeUndefined();
    expect(steps[1].duration_ms).toBe(1000);
    expect(steps[1].tps).toBe(12.5);
    expect(steps[1].tokens?.cache_read).toBe(5);
  });

  test('turn grouping by user boundary / parentID', () => {
    const steps = buildTraceSteps(sampleMessages);
    expect(steps[0].turn).toBe(0);
    expect(steps[0].step_in_turn).toBe(0);
    expect(steps[0].parent_id).toBeNull();
    expect(steps[1].turn).toBe(0);
    expect(steps[1].parent_id).toBe('u1');
    expect(steps[2].turn).toBe(0);
    expect(steps[3].turn).toBe(1);
    expect(steps[4].turn).toBe(1);
    expect(steps[4].parent_id).toBe('u2');

    const turns = summarizeTraceTurns(steps);
    expect(turns).toHaveLength(2);
    expect(turns[0].user_id).toBe('u1');
    expect(turns[0].tool_count).toBe(4); // Read+Bash+AskUser+Edit
    expect(turns[0].soft_tool_count).toBe(1);
    expect(turns[1].user_id).toBe('u2');
    expect(turns[1].tool_count).toBe(0);
  });

  test('soft-fail classification on tool rows', () => {
    const steps = buildTraceSteps(sampleMessages);
    const soft = steps[1].tools.find((t) => t.name === 'AskUser');
    expect(soft?.soft).toBe(true);
    expect(soft?.soft_kind).toBe('aborted_user');
    expect(soft?.status).toBe('completed');

    const hard = steps[1].tools.find((t) => t.name === 'Bash');
    expect(hard?.soft).toBeFalsy();

    const onlySoft = buildTraceSteps(sampleMessages, { status: 'soft' });
    expect(onlySoft.some((s) => s.tools.some((t) => t.soft))).toBe(true);
    expect(onlySoft.every((s) => s.role === 'user' || s.tools.every((t) => t.soft))).toBe(true);
  });

  test('includeIo + reasoning + filters', () => {
    const steps = buildTraceSteps(sampleMessages, {
      includeIo: true,
      includeReasoning: true,
      maxOutputChars: 20,
      tool: 'Bash',
    });
    // user has no tools → filtered out; a1 has Bash; a2 has only Edit → out
    expect(steps.every((s) => s.tools.every((t) => t.name.includes('Bash') || s.role === 'user'))).toBe(true);
    const a1 = steps.find((s) => s.id === 'a1');
    expect(a1).toBeTruthy();
    expect(a1!.tools).toHaveLength(1);
    expect(a1!.tools[0].name).toBe('Bash');
    expect(a1!.tools[0].output_preview || a1!.tools[0].error_preview).toBeTruthy();
    expect(a1!.reasoning_preview).toContain('thinking');
  });

  test('from/to/maxSteps', () => {
    expect(buildTraceSteps(sampleMessages, { from: 1, to: 2 })).toHaveLength(1);
    expect(buildTraceSteps(sampleMessages, { maxSteps: 1 })).toHaveLength(1);
  });

  test('summarizeTraceTools', () => {
    const steps = buildTraceSteps(sampleMessages);
    expect(summarizeTraceTools(steps)).toEqual({
      Read: 1,
      Bash: 1,
      AskUser: 1,
      Edit: 1,
    });
  });
});

describe('classifyToolPartSoft', () => {
  test('metadata soft', () => {
    expect(classifyToolPartSoft({
      type: 'tool',
      state: { status: 'completed', metadata: { errorSeverity: 'soft', errorKind: 'file_too_large' } },
    })).toEqual({ soft: true, kind: 'file_too_large' });
  });

  test('error text soft', () => {
    expect(classifyToolPartSoft({
      type: 'tool',
      state: { status: 'error', error: 'Tool execution aborted' },
    }).soft).toBe(true);
  });
});

describe('shapeDetailMessages', () => {
  test('toolsOnly strips text/reasoning but keeps tools', () => {
    const shaped = shapeDetailMessages(sampleMessages, { toolsOnly: true });
    const a1 = shaped.find((m) => m.info.id === 'a1');
    expect(a1.parts.every((p: any) => p.type === 'tool' || p.type === 'step-start' || p.type === 'step-finish')).toBe(
      true,
    );
  });

  test('maxOutputChars truncates tool output', () => {
    const shaped = shapeDetailMessages(sampleMessages, { maxOutputChars: 15 });
    const read = shaped[1].parts.find((p: any) => p.tool === 'Read');
    expect(String(read.state.output).endsWith('…')).toBe(true);
    expect(String(read.state.output).length).toBeLessThanOrEqual(16);
  });

  test('noReasoning drops reasoning parts', () => {
    const shaped = shapeDetailMessages(sampleMessages, { noReasoning: true });
    expect(shaped[1].parts.some((p: any) => p.type === 'reasoning')).toBe(false);
  });

  test('soft status filter keeps soft tools', () => {
    const shaped = shapeDetailMessages(sampleMessages, { status: 'soft' });
    const tools = shaped.flatMap((m) => m.parts.filter((p: any) => p.type === 'tool'));
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((p: any) => p.state?.metadata?.errorSeverity === 'soft')).toBe(true);
  });
});

describe('buildTraceSteps edge cases (P0 tests)', () => {
  test('无 user 消息时 turn=0', () => {
    const steps = buildTraceSteps([
      {
        info: { id: 'a', role: 'assistant', time: { created: 1, completed: 2 } },
        parts: [{ type: 'text', text: 'orphan assistant' }],
      },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0].turn).toBe(0);
    expect(steps[0].step_in_turn).toBe(0);
  });

  test('parentID 断链仍保序归属当前 turn', () => {
    const steps = buildTraceSteps([
      {
        info: { id: 'u1', role: 'user', time: { created: 1, completed: 1 } },
        parts: [{ type: 'text', text: 'hi' }],
      },
      {
        info: { id: 'a1', role: 'assistant', parentID: 'missing-parent', time: { created: 2, completed: 3 } },
        parts: [{ type: 'text', text: 'ok' }],
      },
    ]);
    expect(steps[0].turn).toBe(0);
    expect(steps[1].turn).toBe(0);
    expect(steps[1].parent_id).toBe('missing-parent');
  });

  test('--status=hard 排除 soft，仅 hard fail', () => {
    const steps = buildTraceSteps(sampleMessages, { status: 'hard' });
    const tools = steps.flatMap((s) => s.tools);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => !t.soft)).toBe(true);
    expect(tools.every((t) => /error|fail/i.test(t.status))).toBe(true);
    expect(tools.some((t) => t.name === 'Bash')).toBe(true);
    expect(tools.some((t) => t.name === 'AskUser')).toBe(false);
  });

  test('summarizeTraceTurns t_start/t_end 跨步', () => {
    const steps = buildTraceSteps(sampleMessages);
    const turns = summarizeTraceTurns(steps);
    expect(turns[0].t_start).toBe(1000);
    // turn0: user@1000, a1 done 2100, a2 done 2500
    expect(turns[0].t_end).toBe(2500);
    expect(turns[0].duration_ms).toBe(1500);
    expect(turns[1].t_start).toBe(3000);
    expect(turns[1].t_end).toBe(3200);
  });

  test('空 messages 安全', () => {
    expect(buildTraceSteps(null)).toEqual([]);
    expect(buildTraceSteps(undefined)).toEqual([]);
    expect(summarizeTraceTurns([])).toEqual([]);
  });
});
