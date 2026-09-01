/**
 * 本地 coding agent 落盘探测: 目录清单 + 规模 (文件数 / 字节 / 最新 mtime)
 * 路径来自 ACS 已实现 source + 其它 agent 落盘对照, 不解析内容
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveHomeDir } from '../../../src/lib/home-paths.ts';

export type ProbeKind = 'acs' | 'other';
export type ProbeFormat = 'jsonl' | 'sqlite' | 'json' | 'csv' | 'log' | 'mixed';

export type ProbeCtx = {
  home: string;
  env: NodeJS.ProcessEnv;
  xdgData: string;
  xdgConfig: string;
  appData: string;
};

export type AgentProbe = {
  id: string;
  display: string;
  kind: ProbeKind;
  format: ProbeFormat;
  /** bun glob, 相对 root; 空 = root 本身是文件 */
  glob: string;
  env?: string[];
  roots: (ctx: ProbeCtx) => string[];
};

export type RootHit = {
  path: string;
  exists: boolean;
  isFile: boolean;
  files: number;
  bytes: number;
  newestMs: number | null;
  truncated: boolean;
};

export type AgentHit = {
  id: string;
  display: string;
  kind: ProbeKind;
  format: ProbeFormat;
  status: 'missing' | 'empty' | 'present';
  files: number;
  bytes: number;
  newestMs: number | null;
  roots: RootHit[];
};

const FILE_CAP = 80_000;
const SKIP_DIR = new Set(['node_modules', '.git']);

export function makeProbeCtx(env: NodeJS.ProcessEnv = process.env): ProbeCtx {
  const home = resolveHomeDir(env);
  const xdgData = env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share');
  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');
  const appData =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : process.platform === 'win32'
        ? env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming')
        : xdgConfig;
  return { home, env, xdgData, xdgConfig, appData };
}

function envDir(ctx: ProbeCtx, name: string, fallbackRel: string): string {
  const v = ctx.env[name]?.trim();
  return v || path.join(ctx.home, ...fallbackRel.split('/'));
}

function vscodeTasks(ctx: ProbeCtx, ext: string): string[] {
  const tail = path.join('User', 'globalStorage', ext, 'tasks');
  return [
    path.join(ctx.xdgConfig, 'Code', ...tail.split(path.sep)),
    path.join(ctx.appData, 'Code', ...tail.split(path.sep)),
    path.join(ctx.home, '.vscode-server', 'data', ...tail.split(path.sep)),
  ];
}

function p(
  id: string,
  display: string,
  kind: ProbeKind,
  format: ProbeFormat,
  glob: string,
  roots: AgentProbe['roots'],
  env?: string[],
): AgentProbe {
  return { id, display, kind, format, glob, roots, env };
}

