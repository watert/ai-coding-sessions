/**
 * 跨 source 的 soft tool error：
 * - 用户中断/取消/dismiss（非工具本身坏掉）
 * - OpenCode rg 单行 JSON 过大（类截断限流）
 *
 * soft 不计入 ToolSucc 失败，也不进 tool-error hard 聚合。
 */

export type SoftToolErrorKind = 'aborted_user' | 'rg_json_too_large';

export function extractToolErrorText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.output === 'string') return o.output;
    if (typeof o.message === 'string') return o.message;
    if (typeof o.error === 'string') return o.error;
    if (typeof o.Error === 'string') return o.Error;
    try {
      return JSON.stringify(o);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

/** 文本是否匹配 soft 规则 */
export function classifySoftToolErrorText(text: string): {
  soft: boolean;
  kind?: SoftToolErrorKind;
} {
  const t = (text || '').trim();
  if (!t) return { soft: false };

  // 用户中断 / 取消 / 关闭提问
  if (
    /Tool execution aborted/i.test(t)
    || /Task cancelled/i.test(t)
    || /Interrupted by user/i.test(t)
    || /user dismissed this question/i.test(t)
    || /The user dismissed this question/i.test(t)
  ) {
    return { soft: true, kind: 'aborted_user' };
  }

  // OpenCode grep：单行 JSON 过大（限流/截断）
  if (/Ripgrep JSON record exceeded/i.test(t)) {
    return { soft: true, kind: 'rg_json_too_large' };
  }

  return { soft: false };
}

export function classifySoftToolError(input: {
  error?: unknown;
  output?: unknown;
  result?: unknown;
}): { soft: boolean; kind?: SoftToolErrorKind; message: string } {
  const message = extractToolErrorText(
    input.error ?? input.output ?? input.result,
  );
  const cls = classifySoftToolErrorText(message);
  return { ...cls, message };
}

/**
 * OpenCode SQLite：判断 soft 的 LIKE 片段（用于 list 聚合）。
 * 字段为 state.error / state.output 的 JSON 字符串。
 */
export function buildOpenCodeSoftErrorSql(expr: string): string {
  // expr e.g. COALESCE(json_extract(tp.data,'$.state.error'),'')
  const patterns = [
    '%Tool execution aborted%',
    '%Task cancelled%',
    '%Interrupted by user%',
    '%dismissed this question%',
    '%Ripgrep JSON record exceeded%',
  ];
  return patterns.map((p) => `${expr} LIKE '${p}'`).join('\n        OR ');
}
