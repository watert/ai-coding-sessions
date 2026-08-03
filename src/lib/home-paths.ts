/**
 * 跨平台 home / env 路径工具（对齐 ccusage home + 多路径 env 习惯）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Home 解析（对齐 ccusage）：优先显式 env，便于测试注入与 Win 无 HOME 场景。
 * 顺序：HOME → USERPROFILE → HOMEDRIVE+HOMEPATH → os.homedir() → tmpdir
 */
export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HOME?.trim()) return env.HOME.trim();
  if (env.USERPROFILE?.trim()) return env.USERPROFILE.trim();
  const drive = env.HOMEDRIVE?.trim() || '';
  const hp = env.HOMEPATH?.trim() || '';
  if (drive && hp) return drive + hp; // Win: C: + \Users\…（勿 path.join 以免吃掉盘符形态）
  try {
    const h = os.homedir();
    if (h) return h;
  } catch {
    /* ignore */
  }
  return os.tmpdir();
}

/** 逗号分隔 env → 去空 trim 后的绝对路径列表 */
export function envPathList(envValue: string | undefined): string[] {
  if (!envValue?.trim()) return [];
  return envValue
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
}

/** 取第一个存在的路径（可选 predicate）；都没有则返回 fallback */
export function firstExisting(
  candidates: string[],
  fallback: string,
  isOk: (p: string) => boolean = (p) => fs.existsSync(p),
): string {
  for (const p of candidates) {
    try {
      if (isOk(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return fallback;
}

/**
 * 标准「env 多路径 / 默认候选 / 默认回退」：
 * - env 有值：取首个通过 isOk 的，否则 env 首项
 * - 否则扫 defaults 找 isOk
 * - 都没有 → fallback（默认 defaults 最后一项，偏向传统 ~/.xxx）
 */
export function resolveDataRoot(opts: {
  envValue?: string;
  defaults: string[];
  /** 无 isOk 命中时的回退（默认 defaults 末项） */
  fallback?: string;
  /** env 项额外规范化（如 claude …/projects → 父目录） */
  normalize?: (p: string) => string;
  isOk?: (p: string) => boolean;
}): string {
  const normalize = opts.normalize ?? ((p: string) => p);
  const isOk = opts.isOk ?? ((p: string) => fs.existsSync(p));
  const fromEnv = envPathList(opts.envValue).map(normalize);
  if (fromEnv.length) {
    return firstExisting(fromEnv, fromEnv[0], isOk);
  }
  const defaults = opts.defaults.map(normalize);
  const fallback =
    opts.fallback != null
      ? normalize(opts.fallback)
      : defaults[defaults.length - 1] || defaults[0] || resolveHomeDir();
  return firstExisting(defaults, fallback, isOk);
}