/** ACS 8 source + 未实现 extras. 权威路径以本表为准 */
export const AGENT_PROBES: AgentProbe[] = [
  p('opencode', 'OpenCode', 'acs', 'sqlite', '**/*.{db,json}', (c) => [
    path.join(c.xdgData, 'opencode'),
  ]),
  p('claude', 'Claude Code', 'acs', 'jsonl', '**/*.{jsonl,json}', (c) => {
    const base = envDir(c, 'CLAUDE_CONFIG_DIR', '.claude');
    return [path.join(base, 'projects'), path.join(base, 'transcripts')];
  }, ['CLAUDE_CONFIG_DIR']),
  p('kimi', 'Kimi Code / CLI', 'acs', 'jsonl', '**/wire.jsonl', (c) => {
    const data = envDir(c, 'KIMI_DATA_DIR', '.kimi-code');
    const code = envDir(c, 'KIMI_CODE_HOME', '.kimi-code');
    return [
      path.join(data, 'sessions'),
      path.join(c.home, '.kimi', 'sessions'),
      path.join(code, 'sessions'),
      path.join(c.appData, 'kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/sessions'),
    ];
  }, ['KIMI_DATA_DIR', 'KIMI_CODE_HOME']),
  p('grok', 'Grok Build', 'acs', 'jsonl', '**/*.{jsonl,json}', (c) => {
    const root = envDir(c, 'GROK_HOME', '.grok');
    const sess = c.env.GROK_SESSIONS_DIR?.trim();
    return [sess || path.join(root, 'sessions'), path.join(root, 'logs')];
  }, ['GROK_HOME', 'GROK_SESSIONS_DIR']),
  p('codex', 'Codex CLI', 'acs', 'mixed', '**/*.{jsonl,zst,sqlite}', (c) => [
    envDir(c, 'CODEX_HOME', '.codex'),
  ], ['CODEX_HOME']),
  p('zcode', 'ZCode', 'acs', 'mixed', '**/*.{sqlite,jsonl,db}', (c) => {
    const db = envDir(c, 'ZCODE_DB_PATH', '.zcode/cli/db/db.sqlite');
    const home = envDir(c, 'ZCODE_HOME', '.zcode');
    return [db, path.join(home, 'cli/db/db.sqlite'), path.join(home, 'projects')];
  }, ['ZCODE_HOME', 'ZCODE_DB_PATH']),
  p('workbuddy', 'WorkBuddy', 'acs', 'mixed', '**/*.{db,jsonl,log}', (c) => [
    envDir(c, 'WORKBUDDY_HOME', '.workbuddy'),
  ], ['WORKBUDDY_HOME']),
  p('cursor', 'Cursor Desktop (local)', 'acs', 'mixed', '**/*.{vscdb,jsonl,db}', (c) => {
    const app = c.env.CURSOR_APP_DATA?.trim() || path.join(c.appData, 'Cursor');
    return [
      envDir(c, 'CURSOR_HOME', '.cursor'),
      c.env.CURSOR_STATE_DB?.trim() || path.join(app, 'User/globalStorage/state.vscdb'),
    ];
  }, ['CURSOR_HOME', 'CURSOR_APP_DATA', 'CURSOR_STATE_DB']),

  p('cursor-api', 'Cursor usage CSV cache', 'other', 'csv', 'usage*.csv', (c) => [
    path.join(c.xdgConfig, 'tokscale/cursor-cache'),
  ]),
  p('gemini', 'Gemini CLI', 'other', 'jsonl', '**/*.{json,jsonl}', (c) => [
    path.join(envDir(c, 'GEMINI_CLI_HOME', '.gemini'), 'tmp'),
  ], ['GEMINI_CLI_HOME']),
  p('amp', 'Amp', 'other', 'json', '**/T-*.json', (c) => [path.join(c.xdgData, 'amp/threads')]),
  p('droid', 'Factory Droid', 'other', 'json', '**/*.settings.json', (c) => [
    path.join(c.home, '.factory/sessions'),
  ]),
  p('openclaw', 'OpenClaw', 'other', 'jsonl', '**/*.jsonl*', (c) =>
    ['.openclaw', '.clawdbot', '.moltbot', '.moldbot'].map((n) => path.join(c.home, n, 'agents')),
  ),
  p('pi', 'Pi', 'other', 'jsonl', '**/*.jsonl', (c) => [path.join(c.home, '.pi/agent/sessions')]),
  p('omp', 'Oh My Pi', 'other', 'jsonl', '**/*.jsonl', (c) => [
    path.join(c.home, '.omp/agent/sessions'),
  ]),
  p('senpi', 'Senpi', 'other', 'jsonl', '**/*.jsonl', (c) => [
    path.join(envDir(c, 'SENPI_CODING_AGENT_DIR', '.senpi/agent'), 'sessions'),
  ], ['SENPI_CODING_AGENT_DIR']),
  p('kimchi', 'Kimchi Coding', 'other', 'jsonl', '**/*.jsonl', (c) => [
    path.join(envDir(c, 'KIMCHI_CODING_AGENT_DIR', '.config/kimchi/harness'), 'sessions'),
  ], ['KIMCHI_CODING_AGENT_DIR']),
  p('gjc', 'Gajae-Code', 'other', 'jsonl', '**/*.jsonl', (c) => [
    path.join(envDir(c, 'GJC_CODING_AGENT_DIR', '.gjc/agent'), 'sessions'),
    path.join(c.xdgData, 'gjc/sessions'),
  ], ['GJC_CODING_AGENT_DIR', 'GJC_CONFIG_DIR', 'PI_CONFIG_DIR']),
  p('prime-agent', 'Prime Agent', 'other', 'jsonl', '**/*.jsonl', (c) => {
    const a = envDir(c, 'PRIME_AGENT_CODING_AGENT_DIR', '.prime/agent');
    return [path.join(a, 'sessions'), path.join(a, 'session-artifacts')];
  }, ['PRIME_AGENT_CODING_AGENT_DIR']),
  p('qwen', 'Qwen CLI', 'other', 'jsonl', '**/*.jsonl', (c) => [path.join(c.home, '.qwen/projects')]),
  p('roocode', 'Roo Code', 'other', 'json', '**/ui_messages.json', (c) =>
    vscodeTasks(c, 'rooveterinaryinc.roo-cline'),
  ),
  p('kilocode', 'Kilo Code (VS Code)', 'other', 'json', '**/ui_messages.json', (c) =>
    vscodeTasks(c, 'kilocode.kilo-code'),
  ),
  p('kilo', 'Kilo CLI', 'other', 'sqlite', '', (c) => [path.join(c.xdgData, 'kilo/kilo.db')]),
  p('mux', 'Mux', 'other', 'json', '**/session-usage.json', (c) => [
    path.join(c.home, '.mux/sessions'),
  ]),
  p('crush', 'Crush', 'other', 'json', 'projects.json', (c) => [
    path.join(c.xdgData, 'crush/projects.json'),
    path.join(c.appData, 'crush/projects.json'),
  ]),
  p('hermes', 'Hermes Agent', 'other', 'sqlite', '**/state.db', (c) => [
    envDir(c, 'HERMES_HOME', '.hermes'),
  ], ['HERMES_HOME']),
  p('copilot', 'Copilot CLI', 'other', 'jsonl', '**/*.jsonl', (c) => {
    const extra = c.env.COPILOT_OTEL_FILE_EXPORTER_PATH?.trim();
    return [path.join(c.home, '.copilot/otel'), extra].filter(Boolean) as string[];
  }, ['COPILOT_OTEL_FILE_EXPORTER_PATH']),
  p('goose', 'Goose', 'other', 'sqlite', '', (c) => {
    const custom = c.env.GOOSE_PATH_ROOT?.trim();
    return [
      custom ? path.join(custom, 'data/sessions/sessions.db') : '',
      path.join(c.xdgData, 'goose/sessions/sessions.db'),
      path.join(c.appData, 'goose/sessions/sessions.db'),
      path.join(c.appData, 'Block/goose/sessions/sessions.db'),
      path.join(c.xdgData, 'Block/goose/sessions/sessions.db'),
    ].filter(Boolean);
  }, ['GOOSE_PATH_ROOT']),
  p('codebuff', 'Codebuff / Freebuff', 'other', 'json', '**/chat-messages.json', (c) => {
    const o = c.env.CODEBUFF_DATA_DIR?.trim() || c.env.FREEBUFF_DATA_DIR?.trim();
    if (o) return [path.join(o, 'projects')];
    return ['manicode', 'manicode-dev', 'manicode-staging'].map((n) =>
      path.join(c.xdgConfig, n, 'projects'),
    );
  }, ['CODEBUFF_DATA_DIR', 'FREEBUFF_DATA_DIR']),
  p('antigravity', 'Antigravity IDE cache', 'other', 'jsonl', '**/*.jsonl', (c) => [
    path.join(c.xdgConfig, 'tokscale/antigravity-cache/sessions'),
  ]),
  p('antigravity-cli', 'Antigravity CLI', 'other', 'sqlite', '**/*.db', (c) => [
    path.join(envDir(c, 'GEMINI_CLI_HOME', '.gemini'), 'antigravity-cli/conversations'),
  ], ['GEMINI_CLI_HOME']),
  p('zed', 'Zed Agent', 'other', 'sqlite', '', (c) => [
    path.join(c.xdgData, 'zed/threads/threads.db'),
    path.join(c.appData, 'Zed/threads/threads.db'),
  ]),
  p('kiro', 'Kiro', 'other', 'mixed', '**/*.{json,jsonl,sqlite3}', (c) => [
    path.join(c.home, '.kiro/sessions'),
    path.join(c.xdgData, 'kiro-cli/data.sqlite3'),
    path.join(c.appData, 'kiro-cli/data.sqlite3'),
    path.join(c.appData, 'Kiro/User/globalStorage/kiro.kiroagent'),
  ]),
  p('trae', 'Trae usage API cache', 'other', 'json', '**/*.json', (c) => [
    path.join(c.xdgConfig, 'tokscale/trae-cache/sessions'),
  ]),
  p('warp', 'Warp usage API cache', 'other', 'json', 'usage*.json', (c) => [
    path.join(c.xdgConfig, 'tokscale/warp-cache'),
  ]),
  p('cline', 'Cline', 'other', 'json', '**/*.{json,jsonl}', (c) => {
    const cli =
      c.env.CLINE_SESSION_DATA_DIR?.trim() ||
      (c.env.CLINE_DATA_DIR?.trim() ? path.join(c.env.CLINE_DATA_DIR.trim(), 'sessions') : '') ||
      (c.env.CLINE_DIR?.trim() ? path.join(c.env.CLINE_DIR.trim(), 'data/sessions') : '') ||
      path.join(c.home, '.cline/data/sessions');
    return [...vscodeTasks(c, 'saoudrizwan.claude-dev'), cli];
  }, ['CLINE_SESSION_DATA_DIR', 'CLINE_DATA_DIR', 'CLINE_DIR']),
  p('jcode', 'Jcode', 'other', 'json', '**/session_*.json*', (c) => [
    path.join(envDir(c, 'JCODE_HOME', '.jcode'), 'sessions'),
  ], ['JCODE_HOME']),
  p('commandcode', 'Command Code', 'other', 'jsonl', '**/*.jsonl', (c) => [
    path.join(c.home, '.commandcode/projects'),
  ]),
  p('micode', 'MiMo Code', 'other', 'sqlite', '**/*.db', (c) => [
    path.join(c.xdgData, 'mimocode'),
    path.join(c.appData, 'orca/mimocode-hooks/shared/data'),
  ]),
  p('junie', 'Junie', 'other', 'jsonl', '**/events.jsonl', (c) => [
    path.join(c.home, '.junie/sessions'),
  ]),
  p('opencodereview', 'OpenCodeReview', 'other', 'jsonl', '**/*.jsonl', (c) => [
    path.join(c.home, '.opencodereview/sessions'),
  ]),
  p('codebuddy', 'CodeBuddy', 'other', 'jsonl', '**/*.jsonl', (c) => [
    path.join(c.home, '.codebuddy/projects'),
  ]),
  p('augment', 'Augment Code', 'other', 'json', '**/*.json', (c) => [
    path.join(c.home, '.augment/sessions'),
  ]),
  p('reasonix', 'Reasonix', 'other', 'jsonl', '**/*.jsonl', (c) => {
    const st = c.env.REASONIX_STATE_HOME?.trim() || c.env.REASONIX_HOME?.trim();
    return [path.join(st || path.join(c.home, '.reasonix'), 'stats')];
  }, ['REASONIX_STATE_HOME', 'REASONIX_HOME']),
  p('cherrystudio', 'Cherry Studio', 'other', 'jsonl', '**/*.jsonl', (c) => [
    path.join(c.appData, 'CherryStudio/.claude/projects'),
    path.join(c.appData, 'CherryStudio/Data/Agents/.claude/projects'),
  ]),
  p('dsh', 'DeepSeek Harness', 'other', 'jsonl', '**/session.jsonl*', (c) => [
    path.join(envDir(c, 'DSH_HOME', '.dsh'), 'sessions'),
  ], ['DSH_HOME']),
  p('mcode', 'MiniMax Code (headless)', 'other', 'jsonl', '**/*.jsonl', (c) => [
    path.join(c.xdgConfig, 'tokscale/headless/mcode'),
  ]),
  p('fx', 'fx', 'other', 'json', '**/usage-v2.json', (c) => [path.join(c.home, '.fx/sessions')]),
  p('lmstudio', 'LM Studio', 'other', 'log', '**/*.log', (c) => [
    path.join(envDir(c, 'LM_STUDIO_HOME', '.lmstudio'), 'server-logs'),
  ], ['LM_STUDIO_HOME']),
  p('unsloth', 'Unsloth Studio', 'other', 'sqlite', '', (c) => [
    path.join(envDir(c, 'UNSLOTH_STUDIO_HOME', '.unsloth/studio'), 'studio.db'),
  ], ['UNSLOTH_STUDIO_HOME']),
  p('devin-cli', 'Devin CLI', 'other', 'sqlite', '', (c) => [
    path.join(c.xdgData, 'devin/cli/sessions.db'),
  ]),
  p('devin-desktop', 'Devin Desktop', 'other', 'jsonl', '**/*.ndjson', (c) => [
    path.join(c.appData, 'Devin/User/acp-events'),
  ]),
  p('octofriend', 'Octofriend (synthetic)', 'other', 'sqlite', '', (c) => [
    path.join(c.xdgData, 'octofriend/sqlite.db'),
  ]),
];

