/**
 * Ordered DDL migrations over an {@link RdbDatabase}. The runner records
 * applied versions in one bookkeeping table per consumer schema; it never
 * generates SQL — statement text stays owned by the consumer package.
 * @module dsh-rdb/src/migrate
 */

import type { RdbConnection, RdbDatabase, RdbDialectName } from './types.ts'
import { RdbError } from './error.ts'

/**
 * Identifier a consumer may hand to the runner as a table name. Plain
 * `[A-Za-z0-9_]` without quoting: the runner interpolates names into DDL,
 * so anything else would be an injection vector, not a naming choice.
 */
export const MIGRATION_TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 迁移执行器最小面（RdbDatabase 与 RdbConnection 均满足）：迁移段统一跑其上。 */
type MigrationExecutor = Pick<RdbConnection, 'query' | 'execute'>

/**
 * 按方言分派的语句组（2026-10-02 用户裁定：守卫组工厂单一入口，方法内按
 * 当前所连库决定方言支）：两个分支都必须给全——执行期按库方言选支，任何
 * 一支缺席都 fail loud，绝不静默回退另一方言的语句。
 */
export type RdbDialectStatements = {
  readonly mysql: readonly string[]
  readonly postgresql: readonly string[]
}

/** One migration step: all statements of a version, applied in order. */
export interface RdbMigration {
  /** Monotonic schema version; applied in ascending order. */
  readonly version: number
  /** 语句条目：单方言语句串，或方言分派组（执行期按所连库方言经
   * {@link resolveRdbStatements} 选支，顺序保持）。 */
  readonly statements: readonly (string | RdbDialectStatements)[]
}

/**
 * 按方言解析语句条目（字符串原样单条；方言分派组按库方言选支）。
 * mysql/postgresql 之外的方言（sqlite/oracle/dm/kingbase）遇方言分派组
 * 一律 fail loud——与链级 resolveMigrations「缺支不回退」同口径。
 * @param statement - 语句条目（字符串或方言分派组）。
 * @param dialect - 当前所连库方言。
 * @returns 该方言下实际执行的语句序列。
 */
export function resolveRdbStatements(statement: string | RdbDialectStatements, dialect: RdbDialectName): readonly string[] {
  if (typeof statement === 'string') return [statement]
  const branch = dialect === 'mysql' || dialect === 'postgresql' ? statement[dialect] : undefined
  if (branch === undefined) {
    throw new RdbError(
      'migration-failed',
      `rdb dialect statement group has no branch for dialect '${dialect}'（方言语句组缺支——该条目未提供此方言的语句，绝不静默回退）`,
    )
  }
  return branch
}

/**
 * 迁移链的方言加载形态（2026-09-23 裁定 16：MySQL 原文件保留——列中文 COMMENT
 * 不动；PG 走 `<name>.pg.ts` 副本——COMMENT 转 COMMENT ON 语句保中文；本运行器
 * 按 database.dialect 动态选支，缺支 fail loud，绝不静默回退另一方言的 DDL）：
 * - 数组形态 = 单方言链（数组在任何方言按原样执行——仅适用于语句已兼容目标库
 *   的链，如 weknora 的 PG 原生链）。
 * - 方言 map 形态 = 每方言各自专属链（`{ mysql: [...], postgresql: [...] }`）。
 */
export type RdbMigrations = readonly RdbMigration[] | {
  readonly [dialect in 'mysql' | 'postgresql']?: readonly RdbMigration[]
}

/** 按库方言解析生效链（方言 map 缺支 fail loud；方言 map 键仅收
 * mysql/postgresql 两族，其余方言走数组形态链）。 */
function resolveMigrations(database: RdbDatabase, migrations: RdbMigrations): readonly RdbMigration[] {
  if (Array.isArray(migrations)) return migrations
  const chains = migrations as Partial<Record<'mysql' | 'postgresql', readonly RdbMigration[]>>
  const dialectKey = database.dialect === 'mysql' || database.dialect === 'postgresql' ? database.dialect : undefined
  const chain = dialectKey === undefined ? undefined : chains[dialectKey]
  if (chain === undefined) {
    throw new RdbError(
      'migration-failed',
      `rdb migrations for database '${database.name}' declare no chain for dialect '${database.dialect}'（方言特定 DDL 缺支——该包未提供此方言的迁移文件）`,
    )
  }
  return chain
}

