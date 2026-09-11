import { describe, expect, test, beforeEach, afterEach, afterAll } from 'bun:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { toReadonlyUri, isSqliteQuiet, initSqliteDb, closeSqliteDb, setSqliteQuiet } from './sqlite';

// 手动 mock console.error: bun:test 没有 spyOn, 装一个收集 calls 的替身
function makeStderrSpy() {
  const calls: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { calls.push(args); };
  return {
    calls: calls as readonly unknown[][],
    mockClear() { calls.length = 0; },
    mockRestore() { console.error = orig; },
  };
}

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

// issue #14 ③: closeSqliteDb quiet gate — 设 AI_CODING_SESSIONS_QUIET=1 时不污染 stderr
describe('closeSqliteDb quiet gate (issue #14 ③)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-quiet-'));
  const dbFiles: string[] = [];

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeDbPath(id: string): string {
    const p = path.join(tmpRoot, `${id}-${process.pid}-${Date.now()}.db`);
    dbFiles.push(p);
    return p;
  }

  // 恢复 env / override 防止跨 test 污染
  const originalQuiet = process.env.AI_CODING_SESSIONS_QUIET;
  afterEach(() => {
    setSqliteQuiet(undefined);
    if (originalQuiet === undefined) delete process.env.AI_CODING_SESSIONS_QUIET;
    else process.env.AI_CODING_SESSIONS_QUIET = originalQuiet;
  });

  test('isSqliteQuiet: 默认 (env 未设) → false', () => {
    delete process.env.AI_CODING_SESSIONS_QUIET;
    expect(isSqliteQuiet()).toBe(false);
  });

  test('isSqliteQuiet: env=1 → true', () => {
    process.env.AI_CODING_SESSIONS_QUIET = '1';
    expect(isSqliteQuiet()).toBe(true);
  });

  test('isSqliteQuiet: env=true → true', () => {
    process.env.AI_CODING_SESSIONS_QUIET = 'true';
    expect(isSqliteQuiet()).toBe(true);
  });

  test('isSqliteQuiet: env=0 / 其它值 → false', () => {
    process.env.AI_CODING_SESSIONS_QUIET = '0';
    expect(isSqliteQuiet()).toBe(false);
    process.env.AI_CODING_SESSIONS_QUIET = 'yes';
    expect(isSqliteQuiet()).toBe(false);
    process.env.AI_CODING_SESSIONS_QUIET = '';
    expect(isSqliteQuiet()).toBe(false);
  });

  test('isSqliteQuiet: setSqliteQuiet(true/false) 覆盖 env', () => {
    process.env.AI_CODING_SESSIONS_QUIET = '0';
    setSqliteQuiet(true);
    expect(isSqliteQuiet()).toBe(true);
    setSqliteQuiet(false);
    process.env.AI_CODING_SESSIONS_QUIET = '1';
    expect(isSqliteQuiet()).toBe(false);
    setSqliteQuiet(undefined);
    expect(isSqliteQuiet()).toBe(true);
  });

  test('默认 (env 未设): closeSqliteDb 输出 [sqlite] 数据库连接已关闭', async () => {
    delete process.env.AI_CODING_SESSIONS_QUIET;
    const spy = makeStderrSpy();
    try {
      const id = `default-${Date.now()}`;
      await initSqliteDb(id, () => makeDbPath(id));
      spy.mockClear(); // 不关心 init 日志, 只看 close
      closeSqliteDb(id);
      const messages = spy.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('数据库连接已关闭'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('QUIET=1: closeSqliteDb 不输出 [sqlite] 数据库连接已关闭', async () => {
    process.env.AI_CODING_SESSIONS_QUIET = '1';
    const spy = makeStderrSpy();
    try {
      const id = `quiet-${Date.now()}`;
      await initSqliteDb(id, () => makeDbPath(id));
      spy.mockClear();
      closeSqliteDb(id);
      const messages = spy.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('数据库连接已关闭'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('QUIET=true: closeSqliteDb 不输出 [sqlite] 数据库连接已关闭', async () => {
    process.env.AI_CODING_SESSIONS_QUIET = 'true';
    const spy = makeStderrSpy();
    try {
      const id = `quiet-true-${Date.now()}`;
      await initSqliteDb(id, () => makeDbPath(id));
      spy.mockClear();
      closeSqliteDb(id);
      const messages = spy.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('数据库连接已关闭'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('QUIET=0: closeSqliteDb 仍输出 (确认只有 1/true 算 quiet)', async () => {
    process.env.AI_CODING_SESSIONS_QUIET = '0';
    const spy = makeStderrSpy();
    try {
      const id = `quiet-zero-${Date.now()}`;
      await initSqliteDb(id, () => makeDbPath(id));
      spy.mockClear();
      closeSqliteDb(id);
      const messages = spy.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('数据库连接已关闭'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('setSqliteQuiet(true) 覆盖 env=0: 不输出关闭日志', async () => {
    process.env.AI_CODING_SESSIONS_QUIET = '0';
    setSqliteQuiet(true);
    const spy = makeStderrSpy();
    try {
      const id = `override-true-${Date.now()}`;
      await initSqliteDb(id, () => makeDbPath(id));
      spy.mockClear();
      closeSqliteDb(id);
      const messages = spy.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('数据库连接已关闭'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('setSqliteQuiet(false) 覆盖 env=1: 仍输出关闭日志', async () => {
    process.env.AI_CODING_SESSIONS_QUIET = '1';
    setSqliteQuiet(false);
    const spy = makeStderrSpy();
    try {
      const id = `override-false-${Date.now()}`;
      await initSqliteDb(id, () => makeDbPath(id));
      spy.mockClear();
      closeSqliteDb(id);
      const messages = spy.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('数据库连接已关闭'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('QUIET=1 时: initSqliteDb 的运行时日志也被抑制 (pipe 模式纯静默)', async () => {
    process.env.AI_CODING_SESSIONS_QUIET = '1';
    const spy = makeStderrSpy();
    try {
      const id = `init-quiet-${Date.now()}`;
      await initSqliteDb(id, () => makeDbPath(id));
      const messages = spy.calls.map((c) => String(c[0]));
      // 不应出现 [sqlite:...] 运行时
      expect(messages.some((m) => m.includes('运行时'))).toBe(false);
      closeSqliteDb(id);
    } finally {
      spy.mockRestore();
    }
  });
});
