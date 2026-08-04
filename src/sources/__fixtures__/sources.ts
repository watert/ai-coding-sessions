/**
 * 各 source 最小 fixture 生成器（临时目录 + 字符串/建表，无二进制入库）
 */
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixtureDir, writeJson, writeJsonl } from './tmp';
import { encodeClaudeProjectDir } from '../claude-code';

const T0 = Date.UTC(2026, 6, 15, 12, 0, 0);

// ---------- Claude ----------
export function createClaudeFixture(dir?: string) {
  const root = dir || mkFixtureDir('acs-claude-');
  const project = '/tmp/acs-claude-proj';
  const sessionId = 'claude-sess-fixture-001';
  const projDir = path.join(root, 'projects', encodeClaudeProjectDir(project));
  const historyPath = path.join(root, 'history.jsonl');
  const sessPath = path.join(projDir, `${sessionId}.jsonl`);

  writeJsonl(historyPath, [
    {
      display: 'Claude fixture prompt',
      pastedContents: {},
      timestamp: T0,
      project,
      sessionId,
    },
  ]);

  writeJsonl(sessPath, [
    {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      isSidechain: false,
      timestamp: new Date(T0).toISOString(),
      cwd: project,
      sessionId,
      message: { role: 'user', content: 'hello claude fixture' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      isSidechain: false,
      timestamp: new Date(T0 + 1000).toISOString(),
      cwd: project,
      sessionId,
      message: {
        id: 'msg_a1',
        role: 'assistant',
        model: 'claude-fixture',
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    },
  ]);

  return { root, project, sessionId, historyPath, sessPath };
}

// ---------- Codex (scan rollout, 无 state sqlite) ----------
export function createCodexFixture(dir?: string) {
  const root = dir || mkFixtureDir('acs-codex-');
  const sessionId = 'codex-sess-fixture-001';
  const rolloutDir = path.join(root, 'sessions', '2026', '07', '15');
  const rolloutPath = path.join(rolloutDir, `rollout-${sessionId}.jsonl`);
  const cwd = '/tmp/acs-codex-proj';

  writeJsonl(rolloutPath, [
    {
      timestamp: new Date(T0).toISOString(),
      type: 'session_meta',
      payload: {
        id: sessionId,
        session_id: sessionId,
        cwd,
        model_provider: 'openai',
        cli_version: '0.0-test',
        source: 'cli',
      },
    },
    {
      timestamp: new Date(T0 + 100).toISOString(),
      type: 'event_msg',
      payload: { type: 'user_message', message: 'hello codex fixture' },
    },
    {
      timestamp: new Date(T0 + 500).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hi from codex' }],
      },
    },
    {
      timestamp: new Date(T0 + 600).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 20,
            output_tokens: 8,
            cached_input_tokens: 0,
          },
        },
      },
    },
  ]);

  return { root, sessionId, rolloutPath, cwd };
}

// ---------- Kimi ----------
export function createKimiFixture(dir?: string) {
  const root = dir || mkFixtureDir('acs-kimi-');
  const sessionId = 'kimi-sess-fixture-001';
  const workDir = '/tmp/acs-kimi-proj';
  const sessionDir = path.join(root, 'sessions', 'wd_fixture', `session_${sessionId}`);
  const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const statePath = path.join(sessionDir, 'state.json');
  const indexPath = path.join(root, 'session_index.jsonl');

  writeJson(statePath, {
    title: 'Kimi fixture',
    lastPrompt: 'hello kimi',
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0 + 2000).toISOString(),
  });
  writeJsonl(indexPath, [{ sessionId, sessionDir, workDir }]);
  // 最小 wire：metadata + user 可见事件（convert 可空跑）
  writeJsonl(wirePath, [
    { type: 'metadata', protocol_version: '1.4', created_at: T0 },
    {
      type: 'config.update',
      cwd: workDir,
      modelAlias: 'fixture-model',
      time: T0,
    },
  ]);

  return { root, sessionId, sessionDir, workDir, indexPath };
}

