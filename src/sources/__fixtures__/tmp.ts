/**
 * hermetic 测试临时目录
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function mkFixtureDir(prefix = 'acs-fix'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeJsonl(filePath: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
    'utf-8',
  );
}

export function writeJson(filePath: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf-8');
}
