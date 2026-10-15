/**
 * 达梦 DM8 实现 of the RdbDatabase facade：dmdb 驱动连接池（connectString
 * 强制 `autoCommit=false`），事务隐式开启 + `commit()/rollback()` 收口
 * （`beginTransaction()` 为语义占位）。语句入口统一 `?` 占位符，传输层
 * 翻译为 `:n` 并塑形 `[{val}]` 绑定；行返回 `OUT_FORMAT_OBJECT` 键值形态。
 * @module @ling2/ling-rdb-dm/src/database
 */
import * as dmdb from 'dmdb'
import type { RdbConnection, RdbDatabase, RdbWriteResult } from '../hub/types.ts'
import { toDmBinds, toDmSql } from './translate.ts'

/** 每语句执行选项：对象行（键=列名）。autoCommit 已由连接串关闭。 */
const EXECUTE_OPTIONS = { outFormat: dmdb.OUT_FORMAT_OBJECT } as const

/** 调试汇（与 mysql provider 的 SqlDebugSink 同契约）。 */
export type SqlDebugSink = (sql: string, params: readonly unknown[] | undefined, elapsedMs: number) => void

/** 池选项（provider 行 config 解析产物）。 */
export interface DmRdbDatabaseOptions {
  /** 注册表挂载名。 */
  readonly name: string
  /** 达梦 connectString（已含 `autoCommit=false`）。 */
  readonly connectString: string
  /** 池内最大连接数。 */
  readonly poolMax: number
  /** 池内最小连接数。 */
  readonly poolMin: number
  /** 每语句调试汇；缺省关闭 SQL 日志。 */
  readonly debug?: SqlDebugSink
}

/** dmdb 连接 → RdbConnection 适配。 */
class DmRdbConnection implements RdbConnection {
  constructor(
    private readonly conn: dmdb.Connection,
    private readonly debug?: SqlDebugSink,
  ) {}

  async query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> {
    const start = Date.now()
    try {
      const result = await this.conn.execute(toDmSql(sql), toDmBinds(params), EXECUTE_OPTIONS)
      if (Array.isArray(result.rows)) return result.rows as readonly T[]
      return { rows: [], rowsAffected: result.rowsAffected } as unknown as readonly T[]
    } finally {
      this.debug?.(sql, params, Date.now() - start)
    }
  }

  async execute(sql: string, params?: readonly unknown[]): Promise<RdbWriteResult> {
    const start = Date.now()
    try {
      const result = await this.conn.execute(toDmSql(sql), toDmBinds(params), EXECUTE_OPTIONS)
      return { affectedRows: Number(result.rowsAffected ?? 0), insertId: 0 }
    } finally {
      this.debug?.(sql, params, Date.now() - start)
    }
  }

  async beginTransaction(): Promise<void> {
    // 达梦事务隐式开启（连接串 autoCommit=false），无显式 BEGIN。
  }

  async commit(): Promise<void> {
    await this.control('COMMIT', () => this.conn.commit())
  }

  async rollback(): Promise<void> {
    await this.control('ROLLBACK', () => this.conn.rollback())
  }

  private async control(label: string, run: () => Promise<void>): Promise<void> {
    const start = Date.now()
    try {
      await run()
    } finally {
      this.debug?.(label, undefined, Date.now() - start)
    }
  }
}

/** hub 上的一个达梦命名库（懒开池 + eager 首连验证 + 幂等关池）。 */
export class DmRdbDatabase implements RdbDatabase {
  readonly dialect = 'dm' as const

  private pool!: dmdb.Pool
  private ready: Promise<void> | undefined
  private closing: Promise<void> | undefined

  constructor(private readonly options: DmRdbDatabaseOptions) {}

  get name(): string {
    return this.options.name
  }

  /** 物理身份：scheme + connectString（不含凭据——凭据在串内，不出日志）。 */
  get identity(): string {
    return `dm:${this.options.connectString.replace(/\/\/[^@]*@/u, '//***@')}`
  }

  /** 懒开池并验证首连（fail loud）。 */
  open(): Promise<void> {
    this.ready ??= this.openPool()
    return this.ready
  }

  private async openPool(): Promise<void> {
    const pool = await dmdb.createPool({
      connectString: this.options.connectString,
      poolMax: this.options.poolMax,
      poolMin: this.options.poolMin,
      testOnBorrow: true,
    })
    try {
      const conn = await pool.getConnection()
      await conn.close()
    } catch (error: unknown) {
      void pool.close().catch(() => {})
      throw error
    }
    this.pool = pool
  }

  async query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> {
    await this.open()
    return this.withConnection(conn => conn.query<T>(sql, params))
  }

  async execute(sql: string, params?: readonly unknown[]): Promise<RdbWriteResult> {
    await this.open()
    return this.withConnection(conn => conn.execute(sql, params))
  }

  async withConnection<T>(work: (conn: RdbConnection) => Promise<T>): Promise<T> {
    await this.open()
    const conn = await this.pool.getConnection()
    const wrapped = new DmRdbConnection(conn, this.options.debug)
    try {
      return await work(wrapped)
    } finally {
      await conn.close()
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
    await this.pool.close()
  }
}
