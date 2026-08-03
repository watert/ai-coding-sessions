/** 去掉 OpenCode 注入到 user prompt 的 system-reminder 等 XML 块 */
const SYSTEM_REMINDER_BLOCK =
  /<\s*system-reminder\s*>[\s\S]*?<\s*\/\s*system-reminder\s*>/gi;
const SYSTEM_REMINDER_TAIL = /<\s*system-reminder\s*>[\s\S]*$/i;

export function stripOpencodeUserPromptInjection(text: string): string {
  if (!text) return '';
  let out = text.replace(SYSTEM_REMINDER_BLOCK, '');
  out = out.replace(SYSTEM_REMINDER_TAIL, '');
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}