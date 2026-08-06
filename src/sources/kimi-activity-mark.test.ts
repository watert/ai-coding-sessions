/**
 * getKimiSessionActivityMark：state.updatedAt 冻结时仍应跟 wire mtime
 */
import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getKimiSessionActivityMark } from './kimi-code';

describe('getKimiSessionActivityMark', () => {
  test('无 agents 时回落 stateUpdatedAt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-mark-'));
    const mark = await getKimiSessionActivityMark(dir, 1_000);
    expect(mark.updatedAt).toBe(1_000);
    expect(mark.dirtyMark).toBe('1000:0');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('wire mtime/size 覆盖冻结的 state.updatedAt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-mark-'));
    const wireDir = path.join(dir, 'agents', 'main');
    fs.mkdirSync(wireDir, { recursive: true });
    const wirePath = path.join(wireDir, 'wire.jsonl');
    fs.writeFileSync(wirePath, '{"type":"x"}\n');
    // 把 mtime 拨到明显晚于 state
    const future = Date.now() + 60_000;
    fs.utimesSync(wirePath, future / 1000, future / 1000);

    const mark = await getKimiSessionActivityMark(dir, 100);
    expect(mark.updatedAt).toBeGreaterThan(100);
    expect(mark.dirtyMark).toMatch(/^\d+:\d+$/);
    const [mtimeStr, sizeStr] = mark.dirtyMark.split(':');
    expect(Number(mtimeStr)).toBe(mark.updatedAt);
    expect(Number(sizeStr)).toBeGreaterThan(0);

    // 追加内容 → size 变，dirtyMark 变
    fs.appendFileSync(wirePath, '{"type":"y"}\n');
    const mark2 = await getKimiSessionActivityMark(dir, 100);
    expect(mark2.dirtyMark).not.toBe(mark.dirtyMark);
    expect(Number(mark2.dirtyMark.split(':')[1])).toBeGreaterThan(Number(sizeStr));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('取各 agent wire 的 max mtime', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-mark-'));
    for (const [agent, offset] of [
      ['main', 10_000],
      ['agent-0', 30_000],
      ['agent-1', 20_000],
    ] as const) {
      const d = path.join(dir, 'agents', agent);
      fs.mkdirSync(d, { recursive: true });
      const p = path.join(d, 'wire.jsonl');
      fs.writeFileSync(p, `${agent}\n`);
      const t = (Date.now() + offset) / 1000;
      fs.utimesSync(p, t, t);
    }
    const mark = await getKimiSessionActivityMark(dir, 0);
    const mainStat = fs.statSync(path.join(dir, 'agents', 'main', 'wire.jsonl'));
    const a0Stat = fs.statSync(path.join(dir, 'agents', 'agent-0', 'wire.jsonl'));
    expect(mark.updatedAt).toBe(Math.floor(a0Stat.mtimeMs));
    expect(mark.updatedAt).toBeGreaterThan(Math.floor(mainStat.mtimeMs));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