/**
 * 数据初始化总开关（2026-09-23 割接排障裁定，is_init_db）：环境变量
 * `IS_INIT_DB=true` 时迁移/种子照常执行；**缺省 false=跳过一切数据库
 * 初始化任务**（迁移链、种子批、启动 upsert）——用于把「初始化任务」
 * 与「运行时逻辑」问题面切开定位。schema 已由带外工具建好（割接后常态
 * 无需 boot 重放），确需初始化时显式设 true。例外：运行时产品语义路径
 * （租户开通链的建租/重置/外链初始化——硬规则 13 裁定的自动灌场景）经
 * `migrateRdb` 的 `force: true` 选项绕过本开关——开关只闸 boot 自举，
 * 不闸用户操作触发的初始化。
 */
export function isInitDbEnabled(): boolean {
  return process.env.IS_INIT_DB === 'true'
}

/**
 * 由版本表名派生 PG advisory lock 键（2026-09-28 A6 并发锁）：FNV-1a 64 位
 * 散列取十进制串，直绑 `pg_advisory_lock(?::bigint)`。同表恒同键；异表撞
 * 键概率即 64 位散列碰撞概率（2^-64 量级，可忽略——撞键只造成额外串行，
 * 不影响正确性）。
 */
export function migrationAdvisoryLockKey(table: string): string {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < table.length; index++) {
    hash ^= BigInt(table.charCodeAt(index))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  // 收进 PG 有符号 bigint 正域（pg_advisory_lock 单键形走 int8）
  return (hash & 0x7fffffffffffffffn).toString(10)
}

/**
 * 进程内迁移互斥（2026-09-28 A6）：键=「库名+版本表名」，值为该键串行链
 * 的尾端 promise。同进程并发同链调用在此排队（先到者跑完整段，后到者重
 * 读簿记跳过已应用版本）；跨进程/跨入口的并发再由 PG advisory lock 兜底。
 * 链尾以 `.catch` 吸收前次拒绝——失败不毒化后续等待者；摘链走 finally，
 * 异常路径同样不残留。
 */
const inProcessLocks = new Map<string, Promise<unknown>>()

/** 在 `key` 上串行执行 `work`：同键并发排队，异键互不阻塞。 */
async function withInProcessLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = inProcessLocks.get(key)
  const gate = previous === undefined ? Promise.resolve() : previous.catch(() => {})
  const result = gate.then(work)
  inProcessLocks.set(key, result)
  try {
    return await result
  } finally {
    // 仍是链尾才摘除，防 Map 无界增长；已被后来者接手则保留其链
    if (inProcessLocks.get(key) === result) inProcessLocks.delete(key)
  }
}

/**
 * Apply every not-yet-applied migration in ascending version order. Each
 * version's statements run sequentially, and the version row is inserted
 * only after all of them succeed; a failure aborts the run fail-loud.
 *
 * 并发语义（2026-09-28 A6，pg_type 目录唯一冲突实证后补锁）：同库同链被
 * 两个服务入口并发执行时，双方都会读到同一份「已应用集」并各自重放 DDL，
 * 第二遍撞引擎目录唯一约束（CREATE TYPE 无 IF NOT EXISTS 即炸）→ 插件树
 * 拒启。现按方言双锁兜住：
 * - 进程内互斥（所有方言）：同进程同键并发先在此排队；
 * - PG advisory lock（postgresql 方言）：跨进程/跨入口并发由会话级
 *   `pg_advisory_lock` 互斥，锁键由版本表名派生（{@link
 *   migrationAdvisoryLockKey}）；持锁连接即迁移段执行连接（单会话，锁
 *   生命周期与段严格重合，且不占第二根池连接——池耗尽也不会自锁）；锁
 *   覆盖「读已应用集→逐版执行→写簿记」全段，异常路径 finally 释放。
 *   金仓（kingbase）同为 PG wire 但未纳入本锁——等其门控套件可跑再收。
 *
 * MySQL note: DDL carries an implicit commit, so a version whose statements
 * fail midway may leave partial DDL behind with no version row recorded.
 * Recover by repairing the schema manually, deleting the partial objects,
 * and re-running — the runner refuses to guess.
 * @param database - Target database (its provider's dialect owns the statements).
 * @param options - Bookkeeping table name and the full known migration list.
 * @returns resolution once the schema is at the highest known version.
 */
