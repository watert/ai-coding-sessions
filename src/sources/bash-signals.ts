/**
 * Bash / Shell 工具调用嗅探（纯代码执行，非 LLM）
 * 从会话消息的 bash 类 tool part 中提取命令字符串，按正则分为
 * tests/build/git/pkg/gh/deploy/lint/destructive，得出复盘防误判信号。
 * 命令字段统一取 state.input.command（各 source 一致），排除 edit/write 等。
 */

import _ from 'lodash';

export interface BashSignals {
  bashCount: number;
  tests: number;
  build: number;
  git: number;
  pkg: number;
  /** gh issue/pr/release/workflow 等，覆盖 issue/comment/PR 信号 */
  gh: number;
  deploy: number;
  lint: number;
  destructive: number;
  /** 跑解释器/运行器（node/bun/python/deno + npm|yarn|pnpm run），代码执行信号 */
  script: number;
  /** 检索/定位（grep/rg/find/ag 等），信息收集信号 */
  search: number;
  /** 文件系统读写/变换（ls/cat/sed/awk/cp/mv 等），非交付物信号 */
  io: number;
  /** 数据库/数据查询（sqlite3/psql/mongosh/mysql 等），数据探查信号 */
  data: number;
  /** 网络请求（curl/wget 等），外部交互信号 */
  http: number;
  /** 浏览器自动化（agent-browser/chrome-devtools/playwright 等） */
  browser: number;
  categories: Array<'tests' | 'build' | 'git' | 'pkg' | 'gh' | 'deploy' | 'lint' | 'destructive' | 'script' | 'search' | 'io' | 'data' | 'http' | 'browser'>;
  /** 是否产生运维/交付类动作（git/gh/deploy/pkg/test/build/script），复盘防误判 */
  hasOpsSignal: boolean;
}

// 命令分类规则（对整条命令做不区分大小写匹配）
const RULES: Array<{
  key: 'tests' | 'build' | 'git' | 'pkg' | 'gh' | 'deploy' | 'lint' | 'destructive' | 'script' | 'search' | 'io' | 'data' | 'http' | 'browser';
  re: RegExp;
}> = [
  { key: 'tests', re: /\b(vitest|jest\b|bun test|bunx vitest|deno test|pytest|go test|cargo test|mocha|npm test|yarn test|pnpm test|tox\b|ctest)\b/ },
  { key: 'build', re: /\b(vite build|next build|nuxt build|astro build|webpack|rollup|esbuild|tsc\b|tsc -|npm run build|yarn build|pnpm build|bun run build|gatsby build|cargo build)\b/ },
  { key: 'git', re: /\bgit\s+(commit|push|pull|checkout|switch|branch|merge|rebase|clone|fetch|status|diff|log|add|reset|tag|stash|cherry-pick|remote|init|restore|mv|rm|show|blame|grep|rev-parse|rev-list|reflog|describe|shortlog|clean|fsck|worktree|archive|bundle|range-diff|difftool|submodule)\b/ },
  { key: 'pkg', re: /\b(npm install|npm i |npm ci|npm add|yarn add|yarn install|pnpm add|pnpm install|bun add|bun install|pip install|pip3 install|gem install|cargo add|apk add|apt install|brew install)\b/ },
  { key: 'gh', re: /\bgh\s+(issue|pr|repo|release|workflow|api|auth|label|milestone|gist|search|alias|attestation)\b/ },
  { key: 'deploy', re: /\b(docker|kubectl|fly\b|vercel|netlify|railway|aws\b|gcloud|terraform|helm\b|scp\b|rsync|ssh\s|doctl|heroku|argocd|oc\s)\b/ },
  { key: 'lint', re: /\b(eslint|prettier|biome|tslint|stylelint|ruff|flake8|black\b|gofmt|swiftlint|lint)\b/ },
  { key: 'destructive', re: /\b(rm -rf|rm -r |rm -fr|sudo rm|del \/|format\s|shred\s)\b/ },
  // 跑解释器/运行器（node/bun/python/deno + run 脚本）；排除 bun/npm 安装类子命令
  { key: 'script', re: /\b(node|deno|python3?|tsx|ts-node|npx)\b|\bbun(?! (install|add|ci|remove|update|link|unlink))|npm run\b|yarn run\b|pnpm run\b/ },
  // 检索/定位（grep/rg/find/ag 等）
  { key: 'search', re: /\b(grep|rg|ag\b|ack\b|ripgrep|find\b|fd\b|locate\b)\b/ },
  // 文件系统读写/变换（ls/cat/sed/awk/cp/mv 等），非交付物信号
  { key: 'io', re: /\b(ls|cat|head|tail|sed|awk|wc|sort|uniq|cut|cp|mv|mkdir|rmdir|tree|file|touch|ln|chmod|chown|du|df|pwd|echo|tee|tr|xargs|jq|nl|stat|ps|kill)\b/ },
  // 数据库/数据查询（sqlite3/psql/mongosh/mysql 等）
  { key: 'data', re: /\b(sqlite3|psql|pgsql|mysql|mongosh|mongo\b|redis-cli|cockroachdb|clickhouse-client|duckdb)\b/ },
  // 网络请求（curl/wget 等）
  { key: 'http', re: /\b(curl|wget|httpie|aria2c)\b/ },
  // 浏览器自动化（agent-browser/chrome-devtools/playwright 等）
  { key: 'browser', re: /\b(agent-browser|chrome-devtools|playwright|puppeteer|chromium|google-chrome|chrome)\b/ },
];

