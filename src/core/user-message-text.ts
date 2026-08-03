import { stripOpencodeUserPromptInjection } from './opencode-user-prompt';

/** 去掉 OpenCode 注入并过滤空 user 文本 part */
export function sanitizeUserTextParts<T extends { text: string }>(parts: T[]): T[] {
  return parts
    .map(p => ({ ...p, text: stripOpencodeUserPromptInjection(p.text || '') }))
    .filter(p => p.text.trim() !== '');
}