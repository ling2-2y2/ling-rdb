/**
 * PostgreSQL provider for the `ctx.rdb` hub（形态镜像 kingbase provider/
 * mysql provider）：一行挂一个命名库，eager 建池验连，注册即 effect。
 * **实例缺席时勿挂 cordis.yml 行**（eager open 拒启动，与 oracle/dm/
 * kingbase 门控壳同一纪律）。首个消费方 = aip 域 weknora 复刻子系统
 * （库 `dsh_weknora`，ParadeDB 发行版实例——pg_search/pgvector/pg_trgm/
 * uuid-ossp 扩展齐备，weknora V1 基线 DDL 依赖它们）。
 * @module @ling2/ling-rdb-postgres
 */

import type { Context } from '@ling2/ling-cordis'
import { schemastery as z } from '@ling2/ling-cordis'
import { rdbDatabaseServiceKey } from '../index.ts'
import { PostgresRdbDatabase, type PostgresRdbDatabaseOptions } from './database.ts'

export { PostgresRdbDatabase } from './database.ts'
export type { PostgresRdbDatabaseOptions } from './database.ts'
export { toPostgresSql } from './translate.ts'

/** Cordis plugin name. */
export const name = 'rdb-postgres'
/** The provider registers on the rdb hub. */
export const inject = ['rdb']

/** Plugin configuration. */
export interface Config {
  /** Registry name consumers resolve this database by, e.g. `weknora`. */
  database: string
  /** PG 连接 URL：`postgres://user:pwd@host:port/dbname`。 */
  url: string
  /** Maximum simultaneous pool connections; defaults to 4. */
  poolMax?: number
  /** Minimum pool connections; defaults to 0. */
  poolMin?: number
  /** 客户端连接超时（ms）；默认 60000（与 mysql/kingbase provider 同窗宽）。 */
  connectTimeoutMs?: number
  /** Log every executed SQL statement (SQL, params, duration) at `rdb-postgres` debug level; defaults to false. */
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
 * Open one PostgreSQL database and register it on the hub. The disposer
 * unregisters the name first, then closes the pool.
 * @param ctx - Plugin context (must inject `rdb`).
 * @param config - Validated plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = ctx.logger('rdb-postgres')
  const database = new PostgresRdbDatabase({
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
  }, 'rdb-postgres.registerDatabase')
  ctx.provide(rdbDatabaseServiceKey(config.database), database)
}