const NON_BASH_TOOLS = new Set(['edit', 'write', 'apply_patch', 'multi_edit', 'multi-write', 'editfile']);

/** 从 messages 或 tool parts 中提取 shell 命令字符串（容忍各 source 字段差异） */
export function extractBashCommands(messagesOrParts: any[]): string[] {
  const cmds: string[] = [];
  for (const item of messagesOrParts || []) {
    // 兼容 messages（含 .parts）与纯 parts 两种入参
    const parts = Array.isArray(item?.parts) ? item.parts : [item];
    for (const part of parts) {
      const tool = (part?.tool || '').toLowerCase();
      if (NON_BASH_TOOLS.has(tool)) continue;
      const cmd: unknown =
        _.get(part, 'state.input.command') ||
        _.get(part, 'state.input.cmd') ||
        _.get(part, 'input.command') ||
        _.get(part, 'state.command') ||
        _.get(part, 'state.input.script') ||
        '';
      if (typeof cmd === 'string' && cmd.trim()) cmds.push(cmd.trim());
    }
  }
  return cmds;
}

/** 按规则把命令列表分类为复盘信号 */
/** 零值 bash 信号，供各 source stats 字面量初始化 */
export const EMPTY_BASH_SIGNALS: BashSignals = {
  bashCount: 0, tests: 0, build: 0, git: 0, pkg: 0, gh: 0, deploy: 0, lint: 0, destructive: 0,
  script: 0, search: 0, io: 0, data: 0, http: 0, browser: 0,
  categories: [], hasOpsSignal: false,
};

/** 按规则把命令列表分类为复盘信号 */
export function classifyBashCommands(commands: string[] | undefined): BashSignals {
  const s: BashSignals = {
    bashCount: 0, tests: 0, build: 0, git: 0, pkg: 0, gh: 0, deploy: 0, lint: 0, destructive: 0,
    script: 0, search: 0, io: 0, data: 0, http: 0, browser: 0,
    categories: [], hasOpsSignal: false,
  };
  if (!commands || commands.length === 0) return s;
  const present = new Set<typeof s.categories[number]>();
  for (const raw of commands) {
    const cmd = raw.toLowerCase();
    s.bashCount++;
    for (const { key, re } of RULES) {
      if (re.test(cmd)) {
        s[key]++;
        present.add(key);
      }
    }
  }
  s.categories = (['tests', 'build', 'git', 'pkg', 'gh', 'deploy', 'lint', 'destructive', 'script', 'search', 'io', 'data', 'http', 'browser'] as const)
    .filter(c => present.has(c));
  s.hasOpsSignal = s.git > 0 || s.gh > 0 || s.deploy > 0 || s.pkg > 0 || s.tests > 0 || s.build > 0 || s.script > 0;
  return s;
}
