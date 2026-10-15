/**
 * 金仓 KingbaseES 实现 of the RdbDatabase facade：pg 驱动直连（金仓说
 * PG wire 协议，`postgres://` 连接串原生可读）。语句入口统一 `?` 占位
 * 符，传输层翻译为 `$n`；门面级 query/execute 走池级 `pool.query`（单
 * 语句自动取还连接），`withConnection`/事务持有独占 client 并以
 * `BEGIN/COMMIT/ROLLBACK` 收口。注意金仓 `sql_compatibility` 模式影响
 * 方言细节——实例 PoC 时确认（README 待办）。
 * @module dsh-rdb-kingbase/src/database
 */
import { Pool, type PoolClient, type PoolConfig, type QueryResult } from 'pg'
import type { RdbConnection, RdbDatabase, RdbWriteResult } from '../types.ts'
import { toKingbaseSql } from './translate.ts'

/** 调试汇（与 dsh-rdb-mysql 的 SqlDebugSink 同契约）。 */
export type SqlDebugSink = (sql: string, params: readonly unknown[] | undefined, elapsedMs: number) => void

/** 池选项（provider 行 config 解析产物）。 */
export interface KingbaseRdbDatabaseOptions {
  /** 注册表挂载名。 */
  readonly name: string
  /** PG 形态连接 URL：`postgres://user:pwd@host:port/dbname`。 */
  readonly url: string
  /** 池内最大连接数。 */
  readonly max: number
  /** 池内最小连接数。 */
  readonly min: number
  /** 客户端连接超时（ms）。 */
  readonly connectionTimeoutMillis: number
  /** 每语句调试汇；缺省关闭 SQL 日志。 */
  readonly debug?: SqlDebugSink
}

/** pg 查询结果 → RdbWriteResult（pg 无引擎自增键位，insertId 恒 0）。 */
function writeResult(result: QueryResult): RdbWriteResult {
  return { affectedRows: Number(result.rowCount ?? 0), insertId: 0 }
}

/** 独占 client → RdbConnection 适配（事务收口在 client 上）。 */
class KingbaseRdbConnection implements RdbConnection {
  constructor(
    private readonly client: PoolClient,
    private readonly debug?: SqlDebugSink,
  ) {}

  async query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> {
    const start = Date.now()
    try {
      const result = await this.client.query(toKingbaseSql(sql), params as unknown[] | undefined)
      return result.rows as readonly T[]
    } finally {
      this.debug?.(sql, params, Date.now() - start)
    }
  }

  async execute(sql: string, params?: readonly unknown[]): Promise<RdbWriteResult> {
    const start = Date.now()
    try {
      return writeResult(await this.client.query(toKingbaseSql(sql), params as unknown[] | undefined))
    } finally {
      this.debug?.(sql, params, Date.now() - start)
    }
  }

  async beginTransaction(): Promise<void> {
    await this.control('BEGIN', () => this.client.query('BEGIN'))
  }

  async commit(): Promise<void> {
    await this.control('COMMIT', () => this.client.query('COMMIT'))
  }

  async rollback(): Promise<void> {
    await this.control('ROLLBACK', () => this.client.query('ROLLBACK'))
  }

  private async control(label: string, run: () => Promise<unknown>): Promise<void> {
    const start = Date.now()
    try {
      await run()
    } finally {
      this.debug?.(label, undefined, Date.now() - start)
    }
  }
}

/** hub 上的一个金仓名库（懒开池 + eager 首连验证 + 幂等关池）。 */
export class KingbaseRdbDatabase implements RdbDatabase {
  readonly dialect = 'kingbase' as const

  private pool!: InstanceType<typeof Pool>
  private ready: Promise<void> | undefined
  private closing: Promise<void> | undefined

  constructor(private readonly options: KingbaseRdbDatabaseOptions) {}

  get name(): string {
    return this.options.name
  }

  /** 物理身份：scheme + host + db（凭据不出现在 identity）。 */
  get identity(): string {
    const url = new URL(this.options.url)
    return `kingbase:${url.host}${url.pathname}`
  }

  /** 懒开池并验证首连（fail loud）。 */
  open(): Promise<void> {
    this.ready ??= this.openPool()
    return this.ready
  }

  private async openPool(): Promise<void> {
    // min 在部分 pg 版本 typings 缺席但运行时合法（镜像 provider-postgres 的池构造）
    const pool = new Pool({
      connectionString: this.options.url,
      max: this.options.max,
      min: this.options.min,
      connectionTimeoutMillis: this.options.connectionTimeoutMillis,
    } as PoolConfig)
    try {
      const client = await pool.connect()
      client.release()
    } catch (error: unknown) {
      void pool.end().catch(() => {})
      throw error
    }
    this.pool = pool
  }

  async query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> {
    await this.open()
    const start = Date.now()
    try {
      const result = await this.pool.query(toKingbaseSql(sql), params as unknown[] | undefined)
      return result.rows as readonly T[]
    } finally {
      this.options.debug?.(sql, params, Date.now() - start)
    }
  }

  async execute(sql: string, params?: readonly unknown[]): Promise<RdbWriteResult> {
    await this.open()
    const start = Date.now()
    try {
      return writeResult(await this.pool.query(toKingbaseSql(sql), params as unknown[] | undefined))
    } finally {
      this.options.debug?.(sql, params, Date.now() - start)
    }
  }

  async withConnection<T>(work: (conn: RdbConnection) => Promise<T>): Promise<T> {
    await this.open()
    const client = await this.pool.connect()
    const wrapped = new KingbaseRdbConnection(client, this.options.debug)
    try {
      return await work(wrapped)
    } finally {
      client.release()
    }
  }

  async transaction<T>(work: (conn: RdbConnection) => Promise<T>): Promise<T> {
    return this.withConnection(async conn => {
      await conn.beginTransaction()
      try {
        const value = await work(conn)
        await conn.commit()
        return value
      } catch (error: unknown) {
        try {
          await conn.rollback()
        } catch (rollbackError: unknown) {
          throw new AggregateError([error, rollbackError], 'transaction failed and rollback also failed')
        }
        throw error
      }
    })
  }

  /** 幂等关池；open 失败者池已关，无事可做。 */
  close(): Promise<void> {
    this.closing ??= this.doClose()
    return this.closing
  }

  private async doClose(): Promise<void> {
    if (this.ready === undefined) return
    try {
      await this.ready
    } catch {
      return
    }
    await this.pool.end()
  }
}
