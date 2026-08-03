/**
 * bash-signals 纯函数单测
 * 覆盖 classifyBashCommands（命令分类）与 extractBashCommands（命令提取，兼容 messages/parts）
 */
import { describe, it, expect } from 'bun:test';
import { extractBashCommands, classifyBashCommands, EMPTY_BASH_SIGNALS } from './bash-signals';

// 构造 tool part / message 夹具
const mkPart = (tool: string, command?: string, extra?: Record<string, unknown>) => ({
  tool,
  state: { input: command ? { command, ...extra } : {}, status: 'completed' },
});
const mkMsg = (parts: any[]) => ({ parts });

describe('classifyBashCommands', () => {
  it('空输入返回零值信号', () => {
    const s = classifyBashCommands(undefined);
    expect(s).toEqual(EMPTY_BASH_SIGNALS);
    expect(s.bashCount).toBe(0);
    expect(s.categories).toEqual([]);
    expect(s.hasOpsSignal).toBe(false);
  });

  it('按正则分 tests/build/git/pkg/gh/deploy/lint', () => {
    const s = classifyBashCommands([
      'vitest run',
      'bun test',
      'pytest -q',
      'go test ./...',
      'tsc --noEmit',
      'vite build',
      'npm run build',
      'git commit -m "x"',
      'git push',
      'npm install',
      'bun add lodash',
      'pip install requests',
      'gh pr create',
      'gh issue list',
      'docker build -t x .',
      'kubectl apply -f y.yaml',
      'eslint . --fix',
      'prettier --write .',
    ]);
    expect(s.bashCount).toBe(18);
    expect(s.tests).toBe(4);
    expect(s.build).toBe(3);
    expect(s.git).toBe(2);
    expect(s.pkg).toBe(3);
    expect(s.gh).toBe(2);
    expect(s.deploy).toBe(2);
    expect(s.lint).toBe(2);
  });

  it('destructive 单独计数但不计入 hasOpsSignal', () => {
    const s = classifyBashCommands(['rm -rf node_modules', 'sudo rm /tmp/x']);
    expect(s.destructive).toBe(2);
    expect(s.hasOpsSignal).toBe(false);
    expect(s.categories).toEqual(['destructive']);
  });

  it('lint 不计入 hasOpsSignal', () => {
    const s = classifyBashCommands(['eslint .']);
    expect(s.lint).toBe(1);
    expect(s.hasOpsSignal).toBe(false);
  });

  it('git/build/test/pkg/deploy 任一出现即 hasOpsSignal=true', () => {
    expect(classifyBashCommands(['git status']).hasOpsSignal).toBe(true);
    expect(classifyBashCommands(['npm run build']).hasOpsSignal).toBe(true);
    expect(classifyBashCommands(['bun test']).hasOpsSignal).toBe(true);
    expect(classifyBashCommands(['pnpm add zod']).hasOpsSignal).toBe(true);
    expect(classifyBashCommands(['vercel deploy']).hasOpsSignal).toBe(true);
  });

  it('categories 去重且按固定顺序', () => {
    const s = classifyBashCommands(['git push', 'git commit', 'npm install', 'git push']);
    expect(s.git).toBe(3);
    expect(s.categories).toEqual(['git', 'pkg']);
  });

  it('cargo build 归类为 build 而非 pkg', () => {
    const s = classifyBashCommands(['cargo build --release']);
    expect(s.build).toBe(1);
    expect(s.pkg).toBe(0);
    expect(s.categories).toEqual(['build']);
  });

  it('cargo add 归类为 pkg', () => {
    expect(classifyBashCommands(['cargo add serde']).pkg).toBe(1);
  });

  it('script: 解释器/运行器执行', () => {
    const s = classifyBashCommands([
      'node dist/cli.js',
      'node -e "console.log(1)"',
      'bun run dev',
      'bun x tsx a.ts',
      'python3 script.py',
      'python3 << "EOF"',
      'deno run -A a.ts',
      'tsx watch src/index.ts',
      'npm run lint',
      'yarn run typecheck',
    ]);
    expect(s.script).toBe(10);
    expect(s.categories).toContain('script');
    expect(s.hasOpsSignal).toBe(true);
  });

  it('script 排除 bun/npm 安装类子命令', () => {
    const s = classifyBashCommands(['bun install', 'bun add zod', 'npm install', 'pnpm add x']);
    expect(s.script).toBe(0);
    expect(s.pkg).toBe(4);
    expect(s.categories).not.toContain('script');
  });

  it('search: grep/rg/find 检索', () => {
    const s = classifyBashCommands(['grep -r foo src', 'rg "bar" --stats', 'find . -name "*.ts"', 'ag todo']);
    expect(s.search).toBe(4);
    expect(s.categories).toContain('search');
    expect(s.hasOpsSignal).toBe(false);
  });

  it('io: 文件系统读写/变换（非交付物）', () => {
    const s = classifyBashCommands([
      'ls -la',
      'cat a.txt',
      'sed -i "s/x/y/" f',
      'awk "{print $1}" f',
      'mv old new',
      'cp a b',
      'head -n 5 f',
    ]);
    expect(s.io).toBe(7);
    expect(s.categories).toContain('io');
    expect(s.hasOpsSignal).toBe(false);
  });

  it('git 规则扩展到 show/blame/grep/rev-parse', () => {
    const s = classifyBashCommands([
      'git show HEAD',
      'git blame src/a.ts',
      'git grep "FIXME"',
      'git rev-parse --short HEAD',
      'git describe --tags',
    ]);
    expect(s.git).toBe(5);
    expect(s.categories).toContain('git');
  });

  it('git grep 同时命中 git 与 search（多类别共存）', () => {
    const s = classifyBashCommands(['git grep "FIXME"']);
    expect(s.git).toBe(1);
    expect(s.search).toBe(1);
    expect(s.categories).toEqual(['git', 'search']);
  });

  it('bun run build 同时命中 build 与 script', () => {
    const s = classifyBashCommands(['bun run build']);
    expect(s.build).toBe(1);
    expect(s.script).toBe(1);
    expect(s.categories).toEqual(['build', 'script']);
  });

  it('data: 数据库/数据查询', () => {
    const s = classifyBashCommands([
      'sqlite3 ~/.local/share/opencode/opencode.db "select 1"',
      'psql -c "select now()"',
      'mongosh --eval "db.x.find()"',
      'mysql -e "show tables"',
    ]);
    expect(s.data).toBe(4);
    expect(s.categories).toContain('data');
    expect(s.hasOpsSignal).toBe(false);
  });

  it('http: curl/wget 网络请求', () => {
    const s = classifyBashCommands(['curl -sL https://x.com/a', 'wget https://x.com/b']);
    expect(s.http).toBe(2);
    expect(s.categories).toContain('http');
    expect(s.hasOpsSignal).toBe(false);
  });

  it('browser: agent-browser/chrome-devtools 自动化', () => {
    const s = classifyBashCommands(['agent-browser open https://x.com', 'chrome-devtools navigate_page']);
    expect(s.browser).toBe(2);
    expect(s.categories).toContain('browser');
    expect(s.hasOpsSignal).toBe(false);
  });

  it('lint 规则扩展到 yarn/npm/pnpm/bun run lint', () => {
    const s = classifyBashCommands(['yarn lint', 'npm run lint', 'pnpm lint', 'bun run lint']);
    expect(s.lint).toBe(4);
    expect(s.categories).toContain('lint');
  });

  it('io 规则扩展到 stat/ps/kill 等系统工具', () => {
    const s = classifyBashCommands(['stat f', 'ps aux', 'kill 1234']);
    expect(s.io).toBe(3);
    expect(s.categories).toContain('io');
  });
});

