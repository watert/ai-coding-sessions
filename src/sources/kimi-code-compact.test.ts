import { describe, it, expect } from 'bun:test';
import { listKimiCodeMessages } from './kimi-code';
import { getSessionDetail } from './index';

const COMPACT_SESSION_ID = 'session_50bd1f70-0cf9-4555-8b37-2c6eeef55e49';

describe('Kimi compaction session_50bd1f70', () => {
  it('应解析出 compact 消息及 summary 用量', async () => {
    const raw = await listKimiCodeMessages({ sessionId: COMPACT_SESSION_ID });
    const compact = raw.find(m => m.text?.startsWith('[Context Compacted]'));
    expect(compact).toBeDefined();
    expect(compact!.usage?.inputOther).toBe(94005);
    expect(compact!.usage?.output).toBe(692);
    expect(compact!.text).toContain('93329');
    expect(compact!.text).toContain('11303');
  });

  it('compact parentID 应挂在 compact 前最后一条 user', async () => {
    const detail = await getSessionDetail({ sessionId: COMPACT_SESSION_ID, source: 'kimi' });
    const users = detail!.messages.filter(m => m.info.role === 'user');
    const compact = detail!.messages.find(m =>
      m.parts?.some((p: { text?: string }) => String(p.text || '').startsWith('[Context Compacted]')),
    );
    expect(compact?.info.compaction).toBe(true);
    const parentUser = users.find(u => u.info.id === compact?.info.parentID);
    expect(parentUser?.parts?.[0]?.text).toContain('ammend commit');
    expect(detail?.info?.time_compacting).toBe(1783425948998);
  });

  it('手动 compact session 应带 手动压缩 标注', async () => {
    const MANUAL_ID = 'session_c147977d-a31d-4217-954a-9e14276897c7';
    const raw = await listKimiCodeMessages({ sessionId: MANUAL_ID });
    const compact = raw.find(m => m.text?.startsWith('[Context Compacted]'));
    if (!compact) {
      console.log('manual compact sample 不存在，跳过');
      return;
    }
    expect(compact.text).toContain('手动压缩');
  });

  it('compact 后无下一句 prompt 应判 done 而非 in-progress', async () => {
    // 以 compact 结尾、之后无新 user
    const END_WITH_COMPACT = 'session_eee107d8-1d84-4eef-881b-4b2d4e78e2b0';
    const detail = await getSessionDetail({ sessionId: END_WITH_COMPACT, source: 'kimi' });
    if (!detail) {
      console.log('end-with-compact sample 不存在，跳过');
      return;
    }
    const last = detail.messages[detail.messages.length - 1];
    expect(last?.info?.compaction).toBe(true);
    expect(last?.info?.finish).toBe('stop');
    expect(last?.info?.time?.completed).toBeTruthy();
    expect(detail.info?.session_status).toBe('done');
  });
});