// ---------- Grok ----------
export function createGrokFixture(dir?: string) {
  const root = dir || mkFixtureDir('acs-grok-');
  // resolveGrokSessionsRoot：basename===sessions 时原样用；否则拼 /sessions
  const sessionsRoot = path.join(root, 'sessions');
  const sessionId = '019fc000-0000-7000-8000-000000000001';
  const cwd = '/tmp/acs-grok-proj';
  const projEnc = encodeURIComponent(cwd);
  const sessDir = path.join(sessionsRoot, projEnc, sessionId);

  writeJson(path.join(sessDir, 'summary.json'), {
    info: { id: sessionId, cwd },
    session_summary: 'Grok fixture session',
    generated_title: 'Grok fixture',
    created_at: new Date(T0).toISOString(),
    updated_at: new Date(T0 + 3000).toISOString(),
    last_active_at: new Date(T0 + 3000).toISOString(),
    num_messages: 2,
    num_chat_messages: 2,
    current_model_id: 'grok-fixture',
  });
  writeJsonl(path.join(sessDir, 'updates.jsonl'), [
    {
      type: 'user_message',
      timestamp: new Date(T0).toISOString(),
      message: { text: 'hello grok' },
    },
  ]);

  return { root, sessionsRoot, sessionId, sessDir, cwd };
}

// ---------- ZCode ----------
export function createZcodeFixture(dir?: string) {
  const root = dir || mkFixtureDir('acs-zcode-');
  const dbPath = path.join(root, 'cli', 'db', 'db.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  const sessionId = 'zcode-sess-fixture-001';

  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      workspace_id TEXT,
      parent_id TEXT,
      slug TEXT,
      directory TEXT,
      path TEXT,
      title TEXT,
      version TEXT,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      time_compacting INTEGER,
      time_archived INTEGER,
      task_type TEXT,
      title_source TEXT,
      title_message_id TEXT,
      time_title_updated INTEGER,
      trace_id TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT,
      sequence INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT,
      sequence INTEGER
    );
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      assistant_message_id TEXT,
      parent_user_message_id TEXT,
      query_source TEXT,
      provider_id TEXT,
      model_id TEXT,
      status TEXT,
      started_at INTEGER,
      first_token_at INTEGER,
      completed_at INTEGER,
      duration_ms INTEGER,
      time_to_first_token_ms INTEGER,
      finish_reason TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      computed_total_tokens INTEGER
    );
  `);

  db.prepare(
    `INSERT INTO session (
      id, project_id, slug, directory, title, version, time_created, time_updated
    ) VALUES (?, 'proj1', 'slug1', '/tmp/zcode-proj', 'ZCode fixture', '0.1', ?, ?)`,
  ).run(sessionId, T0, T0 + 1000);

  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(
    'zm_user',
    sessionId,
    T0,
    T0,
    JSON.stringify({
      role: 'user',
      time: { created: T0 },
      agent: 'zcode-agent',
      model: { providerID: 'zcode', modelID: 'fixture' },
    }),
  );
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES ('zp1', 'zm_user', ?, ?, ?, ?)`,
  ).run(sessionId, T0, T0, JSON.stringify({ type: 'text', text: 'hello zcode' }));

  db.close();
  return { root, dbPath, sessionId };
}

