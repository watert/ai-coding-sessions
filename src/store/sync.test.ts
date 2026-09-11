/**
 * sync 全量/增量 convert 判定（应该走全量的边界）
 */
import { describe, expect, test } from 'bun:test';
import { shouldUseFullConvert } from './sync';

describe('shouldUseFullConvert', () => {
  test('full / reconvert 强制全量', () => {
    expect(shouldUseFullConvert({ full: true, dirtyCount: 1, refsCount: 1000 })).toBe(true);
    expect(shouldUseFullConvert({ reconvert: true, dirtyCount: 1, refsCount: 1000 })).toBe(true);
  });

  test('脏数量超阈值（120）回退全量', () => {
    expect(shouldUseFullConvert({ dirtyCount: 120, refsCount: 1000 })).toBe(false);
    expect(shouldUseFullConvert({ dirtyCount: 121, refsCount: 1000 })).toBe(true);
  });

  test('脏占比过半回退全量', () => {
    expect(shouldUseFullConvert({ dirtyCount: 5, refsCount: 10 })).toBe(false);
    expect(shouldUseFullConvert({ dirtyCount: 6, refsCount: 10 })).toBe(true);
  });

  test('少量脏（refs 为空也）→ 增量', () => {
    expect(shouldUseFullConvert({ dirtyCount: 3, refsCount: 1380 })).toBe(false);
    expect(shouldUseFullConvert({ dirtyCount: 1, refsCount: 0 })).toBe(false);
  });
});
