/**
 * MySQL provider for the `ctx.rdb` hub. One roster row mounts one named
 * database (`config.database`) with its own pool; mounting the same source
 * twice under different names is the supported way to reach two databases
 * on one server. The provider opens eagerly inside `apply`, so an
 * unreachable server or refused credentials fail the row at load instead of
 * the first query.
 * @module dsh-rdb-mysql
 */

import type { Context } from '@ling2/ling-cordis'
import { schemastery as z } from '@ling2/ling-cordis'
import { rdbDatabaseServiceKey } from '../index.ts'
import { MysqlRdbDatabase } from './database.ts'

export { MysqlRdbDatabase } from './database.ts'
export type { MysqlRdbDatabaseOptions } from './database.ts'
// Ad-hoc 一次性连接（数据中心四模块：用户配置的外部库测试/DDL/查询）。
export { withAdhocMysql } from './adhoc.ts'
export type { AdhocMysqlOptions } from './adhoc.ts'

/** Cordis plugin name. */
export const name = 'rdb-mysql'
/** The provider registers on the rdb hub. */
export const inject = ['rdb']

/** Default simultaneous connections a provider row's pool may open. */
export const DEFAULT_CONNECTION_LIMIT = 4

/**
 * Default client-side handshake budget. Generous because harness boot
 * compiles ~136 plugin entries under tsx while the first pool connection is
 * established, and that compile load can starve the handshake past both the
 * mysql2 10s default and the server's own `connect_timeout` window.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000

/** Plugin configuration. */
export interface Config {
  /** Registry name consumers resolve this database by, e.g. `sessions`. */
  database: string
  /** Connection URL: `mysql://user:password@host:port/database`. */
  url: string
  /** Maximum simultaneous pool connections; defaults to 4. */
  connectionLimit?: number
  /** Client-side handshake budget in milliseconds; defaults to 60000. */
  connectTimeoutMs?: number
  /** Log every executed SQL statement (SQL, params, duration) at `rdb-mysql` debug level; defaults to false. */
  logQueries?: boolean
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  database: z.string().required(),
  url: z.string().required(),
  connectionLimit: z.number().step(1).min(1).max(64).default(DEFAULT_CONNECTION_LIMIT),
  connectTimeoutMs: z.number().step(1).min(1_000).max(600_000).default(DEFAULT_CONNECT_TIMEOUT_MS),
  logQueries: z.boolean().default(false),
})

/**
 * Open one MySQL database and register it on the hub. The disposer
 * unregisters the name first, then closes the pool.
 * @param ctx - Plugin context (must inject `rdb`).
 * @param config - Validated plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = ctx.logger('rdb-mysql')
  const debug = config.logQueries
    ? (sql: string, params: readonly unknown[] | undefined, elapsedMs: number) =>
        logger.debug('%s %o (%dms)', sql, params, elapsedMs)
    : undefined
  const database = new MysqlRdbDatabase({
    name: config.database,
    url: config.url,
    connectionLimit: config.connectionLimit ?? DEFAULT_CONNECTION_LIMIT,
    connectTimeoutMs: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    debug,
  })
  await database.open()
  ctx.effect(() => {
    const dispose = ctx.rdb.database.register(config.database, database)
    return async () => {
      dispose()
      await database.close()
    }
  }, 'rdb-mysql.registerDatabase')
  ctx.provide(rdbDatabaseServiceKey(config.database), database)
}
