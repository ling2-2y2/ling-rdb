/**
 * dsh-orm——Kysely 语句构造层跑在 dsh-rdb hub 上（纯库，无 cordis 行）。
 *
 * 消费形态：`kyselyFor(database)` 按 `database.dialect` 分派出 Kysely
 * 实例；全部 SQL 经 RdbDatabase 门面执行（池/事务/debug sink/租户包装
 * 零旁路）。Oracle/达梦族自动附带分页改写插件（limit→fetch）。
 *
 * 版本纪律：kysely 0.x semver，**exact pin 0.29.5**，升级走专门批次。
 * @module dsh-orm
 */
import { Kysely, DynamicModule } from 'kysely'
import type { Dialect } from 'kysely'
import type { RdbConnection, RdbDatabase } from '../types.ts'
import { mysqlRdbDialect } from './dialects/mysql.ts'
import { kingbaseRdbDialect } from './dialects/kingbase.ts'
import { OracleFamilyPlugin, oracleFamilyRdbDialect } from './dialects/oracle.ts'
import { RdbKyselyBoundDriver } from './driver.ts'

// 消费方（如 dsh-demo）不直接 import 'kysely'（kysely 只装在本包
// node_modules）——类型与 sql 模板从这里再出口。
export type { Kysely, SelectQueryBuilder } from 'kysely'
export { sql } from 'kysely'

export { RdbKyselyDriver, RdbKyselyConnection, RdbKyselyBoundDriver } from './driver.ts'
export { mysqlRdbDialect } from './dialects/mysql.ts'
export { KingbaseQueryCompiler, kingbaseRdbDialect } from './dialects/kingbase.ts'
export { OracleFamilyQueryCompiler, OracleFamilyPlugin, oracleFamilyRdbDialect } from './dialects/oracle.ts'

/** 运行时动态列/表引用（`new DynamicModule()` 实例再出口——0.29.5 无现成实例导出）。 */
export const dynamic = new DynamicModule()

/**
 * 为一个已挂载的数据库外观构造 Kysely 实例。泛型 DB 由消费者按表结构
 * 提供（静态表）或用 `any`/dynamic 模块（运行时动态表，visualdev 场景）。
 *
 * **事务绑定形态（2026-09-05（九）补）**：传入第二参 `connection`（外层
 * `db.transaction(async conn => …)` 的连接）即得到绑定该事务连接的实例
 * ——与 mbp 的 `mapper.use(conn)`、原生 `conn.execute` 在**同一事务字面量**
 * 里并用（方言分派仍按 `database.dialect`）。绑定实例自身的事务 API
 * fail loud（事务控制归外层门面）。
 * @typeParam DB - Kysely schema 类型（表名 → 列类型映射）。
 * @param database - 目标数据库外观（其 dialect 决定方言分派）。
 * @param connection - 可选：绑定的外层事务连接（`db.transaction` 回调参）。
 * @returns 就绪的 Kysely 实例（未建连——首条语句才取连接）。
 * @throws 不支持的方言名 fail loud（列出支持清单）。
 */
export function kyselyFor<DB = any>(database: RdbDatabase, connection?: RdbConnection): Kysely<DB> {
  // 未支持方言统一抛错形态（compile.spec 回归钉钉住含 database 名的全文）
  const unsupportedDialect = (dialect: unknown, name: string): Error =>
    new Error(`dsh-orm: 不支持的方言 '${String(dialect)}'（database '${name}'）——支持清单：mysql / kingbase / postgresql / oracle / dm`)
  const bind = (dialect: Dialect): Dialect => connection === undefined
    ? dialect
    : { ...dialect, createDriver: () => new RdbKyselyBoundDriver(connection) }
  switch (database.dialect) {
    case 'mysql':
      return new Kysely<DB>({ dialect: bind(mysqlRdbDialect(database)) })
    case 'kingbase':
    case 'postgresql':
      return new Kysely<DB>({ dialect: bind(kingbaseRdbDialect(database)) })
    case 'oracle':
    case 'dm':
      return new Kysely<DB>({
        dialect: bind(oracleFamilyRdbDialect(database, database.dialect)),
        plugins: [new OracleFamilyPlugin()],
      })
    // hub 方言联合含 sqlite 位而本 ORM 不提供——独立 case 保 default 的 never 穷尽收窄
    case 'sqlite':
      throw unsupportedDialect(database.dialect, database.name)
    default: {
      const unsupported: never = database.dialect
      throw unsupportedDialect(unsupported, database.name)
    }
  }
}