export function displayPath(abs: string, home: string): string {
  if (abs === home) return '~';
  if (abs.startsWith(home + path.sep) || abs.startsWith(home + '/')) {
    return '~' + abs.slice(home.length);
  }
  return abs;
}

function fileMatchesGlob(name: string, glob: string): boolean {
  if (!glob) return true;
  const g = new Bun.Glob(glob);
  return g.match(name) || g.match(path.basename(name)) || new Bun.Glob(path.basename(glob)).match(name);
}

export function measureRoot(root: string, glob: string, cap = FILE_CAP): RootHit {
  const miss = (): RootHit => ({
    path: root,
    exists: false,
    isFile: false,
    files: 0,
    bytes: 0,
    newestMs: null,
    truncated: false,
  });
  let st: fs.Stats;
  try {
    st = fs.statSync(root);
  } catch {
    return miss();
  }
  if (st.isFile()) {
    const ok = fileMatchesGlob(path.basename(root), glob);
    return {
      path: root,
      exists: true,
      isFile: true,
      files: ok ? 1 : 0,
      bytes: ok ? st.size : 0,
      newestMs: st.mtimeMs,
      truncated: false,
    };
  }
  if (!st.isDirectory()) return miss();

  let files = 0;
  let bytes = 0;
  let newestMs = 0;
  let truncated = false;
  const pattern = glob || '**/*';
  try {
    for (const rel of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true, dot: true })) {
      const parts = rel.replaceAll('\\', '/').split('/');
      if (parts.some((p) => SKIP_DIR.has(p))) continue;
      if (files >= cap) {
        truncated = true;
        break;
      }
      files += 1;
      try {
        const s = fs.statSync(path.join(root, rel));
        bytes += s.size;
        if (s.mtimeMs > newestMs) newestMs = s.mtimeMs;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* glob 失败当空目录 */
  }
  return {
    path: root,
    exists: true,
    isFile: false,
    files,
    bytes,
    newestMs: newestMs || st.mtimeMs,
    truncated,
  };
}

function uniqPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pth of paths) {
    if (!pth) continue;
    const abs = path.resolve(pth);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

export function probeAgent(probe: AgentProbe, ctx: ProbeCtx, cap = FILE_CAP): AgentHit {
  const roots = uniqPaths(probe.roots(ctx)).map((r) => measureRoot(r, probe.glob, cap));
  const files = roots.reduce((n, r) => n + r.files, 0);
  const bytes = roots.reduce((n, r) => n + r.bytes, 0);
  const newestMs = roots.reduce<number | null>((n, r) => {
    if (r.newestMs == null) return n;
    return n == null || r.newestMs > n ? r.newestMs : n;
  }, null);
  const anyExists = roots.some((r) => r.exists);
  const status: AgentHit['status'] = files > 0 ? 'present' : anyExists ? 'empty' : 'missing';
  return { id: probe.id, display: probe.display, kind: probe.kind, format: probe.format, status, files, bytes, newestMs, roots };
}

export type CheckOptions = {
  kind?: 'all' | ProbeKind;
  all?: boolean;
  ids?: string[];
  cap?: number;
};

export function checkLocalAgents(opts: CheckOptions = {}, ctx: ProbeCtx = makeProbeCtx()): AgentHit[] {
  const kind = opts.kind ?? 'all';
  const ids = opts.ids?.length ? new Set(opts.ids) : null;
  return AGENT_PROBES
    .filter((p) => (kind === 'all' || p.kind === kind) && (!ids || ids.has(p.id)))
    .map((p) => probeAgent(p, ctx, opts.cap))
    .filter((h) => opts.all || h.status === 'present');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
