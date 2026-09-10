/**
 * OpenCode SQLite — hermetic fixture 为主；真机冒烟见 ACS_LIVE_TESTS=1
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import {
  getOpencodeDbPath,
  initOpencodeDb,
  getOpencodeDb,
  getSessionList,
  getSessionDetail,
  closeOpencodeDb,
} from './opencode';
import { listSessions, getSessionDetail as getUnifiedSessionDetail } from './index';
import { summarizeSessionTimingFromMessages } from '../store/session-trace';
import {
  createOpencodeFixtureDb,
  OC_SESSION_ID,
  OC_ERR_SESSION_ID,
  OC_NORESP_SESSION_ID,
  OC_MULTI_SESSION_ID,
  OC_MULTI_STEPS,
  OC_MULTI_EXPECT,
  type OpencodeFixture,
} from './__fixtures__/opencode';

const LIVE = process.env.ACS_LIVE_TESTS === '1';

describe('OpenCode SQLite (fixture)', () => {
  let fx: OpencodeFixture;
  let prevDb: string | undefined;

  beforeAll(async () => {
    fx = createOpencodeFixtureDb();
    prevDb = process.env.OPENCODE_DB_PATH;
    process.env.OPENCODE_DB_PATH = fx.dbPath;
    closeOpencodeDb();
    await initOpencodeDb();
  });

  afterAll(() => {
    closeOpencodeDb();
    if (prevDb === undefined) delete process.env.OPENCODE_DB_PATH;
    else process.env.OPENCODE_DB_PATH = prevDb;
  });

  it('getOpencodeDbPath 尊重 OPENCODE_DB_PATH', () => {
    expect(getOpencodeDbPath()).toBe(fx.dbPath);
  });

  it('init 后可 getDb', () => {
    expect(getOpencodeDb()).toBeTruthy();
  });

  it('getSessionList 返回 fixture session', () => {
    const { list, total } = getSessionList();
    expect(total).toBeGreaterThanOrEqual(1);
    expect(list.some((s) => s.session_id === OC_SESSION_ID)).toBe(true);
    const item = list.find((s) => s.session_id === OC_SESSION_ID)!;
    expect(item.session_title).toContain('Fixture');
    expect(item.total_messages).toBe(2);
    expect(item.total_user_messages).toBe(1);
    expect(item.total_tool_calls).toBe(1);
    expect(item.total_tokens).toBe(150);
    expect(item.total_input).toBe(100);
    expect(item.total_output).toBe(50);
    expect(item.session_status).toBe('done');
  });

  it('getSessionList compact 同样带 session_status', () => {
    const { list } = getSessionList(undefined, undefined, true);
    const item = list.find((s) => s.session_id === OC_SESSION_ID)!;
    expect(item.session_status).toBe('done');
  });

  it('0-token error session (429) 经 fallback 判 error 而非 done', () => {
    const { list } = getSessionList();
    const item = list.find((s) => s.session_id === OC_ERR_SESSION_ID)!;
    expect(item.session_status).toBe('error');
  });

  it('无回复 user-only session 经 fallback 判 in-progress', () => {
    const { list } = getSessionList();
    const item = list.find((s) => s.session_id === OC_NORESP_SESSION_ID)!;
    expect(item.session_status).toBe('in-progress');
  });

  it('listSessions convert 透传 session_status（勿漏映射成 unknown）', async () => {
    const { sessions } = await listSessions({ source: 'opencode' });
    const item = sessions.find((s) => s.id === OC_SESSION_ID);
    expect(item?.session_status).toBe('done');
  });

  it('日期过滤（YYYY-MM-DD）', () => {
    const hit = getSessionList('2026-07-01', '2026-07-31');
    expect(hit.list.some((s) => s.session_id === OC_SESSION_ID)).toBe(true);
    const miss = getSessionList('2025-01-01', '2025-01-31');
    expect(miss.list.some((s) => s.session_id === OC_SESSION_ID)).toBe(false);
  });

  it('getSessionDetail 结构与 parts 关联', async () => {
    const detail = getSessionDetail(OC_SESSION_ID);
    expect(detail).toBeTruthy();
    expect(detail!.info.id).toBe(OC_SESSION_ID);
    expect(detail!.info.title).toContain('Fixture');
    expect(detail!.messages.length).toBe(2);
    expect(detail!.messages[0].info.role).toBe('user');
    expect(detail!.messages[1].info.role).toBe('assistant');
    expect(detail!.messages[1].info.tokens?.total).toBe(150);
    for (const msg of detail!.messages) {
      for (const part of msg.parts) {
        expect(part.messageID).toBe(msg.info.id);
        expect(part.sessionID).toBe(OC_SESSION_ID);
      }
    }
    const tools = detail!.messages[1].parts.filter((p) => p.type === 'tool');
    expect(tools.length).toBe(1);
    expect(tools[0].tool).toBe('bash');
    expect(detail!.info.session_status).toBe('done');
    const unified = await getUnifiedSessionDetail({ sessionId: OC_SESSION_ID, source: 'opencode' });
    expect(unified?.info.session_status).toBe('done');
  });

  it('多步 agent loop：全部 assistant 采样，TTFT/decode 用统一口径', () => {
    const { list } = getSessionList();
    const item = list.find((s) => s.session_id === OC_MULTI_SESSION_ID)!;
    expect(item.total_messages).toBe(4);
    // 旧实现按 user 轮次只取首条 → 这里只会剩 1 个样本
    expect(item.latency_list).toEqual(OC_MULTI_EXPECT.ttftList);
    expect(item.assistant_tps_list).toHaveLength(3);
    item.assistant_tps_list!.forEach((v, i) => {
      expect(v).toBeCloseTo(OC_MULTI_EXPECT.tpsList[i], 6);
    });
    expect(item.avg_latency_ms).toBe(OC_MULTI_EXPECT.avgLatencyMs);
    expect(item.avg_tps).toBe(OC_MULTI_EXPECT.avgTps);
  });

  it('compact 与全量列表的 timing 口径一致', () => {
    const { list } = getSessionList(undefined, undefined, true);
    const item = list.find((s) => s.session_id === OC_MULTI_SESSION_ID)!;
    expect(item.avg_tps).toBe(OC_MULTI_EXPECT.avgTps);
    expect(item.avg_latency_ms).toBe(OC_MULTI_EXPECT.avgLatencyMs);
  });

  it('detail 消息级 tps：纯输出窗口 + 分子含 reasoning', () => {
    const detail = getSessionDetail(OC_MULTI_SESSION_ID)!;
    const asst = detail.messages.filter((m) => m.info.role === 'assistant');
    expect(asst).toHaveLength(3);
    asst.forEach((m, i) => {
      // TTFT 终点 / decode 边界都来自输出 part，不含尾部 tool part
      expect(m.info.time?.decodeStart).toBe(OC_MULTI_STEPS[i].window[0]);
      expect(m.info.time?.decodeEnd).toBe(OC_MULTI_STEPS[i].window[1]);
      expect(m.info.tps?.decode).toBeCloseTo(Number(OC_MULTI_EXPECT.tpsList[i].toFixed(2)), 2);
    });
  });

  it('CLI detail 聚合（summarizeSessionTimingFromMessages）与 list 口径一致', () => {
    const detail = getSessionDetail(OC_MULTI_SESSION_ID)!;
    const sum = summarizeSessionTimingFromMessages(detail.messages);
    expect(sum.avg_tps).toBe(OC_MULTI_EXPECT.avgTps);
    expect(sum.avg_latency_ms).toBe(OC_MULTI_EXPECT.avgLatencyMs);
  });

  it('不存在的 session 返回 null', () => {
    expect(getSessionDetail('non-existent-session-id')).toBeNull();
  });
});

describe.skipIf(!LIVE)('OpenCode SQLite (live, ACS_LIVE_TESTS=1)', () => {
  beforeEach(async () => {
    delete process.env.OPENCODE_DB_PATH;
    closeOpencodeDb();
    await initOpencodeDb();
  });

  afterEach(() => {
    closeOpencodeDb();
  });

  it('真机 list 可调用', () => {
    const { list } = getSessionList();
    expect(Array.isArray(list)).toBe(true);
  }, 30_000);

  it('真机 detail（若有 session）', () => {
    const { list } = getSessionList();
    if (!list.length) return;
    const detail = getSessionDetail(list[0].session_id);
    expect(detail).toBeTruthy();
    expect(detail!.info.id).toBe(list[0].session_id);
  }, 30_000);

  it('compaction 样本（若存在）', () => {
    const COMPACT_SESSION = 'ses_06ddf54d1ffeR4tvEvPbU1dx2A';
    const detail = getSessionDetail(COMPACT_SESSION);
    if (!detail) return;
    const compactMsgs = detail.messages.filter((m) => m.info.compaction);
    expect(compactMsgs.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
