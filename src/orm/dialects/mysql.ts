/**
 * MySQL 方言：全部复用 Kysely 内置件（MysqlAdapter/MysqlQueryCompiler/
 * MysqlIntrospector），仅驱动换成 {@link RdbKyselyDriver}。占位符天然是
 * `?`、标识符反引号引用——与 mysql2 传输层零翻译直通。
 * @module dsh-orm/src/dialects/mysql
 */
import type { DatabaseIntrospector, Dialect } from 'kysely'
import { MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler } from 'kysely'
import type { Kysely } from 'kysely'
import { RdbKyselyDriver } from '../driver.ts'
import type { RdbDatabase } from '../../types.ts'

/**
 * 组装跑在 RdbDatabase 上的 MySQL 方言。
 * @param database - 目标数据库外观（dialect 必须是 'mysql'）。
 * @returns Kysely Dialect。
 */
export function mysqlRdbDialect(database: RdbDatabase): Dialect {
  return {
    createDriver: () => new RdbKyselyDriver(database),
    createQueryCompiler: () => new MysqlQueryCompiler(),
    createAdapter: () => new MysqlAdapter(),
    createIntrospector: (db: Kysely<any>): DatabaseIntrospector => new MysqlIntrospector(db),
  }
}
