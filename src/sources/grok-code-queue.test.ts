/**
 * grok 运行中插入 / 打断：while-working 前缀 + prior_turn_interrupt
 */
import { describe, expect, test } from 'bun:test';
import { classifyGrokUserQueueOrigin, unwrapGrokUserQueryText } from './grok-code';

describe('classifyGrokUserQueueOrigin', () => {
  test('while you were working → insert', () => {
    expect(classifyGrokUserQueueOrigin({
      text: 'The user sent a message while you were working:\n<user_query>测试插入</user_query>\nMake sure to complete any unfinished tasks from previous turns.',
    })).toBe('insert');
  });

  test('prior_turn_interrupt mid_turn_abort → interrupt', () => {
    expect(classifyGrokUserQueueOrigin({
      prior_turn_interrupt: 'mid_turn_abort',
      text: '<user_query>停掉 bg</user_query>',
    })).toBe('interrupt');
    expect(classifyGrokUserQueueOrigin({
      text: 'The user interrupted the previous turn: <user_query>细一点</user_query>',
    })).toBe('interrupt');
  });

  test('普通 user_query 无 origin', () => {
    expect(classifyGrokUserQueueOrigin({ text: '<user_query>hello</user_query>' })).toBeUndefined();
  });
});

describe('unwrapGrokUserQueryText', () => {
  test('剥掉 while-working 包装只留正文', () => {
    expect(unwrapGrokUserQueryText(
      'The user sent a message while you were working: <user_query>测试插入，你继续</user_query> Make sure to complete any unfinished tasks from previous turns.',
    )).toBe('测试插入，你继续');
  });
});