// ---------- WorkBuddy ----------
export function createWorkbuddyFixture(dir?: string) {
  const root = dir || mkFixtureDir('acs-workbuddy-');
  const dbPath = path.join(root, 'workbuddy.db');
  const sessionId = 'wb-sess-fixture-001';
  const jsonlPath = path.join(root, 'projects', 'hash1', `${sessionId}.jsonl`);

  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      user_id TEXT,
      title TEXT,
      custom_title TEXT,
      status TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      deleted_at INTEGER,
      is_playground INTEGER,
      source_mode TEXT,
      is_background_automation INTEGER,
      mode TEXT,
      model TEXT,
      expert_id TEXT,
      expert_locale TEXT,
      expert_runtime_identity TEXT,
      expert_marketplace TEXT,
      permission_mode TEXT,
      last_activity_at INTEGER,
      use_sandbox_cli INTEGER,
      project_id TEXT
    );
    CREATE TABLE session_usage (
      session_id TEXT PRIMARY KEY,
      used INTEGER,
      size INTEGER,
      credit_json TEXT
    );
    CREATE TABLE workspaces (
      path TEXT
    );
  `);
  db.prepare(
    `INSERT INTO sessions (
      id, cwd, title, status, created_at, updated_at, last_activity_at, model, deleted_at
    ) VALUES (?, '/tmp/wb-proj', 'WorkBuddy fixture', 'idle', ?, ?, ?, 'fixture-model', NULL)`,
  ).run(sessionId, T0, T0 + 1000, T0 + 1000);
  db.prepare(
    `INSERT INTO session_usage (session_id, used, size, credit_json) VALUES (?, 100, 200000, '{}')`,
  ).run(sessionId);
  db.close();

  writeJsonl(jsonlPath, [
    {
      type: 'user',
      timestamp: T0,
      content: 'hello workbuddy',
    },
  ]);

  return { root, dbPath, sessionId, jsonlPath };
}

// ---------- Cursor (composerHeaders only → list) ----------
export function createCursorFixture(dir?: string) {
  const root = dir || mkFixtureDir('acs-cursor-');
  const appData = path.join(root, 'AppData');
  const cursorHome = path.join(root, 'cursor-home');
  const dbPath = path.join(appData, 'User', 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(path.join(cursorHome, 'projects'), { recursive: true });

  const sessionId = 'cursor-composer-fixture-001';
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY,
      workspaceId TEXT,
      createdAt INTEGER,
      lastUpdatedAt INTEGER,
      isArchived INTEGER,
      isSubagent INTEGER,
      recency INTEGER,
      value TEXT
    );
    CREATE TABLE cursorDiskKV (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const header = {
    name: 'Cursor fixture',
    subtitle: 'hello cursor',
    createdAt: T0,
    lastUpdatedAt: T0 + 2000,
    workspaceIdentifier: { fsPath: '/tmp/cursor-proj' },
  };
  db.prepare(
    `INSERT INTO composerHeaders (
      composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value
    ) VALUES (?, 'ws1', ?, ?, 0, 0, ?, ?)`,
  ).run(sessionId, T0, T0 + 2000, T0 + 2000, JSON.stringify(header));

  // 最小 bubble：user + assistant text
  const bubbles = [
    {
      bubbleId: 'b_u1',
      type: 1,
      text: '<user_query>\nhello cursor fixture\n</user_query>',
      createdAt: new Date(T0).toISOString(),
    },
    {
      bubbleId: 'b_a1',
      type: 2,
      text: 'hi from cursor fixture',
      createdAt: new Date(T0 + 1000).toISOString(),
      modelInfo: { modelName: 'default' },
    },
  ];
  const headers = bubbles.map((b) => ({
    bubbleId: b.bubbleId,
    type: b.type,
    createdAt: b.createdAt,
  }));
  db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(
    `composerData:${sessionId}`,
    JSON.stringify({
      composerId: sessionId,
      fullConversationHeadersOnly: headers,
      promptTokenBreakdown: { totalUsedTokens: 1234, maxTokens: 128000, categories: [] },
      contextUsagePercent: 1,
    }),
  );
  for (const b of bubbles) {
    db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(
      `bubbleId:${sessionId}:${b.bubbleId}`,
      JSON.stringify(b),
    );
  }
  db.close();

  return { root, appData, cursorHome, dbPath, sessionId };
}

export { createOpencodeFixtureDb } from './opencode';
