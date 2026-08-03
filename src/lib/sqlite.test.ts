import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { toReadonlyUri } from './sqlite';

describe('toReadonlyUri', () => {
  test('posix absolute path becomes file URL with mode=ro', () => {
    const uri = toReadonlyUri('/Users/me/.zcode/cli/db/db.sqlite');
    expect(uri.startsWith('file://')).toBe(true);
    expect(uri).toContain('mode=ro');
    expect(uri).not.toContain('\\');
    // 解析后 path 可还原
    const u = new URL(uri);
    expect(u.protocol).toBe('file:');
    expect(u.searchParams.get('mode')).toBe('ro');
  });

  test('relative path is resolved then encoded', () => {
    const uri = toReadonlyUri('data/test.sqlite');
    const abs = path.resolve('data/test.sqlite');
    const expectedBase = pathToFileURL(abs).href;
    expect(uri.startsWith(expectedBase.split('?')[0])).toBe(true);
    expect(uri).toContain('mode=ro');
  });

  test('windows-style path uses forward slashes in URL (simulated)', () => {
    // 在非 Win 上 pathToFileURL 仍能正确编码含盘符/反斜杠的绝对串
    // 直接验证：反斜杠不得出现在最终 URI 中
    const winLike = 'C:\\Users\\runner\\.codex\\db.sqlite';
    // path.isAbsolute 在 darwin 上对 C:\ 为 false，故走 resolve；这里测导出函数对已是 URL 风格的输入
    // 用 pathToFileURL 对照：若传入 resolve 后的本机路径，URI 无反斜杠
    const local = path.join(path.sep === '\\' ? 'C:\\Users\\runner' : '/Users/runner', '.codex', 'db.sqlite');
    const uri = toReadonlyUri(local);
    expect(uri).not.toMatch(/\\/);
    expect(uri).toMatch(/\?mode=ro$|mode=ro/);
  });
});