export async function migrateRdb(
  database: RdbDatabase,
  options: { readonly table: string; readonly migrations: RdbMigrations; readonly force?: boolean },
): Promise<void> {
  // force=true：绕过 IS_INIT_DB 总开关（租户开通链等运行时产品语义路径专用，
  // 见 isInitDbEnabled 注）；缺省仍受开关闸——IS_INIT_DB 非 'true' 时静默跳过。
  if (options.force !== true && !isInitDbEnabled()) return
  const { table } = options
  const migrations = resolveMigrations(database, options.migrations)
  if (!MIGRATION_TABLE_NAME_RE.test(table)) {
    throw new RdbError('invalid-identifier', `migration table name '${table}' violates ${MIGRATION_TABLE_NAME_RE}`)
  }
  // 键含库名：同名版本表挂在不同注册名库上互不阻塞（物理同库的跨入口
  // 并发交给 advisory lock 层）
  await withInProcessLock(`${database.name}:${table}`, () => runMigrationsUnderLock(database, table, migrations))
}

/** 持锁段：按方言选锁形态后跑迁移主体。 */
async function runMigrationsUnderLock(
  database: RdbDatabase,
  table: string,
  migrations: readonly RdbMigration[],
): Promise<void> {
  if (database.dialect === 'postgresql') {
    const lockKey = migrationAdvisoryLockKey(table)
    await database.withConnection(async conn => {
      await conn.query('SELECT pg_advisory_lock(?::bigint)', [lockKey])
      try {
        await applyMigrations(conn, table, migrations, database.name, database.dialect)
      } finally {
        // 异常路径同样必须释放，否则连接归还池后会话带着锁存活（池连接
        // 不销毁）；释放失败只吞不抛——此时连接多半已坏，会话终结即释放，
        // 原始迁移错误优先上抛。
        try {
          await conn.query('SELECT pg_advisory_unlock(?::bigint)', [lockKey])
        } catch { /* 连接已坏：会话随之终结，锁自动消失 */ }
      }
    })
    return
  }
  await applyMigrations(database, table, migrations, database.name, database.dialect)
}

/** 迁移主体：建簿记表→读已应用集→逐版执行→写簿记（executor 由持锁方提供；
 * 语句条目按 `dialect`（当前所连库方言）解析——方言分派组缺支 fail loud）。 */
async function applyMigrations(
  executor: MigrationExecutor,
  table: string,
  migrations: readonly RdbMigration[],
  databaseName: string,
  dialect: RdbDialectName,
): Promise<void> {
  await executor.query(`CREATE TABLE IF NOT EXISTS ${table} (version BIGINT NOT NULL PRIMARY KEY)`)
  const applied = new Set((await executor.query<{ version: number | string }>(`SELECT version FROM ${table}`))
    .map(row => Number(row.version)))
  const ordered = [...migrations].sort((a, b) => a.version - b.version)
  for (const migration of ordered) {
    if (applied.has(migration.version)) continue
    for (const element of migration.statements) {
      let group: readonly string[]
      try {
        group = resolveRdbStatements(element, dialect)
      } catch (error: unknown) {
        throw new RdbError(
          'migration-failed',
          `rdb migration to version ${migration.version} failed on database '${databaseName}': ${(error as Error).message}`,
          { cause: error },
        )
      }
      for (const statement of group) {
        try {
          await executor.query(statement)
        } catch (error: unknown) {
          throw new RdbError(
            'migration-failed',
            `rdb migration to version ${migration.version} failed on database '${databaseName}' while executing: ${statement}`,
            // The driver error is the diagnosis; surface it as the cause.
            { cause: error },
          )
        }
      }
    }
    await executor.execute(`INSERT INTO ${table} (version) VALUES (?)`, [migration.version])
  }
}
