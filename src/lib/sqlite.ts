/**
 * SQLite 通用工具
 * 主路径：Bun `bun:sqlite`（文档与验收均按 Bun-only）。
 * 仍保留 better-sqlite3 分支以便宿主 Node 偶发加载，但不在 README 宣传。
 */

import pathMod from 'node:path';
import { pathToFileURL } from 'node:url';

type SqliteDatabase = any;

interface SqliteInstance {
  db: SqliteDatabase | null;
  dbPath: string | null;
}

const instances = new Map<string, SqliteInstance>();

/**
 * WAL 库在 bun:sqlite 下 `new Database(path, { readonly: true })` 会 SQLITE_CANTOPEN
 * （prepare 阶段）；URI `file:…?mode=ro` 可正常只读打开。
 *
 * Windows 必须用标准 file URL（`file:///C:/...`），不能直接拼 `file:C:\...`。
 * 用 pathToFileURL 统一 POSIX/Win 路径。
 */
export function toReadonlyUri(dbPath: string): string {
  const abs = pathMod.isAbsolute(dbPath) ? dbPath : pathMod.resolve(dbPath);
  const url = pathToFileURL(abs);
  url.searchParams.set('mode', 'ro');
  return url.href;
}

/**
 * 初始化 SQLite 数据库连接
 * @param instanceId 实例唯一标识，用于区分不同数据库
 * @param getDbPath  获取数据库路径的函数
 * @param readonly   是否以只读模式打开，默认 false
 */
export async function initSqliteDb(
  instanceId: string,
  getDbPath: () => string,
  readonly: boolean = false
): Promise<void> {
  const instance = instances.get(instanceId) || { db: null, dbPath: null };
  if (instance.db) return;

  const dbPath = getDbPath();
  instance.dbPath = dbPath;

  // 优先使用 bun:sqlite
  if (globalThis.Bun) {
    const { Database } = await import('bun:sqlite');
    if (!readonly) {
      instance.db = new Database(dbPath, { readwrite: true, create: true });
    } else {
      try {
        const db = new Database(toReadonlyUri(dbPath), { readonly: true });
        // 探测：旧 { readonly:true } 路径 ctor 成功但 prepare 会 CANTOPEN
        db.prepare('SELECT 1').get();
        instance.db = db;
      } catch {
        console.warn(
          `[sqlite:${instanceId}] readonly 打开失败，回退 readwrite(create:false): ${dbPath}`,
        );
        instance.db = new Database(dbPath, { readwrite: true, create: false });
      }
    }
    console.error(`[sqlite:${instanceId}] 运行时: Bun | 驱动: bun:sqlite | 路径: ${dbPath}`);
  } else {
    try {
      const Database = (await import('better-sqlite3')).default;
      instance.db = new Database(dbPath, { readonly });
      console.error(`[sqlite:${instanceId}] 运行时: Node | 驱动: better-sqlite3 | 路径: ${dbPath}`);
    } catch (e) {
      throw new Error('Node 环境下请安装 better-sqlite3: npm install better-sqlite3');
    }
  }

  instances.set(instanceId, instance);
}

/**
 * 获取数据库实例
 * @param instanceId 实例唯一标识
 */
export function getSqliteDb(instanceId: string): SqliteDatabase {
  const instance = instances.get(instanceId);
  if (!instance?.db) throw new Error(`数据库 ${instanceId} 未初始化，请先调用 initSqliteDb()`);
  return instance.db;
}

/**
 * 关闭数据库连接
 * @param instanceId 实例唯一标识
 */
export function closeSqliteDb(instanceId: string): void {
  const instance = instances.get(instanceId);
  if (instance?.db) {
    instance.db.close();
    instance.db = null;
    instance.dbPath = null;
    instances.delete(instanceId);
    console.error(`[sqlite:${instanceId}] 数据库连接已关闭`);
  }
}
