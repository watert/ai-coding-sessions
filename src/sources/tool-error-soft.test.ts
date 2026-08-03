import { describe, it, expect } from 'bun:test';
import {
  classifySoftToolErrorText,
  classifySoftToolError,
  extractToolErrorText,
  buildOpenCodeSoftErrorSql,
} from './tool-error-soft';

describe('tool-error-soft', () => {
  it('extractToolErrorText 支持 string / {output}', () => {
    expect(extractToolErrorText('x')).toBe('x');
    expect(extractToolErrorText({ output: 'Interrupted by user', isError: true }))
      .toBe('Interrupted by user');
  });

  it('abort/cancel/dismiss → soft aborted_user', () => {
    for (const t of [
      'Tool execution aborted',
      'Task cancelled',
      'Interrupted by user',
      'The user dismissed this question',
      '{"output":"Interrupted by user","isError":true}',
    ]) {
      const r = classifySoftToolErrorText(t);
      expect(r.soft).toBe(true);
      expect(r.kind).toBe('aborted_user');
    }
  });

  it('Ripgrep JSON record exceeded → soft rg_json_too_large', () => {
    const r = classifySoftToolErrorText('Ripgrep JSON record exceeded 65536 bytes');
    expect(r.soft).toBe(true);
    expect(r.kind).toBe('rg_json_too_large');
  });

  it('schema / edit miss / file not found 不是 soft', () => {
    expect(classifySoftToolErrorText('SchemaError Missing key at ["filePath"]').soft).toBe(false);
    expect(classifySoftToolErrorText('Could not find oldString in the file').soft).toBe(false);
    expect(classifySoftToolErrorText('File not found: /tmp/x').soft).toBe(false);
    expect(classifySoftToolErrorText('old_string not found in /a.md').soft).toBe(false);
  });

  it('classifySoftToolError 读 result.output', () => {
    const r = classifySoftToolError({
      result: { output: 'Interrupted by user', isError: true },
    });
    expect(r.soft).toBe(true);
    expect(r.kind).toBe('aborted_user');
  });

  it('buildOpenCodeSoftErrorSql 含关键 LIKE', () => {
    const sql = buildOpenCodeSoftErrorSql("COALESCE(e,'')");
    expect(sql).toContain('Tool execution aborted');
    expect(sql).toContain('Ripgrep JSON record exceeded');
    expect(sql).toContain('LIKE');
  });
});
