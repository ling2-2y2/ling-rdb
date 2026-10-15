/**
 * 达梦 provider for the `ctx.rdb` hub（形态镜像 dsh-rdb-mysql）：一行挂
 * 一个命名库，eager 建池验连，注册即 effect。**无实例时勿挂 cordis.yml
 * 行**。dmdb 生态薄（官方方言只到 TypeORM/Knex），实例到位后首轮即
 * PoC 门：池行为 / `[{val}]` 绑定 / 事务模型 / 列名大小写折叠。
 * @module dsh-rdb-dm
 */

import type { Context } from '@ling2/ling-cordis'
import { schemastery as z } from '@ling2/ling-cordis'
import { rdbDatabaseServiceKey } from '../index.ts'
import { DmRdbDatabase, type DmRdbDatabaseOptions } from './database.ts'
import { toDmConnectString } from './translate.ts'

export { DmRdbDatabase } from './database.ts'
export type { DmRdbDatabaseOptions } from './database.ts'
export { toDmConnectString, toDmSql, toDmBinds } from './translate.ts'

/** Cordis plugin name. */
export const name = 'rdb-dm'
/** The provider registers on the rdb hub. */
export const inject = ['rdb']

/** Plugin configuration. */
export interface Config {
  /** Registry name consumers resolve this database by, e.g. `dm_main`. */
  database: string
  /** 连接 URL `dm://user:pwd@host:port`（或原生 connectString，可带参数）。 */
  url: string
  /** Maximum simultaneous pool connections; defaults to 4. */
  poolMax?: number
  /** Minimum pool connections; defaults to 0. */
  poolMin?: number
  /** Log every executed SQL statement (SQL, params, duration) at `rdb-dm` debug level; defaults to false. */
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
 * Open one DM database and register it on the hub. The disposer
 * unregisters the name first, then closes the pool.
 * @param ctx - Plugin context (must inject `rdb`).
 * @param config - Validated plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = ctx.logger('rdb-dm')
  const database = new DmRdbDatabase({
    name: config.database,
    connectString: toDmConnectString(config.url),
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
  }, 'rdb-dm.registerDatabase')
  ctx.provide(rdbDatabaseServiceKey(config.database), database)
}