describe('extractBashCommands', () => {
  it('从 raw parts 提取 command，跳过 edit/write', () => {
    const parts = [
      mkPart('edit', 'some file'),
      mkPart('write', 'content'),
      mkPart('bash', 'ls -la'),
      mkPart('Bash', 'git status'),
    ];
    expect(extractBashCommands(parts)).toEqual(['ls -la', 'git status']);
  });

  it('兼容 messages（展平 .parts）', () => {
    const messages = [
      mkMsg([mkPart('edit', 'x'), mkPart('bash', 'echo hi')]),
      mkMsg([mkPart('Bash', 'cat a.txt')]),
    ];
    expect(extractBashCommands(messages)).toEqual(['echo hi', 'cat a.txt']);
  });

  it('从多种字段位置读取命令', () => {
    const parts = [
      { tool: 'bash', state: { input: { cmd: 'alt-cmd' } } },
      { tool: 'bash', state: { input: { script: 'scr-cmd' } } },
      { tool: 'bash', input: { command: 'top-command' } },
    ];
    expect(extractBashCommands(parts)).toEqual(['alt-cmd', 'scr-cmd', 'top-command']);
  });

  it('state 为字符串时不崩溃，返回空', () => {
    const parts = [{ tool: 'bash', state: 'pending' }];
    expect(extractBashCommands(parts)).toEqual([]);
  });

  it('空/未定义输入返回空数组', () => {
    expect(extractBashCommands([])).toEqual([]);
    expect(extractBashCommands(undefined as any)).toEqual([]);
  });

  it('忽略空命令与纯空白', () => {
    const parts = [mkPart('bash', '   '), mkPart('bash', ''), mkPart('bash', 'real cmd')];
    expect(extractBashCommands(parts)).toEqual(['real cmd']);
  });
});
