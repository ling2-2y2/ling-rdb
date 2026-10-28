/**
 * Oracle provider for the `ctx.rdb` hub（形态镜像 mysql provider）：一行挂
 * 一个命名库，apply 内 eager 建池验连（不可达/凭据错误在装载时点拒绝整
 * 行），注册即 effect（先除名后关池）。**无实例时勿挂 cordis.yml 行**。
 * 事务模型为隐式开启（每语句 autoCommit:false，首语句开事务）。
 * @module @ling2/ling-rdb-oracle
 */

import type { Context } from '@ling2/ling-coris'
import { schemastery as z } from '@ling2/ling-coris'
import { rdbDatabaseServiceKey } from '../index.ts'
import { OracleRdbDatabase, type OracleRdbDatabaseOptions } from './database.ts'
import { parseOracleUrl } from './translate.ts'

export { OracleRdbDatabase } from './database.ts'
export type { OracleRdbDatabaseOptions } from './database.ts'
export { parseOracleUrl, toOracleSql } from './translate.ts'

/** Cordis plugin name. */
export const name = 'rdb-oracle'
/** The provider registers on the rdb hub. */
export const inject = ['rdb']

/** Plugin configuration. */
export interface Config {
  /** Registry name consumers resolve this database by, e.g. `oracle_main`. */
  database: string
  /** Connection URL `oracle://user:pwd@host:port/service`（或原生 connectString）。 */
  url: string
  /** Maximum simultaneous pool connections; defaults to 4. */
  poolMax?: number
  /** Minimum pool connections; defaults to 0. */
  poolMin?: number
  /** Log every executed SQL statement (SQL, params, duration) at `rdb-oracle` debug level; defaults to false. */
  logQueries?: boolean
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  database: z.string().required(),
  url: z.string().required(),
  poolMax: z.number().step(1).min(1).max(64).default(4),
  poolMin: z.number().step(1).min(0).max(64).default(0),
  logQueries: z.boolean().default(false),
})

/**
 * Open one Oracle database and register it on the hub. The disposer
 * unregisters the name first, then closes the pool.
 * @param ctx - Plugin context (must inject `rdb`).
 * @param config - Validated plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = ctx.logger('rdb-oracle')
  const { user, password, connectString } = parseOracleUrl(config.url)
  const database = new OracleRdbDatabase({
    name: config.database,
    connectString,
    user,
    password,
    poolMax: config.poolMax ?? 4,
    poolMin: config.poolMin ?? 0,
    debug: config.logQueries
      ? (sql, params, elapsedMs) => logger.debug('%s %o (%dms)', sql, params, elapsedMs)
      : undefined,
  })
  await database.open()
  ctx.effect(() => {
    const dispose = ctx.rdb.database.register(config.database, database)
    return async () => {
      dispose()
      await database.close()
    }
  }, 'rdb-oracle.registerDatabase')
  ctx.provide(rdbDatabaseServiceKey(config.database), database)
}
