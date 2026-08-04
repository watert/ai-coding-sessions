/**
 * 最小 OpenCode SQLite fixture（生成器，不提交二进制）
 */
import { Database } from 'bun:sqlite';
import path from 'node:path';
import { mkFixtureDir } from './tmp';

export const OC_SESSION_ID = 'ses_fixture_001';
export const OC_PROJECT_ID = 'proj_fixture_001';
export const OC_MSG_USER = 'msg_fixture_user';
export const OC_MSG_ASST = 'msg_fixture_asst';

/** 2026-07-15 12:00 UTC */
export const OC_T0 = Date.UTC(2026, 6, 15, 12, 0, 0);

export type OpencodeFixture = {
  dir: string;
  dbPath: string;
  sessionId: string;
  projectId: string;
};

export function createOpencodeFixtureDb(dir?: string): OpencodeFixture {
  const root = dir || mkFixtureDir('acs-opencode-');
  const dbPath = path.join(root, 'opencode.db');
  const db = new Database(dbPath, { create: true });

  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT,
      vcs TEXT,
      name TEXT,
      icon_url TEXT,
      icon_color TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      time_initialized INTEGER,
      sandboxes TEXT,
      commands TEXT,
      icon_url_override TEXT
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      slug TEXT,
      directory TEXT,
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
      workspace_id TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
  `);

  const t0 = OC_T0;
  const t1 = t0 + 1000;
  const t2 = t0 + 5000;

  db.prepare(
    `INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
     VALUES (?, ?, 'git', ?, ?, ?, '[]')`,
  ).run(OC_PROJECT_ID, '/tmp/acs-fixture-proj', 'fixture-proj', t0, t2);

  db.prepare(
    `INSERT INTO session (
      id, project_id, parent_id, slug, directory, title, version,
      time_created, time_updated, summary_additions, summary_deletions, summary_files
    ) VALUES (?, ?, NULL, 'fixture-slug', ?, 'Fixture OpenCode Session', '1.0.0-test', ?, ?, 0, 0, 0)`,
  ).run(OC_SESSION_ID, OC_PROJECT_ID, '/tmp/acs-fixture-proj', t0, t2);

  const userData = {
    role: 'user',
    time: { created: t0 },
    agent: 'build',
    model: { providerID: 'opencode', modelID: 'fixture-model' },
  };
  const asstData = {
    role: 'assistant',
    time: { created: t1, completed: t2 },
    agent: 'build',
    model: { providerID: 'opencode', modelID: 'fixture-model' },
    modelID: 'fixture-model',
    providerID: 'opencode',
    finish: 'stop',
    tokens: {
      total: 150,
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    cost: 0,
  };

  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
  ).run(OC_MSG_USER, OC_SESSION_ID, t0, t0, JSON.stringify(userData));
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
  ).run(OC_MSG_ASST, OC_SESSION_ID, t1, t2, JSON.stringify(asstData));

  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'part_user_text',
    OC_MSG_USER,
    OC_SESSION_ID,
    t0,
    t0,
    JSON.stringify({ type: 'text', text: 'hello fixture' }),
  );
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'part_asst_text',
    OC_MSG_ASST,
    OC_SESSION_ID,
    t1,
    t2,
    JSON.stringify({ type: 'text', text: 'hi from fixture' }),
  );
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'part_asst_tool',
    OC_MSG_ASST,
    OC_SESSION_ID,
    t1 + 100,
    t1 + 200,
    JSON.stringify({
      type: 'tool',
      tool: 'bash',
      callID: 'call_fixture_1',
      state: {
        status: 'completed',
        input: { command: 'echo hi' },
        output: 'hi\n',
      },
    }),
  );

  db.close();
  return {
    dir: root,
    dbPath,
    sessionId: OC_SESSION_ID,
    projectId: OC_PROJECT_ID,
  };
}
