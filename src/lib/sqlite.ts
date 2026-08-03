/**
 * SQLite 通用工具
 * 支持 Bun:sqlite 和 better-sqlite3 双驱动自动适配
 */

type SqliteDatabase = any;

interface SqliteInstance {
  db: SqliteDatabase | null;
  dbPath: string | null;
}

const instances = new Map<string, SqliteInstance>();

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

  const path = getDbPath();
  instance.dbPath = path;

  // 优先使用 bun:sqlite
  if (globalThis.Bun) {
    const { Database } = await import("bun:sqlite");
    // Bun sqlite 参数兼容：明确指定读写模式
    instance.db = readonly
      ? new Database(path, { readonly: true })
      : new Database(path, { readwrite: true, create: true });
    console.error(`[sqlite:${instanceId}] 运行时: Bun | 驱动: bun:sqlite | 路径: ${path}`);
  } else {
    try {
      const Database = (await import("better-sqlite3")).default;
      instance.db = new Database(path, { readonly });
      console.error(`[sqlite:${instanceId}] 运行时: Node | 驱动: better-sqlite3 | 路径: ${path}`);
    } catch (e) {
      throw new Error("Node 环境下请安装 better-sqlite3: npm install better-sqlite3");
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
