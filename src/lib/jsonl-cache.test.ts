/**
 * jsonl 读取缓存：按估算对象大小记账 / 命中复用 / 变更失效
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clearJsonlCache, getJsonlCacheStats, readJsonlCachedAsync } from './jsonl-cache';

describe('jsonl-cache', () => {
  beforeEach(() => clearJsonlCache());

  test('记账按估算对象大小（size × 4），而非原始文本字节', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-cache-'));
    const file = path.join(dir, 'a.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"b":2}\n');

    const rows = await readJsonlCachedAsync(file);
    expect(rows?.length).toBe(2);
    expect(getJsonlCacheStats()).toEqual({
      entries: 1,
      estimatedBytes: fs.statSync(file).size * 4,
    });
  });

  test('文件未变命中同一 rows；size 变化后重新解析', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-cache-'));
    const file = path.join(dir, 'b.jsonl');
    fs.writeFileSync(file, '{"n":1}\n');

    const first = await readJsonlCachedAsync(file);
    const second = await readJsonlCachedAsync(file);
    expect(second).toBe(first as unknown as any[]);

    fs.appendFileSync(file, '{"n":2}\n');
    const third = await readJsonlCachedAsync(file);
    expect(third?.length).toBe(2);
    expect(third).not.toBe(first as unknown as any[]);
    expect(getJsonlCacheStats().entries).toBe(1);
  });

  test('文件不存在返回 null 且不占条目', async () => {
    expect(await readJsonlCachedAsync('/tmp/jsonl-cache-missing-file.jsonl')).toBeNull();
    expect(getJsonlCacheStats()).toEqual({ entries: 0, estimatedBytes: 0 });
  });
});
