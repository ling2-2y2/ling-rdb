/**
 * 金仓 provider for the `ctx.rdb` hub（形态镜像 mysql provider）：一行挂
 * 一个命名库，eager 建池验连，注册即 effect。**无实例时勿挂 cordis.yml
 * 行**。金仓经 PG wire 协议直连；实例到位后首轮即 PoC 门：
 * `sql_compatibility` 模式确认 + 五用例壳。
 * @module @ling2/ling-rdb-kingbase
 */

import type { Context } from '@ling2/ling-coris'
import { schemastery as z } from '@ling2/ling-coris'
import { rdbDatabaseServiceKey } from '../index.ts'
import { KingbaseRdbDatabase, type KingbaseRdbDatabaseOptions } from './database.ts'

export { KingbaseRdbDatabase } from './database.ts'
export type { KingbaseRdbDatabaseOptions } from './database.ts'
export { toKingbaseSql } from './translate.ts'

/** Cordis plugin name. */
export const name = 'rdb-kingbase'
/** The provider registers on the rdb hub. */
export const inject = ['rdb']

/** Plugin configuration. */
export interface Config {
  /** Registry name consumers resolve this database by, e.g. `kingbase_main`. */
  database: string
  /** PG 形态连接 URL：`postgres://user:pwd@host:port/dbname`。 */
  url: string
  /** Maximum simultaneous pool connections; defaults to 4. */
  poolMax?: number
  /** Minimum pool connections; defaults to 0. */
  poolMin?: number
  /** 客户端连接超时（ms）；默认 60000（与 mysql provider 同窗宽）。 */
  connectTimeoutMs?: number
  /** Log every executed SQL statement (SQL, params, duration) at `rdb-kingbase` debug level; defaults to false. */
  logQueries?: boolean
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  database: z.string().required(),
  url: z.string().required(),
  poolMax: z.number().step(1).min(1).max(64).default(4),
  poolMin: z.number().step(1).min(0).max(64).default(0),
  connectTimeoutMs: z.number().step(1).min(1_000).max(600_000).default(60_000),
  logQueries: z.boolean().default(false),
})

/**
 * Open one KingbaseES database and register it on the hub. The disposer
 * unregisters the name first, then closes the pool.
 * @param ctx - Plugin context (must inject `rdb`).
 * @param config - Validated plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = ctx.logger('rdb-kingbase')
  const database = new KingbaseRdbDatabase({
    name: config.database,
    url: config.url,
    max: config.poolMax ?? 4,
    min: config.poolMin ?? 0,
    connectionTimeoutMillis: config.connectTimeoutMs ?? 60_000,
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
  }, 'rdb-kingbase.registerDatabase')
  ctx.provide(rdbDatabaseServiceKey(config.database), database)
}
