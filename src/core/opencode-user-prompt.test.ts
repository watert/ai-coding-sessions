import { describe, expect, it } from 'bun:test';
import { stripOpencodeUserPromptInjection } from './opencode-user-prompt';

describe('stripOpencodeUserPromptInjection', () => {
  it('移除 system-reminder 块并保留用户正文', () => {
    const raw = `| <system-reminder>Note: opened file</system-reminder>
...
在 web/src/pages/dev/OpencodeSessionsPage.tsx 过滤掉`;
    const out = stripOpencodeUserPromptInjection(raw);
    expect(out).not.toContain('system-reminder');
    expect(out).toContain('OpencodeSessionsPage.tsx');
  });

  it('移除未闭合的尾部 system-reminder', () => {
    const raw = 'hello\n<system-reminder>trailing';
    expect(stripOpencodeUserPromptInjection(raw)).toBe('hello');
  });
});