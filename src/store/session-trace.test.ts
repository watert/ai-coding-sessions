import { describe, expect, test } from 'bun:test';
import {
  buildTraceSteps,
  shapeDetailMessages,
  summarizeTraceTools,
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
    ],
  },
  {
    info: {
      id: 'a2',
      role: 'assistant',
      time: { created: 2200, completed: 2500 },
      tokens: { input: 1, output: 2, total: 3 },
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
];

describe('buildTraceSteps', () => {
  test('default skeleton has tools without io', () => {
    const steps = buildTraceSteps(sampleMessages);
    expect(steps).toHaveLength(3);
    expect(steps[0].role).toBe('user');
    expect(steps[0].text_preview).toContain('fix the bug');
    expect(steps[1].tools.map((t) => t.name)).toEqual(['Read', 'Bash']);
    expect(steps[1].tools[0].input_preview).toBeUndefined();
    expect(steps[1].duration_ms).toBe(1000);
    expect(steps[1].tps).toBe(12.5);
    expect(steps[1].tokens?.cache_read).toBe(5);
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
    expect(summarizeTraceTools(steps)).toEqual({ Read: 1, Bash: 1, Edit: 1 });
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
});
