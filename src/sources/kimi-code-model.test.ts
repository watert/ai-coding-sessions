import { describe, expect, test } from 'bun:test';
import {
  bareKimiModelId,
  preferKimiModel,
  buildKimiPreferredModelMap,
  unifyKimiModelId,
  collectKimiModelsUsed,
} from './kimi-code';

describe('kimi model 记法归一', () => {
  test('bareKimiModelId 剥 provider', () => {
    expect(bareKimiModelId('opencode-go/deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(bareKimiModelId('deepseek-v4-flash')).toBe('deepseek-v4-flash');
  });

  test('preferKimiModel 同模型优先带 provider', () => {
    expect(preferKimiModel(
      'opencode-go/deepseek-v4-flash',
      'deepseek-v4-flash',
    )).toBe('opencode-go/deepseek-v4-flash');
    expect(preferKimiModel(
      'deepseek-v4-flash',
      'opencode-go/deepseek-v4-flash',
    )).toBe('opencode-go/deepseek-v4-flash');
  });

  test('preferKimiModel 解开别名', () => {
    expect(preferKimiModel('__secondary__', 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(preferKimiModel('__secondary__', 'opencode-go/deepseek-v4-flash'))
      .toBe('opencode-go/deepseek-v4-flash');
  });

  test('preferKimiModel 不同模型保留已有值', () => {
    expect(preferKimiModel('kimi-k2.5', 'deepseek-v4-flash')).toBe('kimi-k2.5');
  });

  test('会话内裸 id 提升为唯一 provider/id', () => {
    const preferred = buildKimiPreferredModelMap([
      'opencode-go/deepseek-v4-flash',
      'deepseek-v4-flash',
    ]);
    expect(unifyKimiModelId('deepseek-v4-flash', preferred))
      .toBe('opencode-go/deepseek-v4-flash');
    expect(collectKimiModelsUsed([
      'opencode-go/deepseek-v4-flash',
      'deepseek-v4-flash',
    ])).toBe('opencode-go/deepseek-v4-flash');
  });

  test('两个不同 provider 的同名模型不互相吞并', () => {
    expect(collectKimiModelsUsed([
      'opencode-go/deepseek-v4-flash',
      'deepseek/deepseek-v4-flash',
    ])).toBe('opencode-go/deepseek-v4-flash,deepseek/deepseek-v4-flash');
  });

  test('仅裸 id 时保持原样', () => {
    expect(collectKimiModelsUsed(['deepseek-v4-flash'])).toBe('deepseek-v4-flash');
  });
});
