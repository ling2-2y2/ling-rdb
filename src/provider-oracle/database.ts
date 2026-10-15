/**
 * Oracle 实现 of the RdbDatabase facade：oracledb thin 模式连接池（要求
 * Oracle ≥12.1；11g 需 thick+Instant Client，PoC 时确认）。事务模型 =
 * **隐式开启**：每条 execute 显式 `autoCommit:false`，首个语句即开启事
 * 务，`commit()/rollback()` 收口（`beginTransaction()` 为语义占位）。
 * 语句入口统一 `?` 占位符，传输层翻译为 `:n`。
 * @module @ling2/ling-rdb-oracle/src/database
 */
import oracledb, { type Pool, type Connection } from 'oracledb'
import type { RdbConnection, RdbDatabase, RdbWriteResult } from '../hub/types.ts'
import { toOracleSql } from './translate.ts'

/** 每语句执行选项：对象行 + 关闭自动提交（事务由门面收口）。 */
const EXECUTE_OPTIONS: oracledb.ExecuteOptions = {
  outFormat: oracledb.OUT_FORMAT_OBJECT,
  autoCommit: false,
}

/** 调试汇（与 mysql provider 的 SqlDebugSink 同契约）。 */
export type SqlDebugSink = (sql: string, params: readonly unknown[] | undefined, elapsedMs: number) => void

/** 池选项（provider 行 config 解析产物）。 */
export interface OracleRdbDatabaseOptions {
  /** 注册表挂载名。 */
  readonly name: string
  /** oracledb connectString（`host:port/service` 或 EZConnect 串）。 */
  readonly connectString: string
  /** 登录用户名。 */
  readonly user: string
  /** 登录密码。 */
  readonly password: string
  /** 池内最大连接数。 */
  readonly poolMax: number
  /** 池内最小连接数。 */
  readonly poolMin: number
  /** 每语句调试汇；缺省关闭 SQL 日志。 */
  readonly debug?: SqlDebugSink
}

/** oracledb 连接 → RdbConnection 适配（事务隐式开启模型）。 */
class OracleRdbConnection implements RdbConnection {
  constructor(private readonly conn: Connection, private readonly debug?: SqlDebugSink) {}

  async query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> {
    const start = Date.now()
    try {
      const result = await this.conn.execute(toOracleSql(sql), (params ?? []) as oracledb.BindParameters, EXECUTE_OPTIONS)
      // 写路径：rows 缺省，返回带 rowsAffected 的形态（orm 归一化消费）
      if (Array.isArray(result.rows)) return result.rows as readonly T[]
      return { rows: [], rowsAffected: result.rowsAffected } as unknown as readonly T[]
    } finally {
      this.debug?.(sql, params, Date.now() - start)
    }
  }

  async execute(sql: string, params?: readonly unknown[]): Promise<RdbWriteResult> {
    const start = Date.now()
    try {
      const result = await this.conn.execute(toOracleSql(sql), (params ?? []) as oracledb.BindParameters, EXECUTE_OPTIONS)
      return { affectedRows: Number(result.rowsAffected ?? 0), insertId: 0 }
    } finally {
      this.debug?.(sql, params, Date.now() - start)
    }
  }

  async beginTransaction(): Promise<void> {
    // Oracle 事务隐式开启（autoCommit:false 下首语句即开启），无显式 BEGIN。
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

/** hub 上的一个 Oracle 命名库（懒开池 + eager 首连验证 + 幂等关池）。 */
export class OracleRdbDatabase implements RdbDatabase {
  readonly dialect = 'oracle' as const

  private pool!: Pool
  private ready: Promise<void> | undefined
  private closing: Promise<void> | undefined

  constructor(private readonly options: OracleRdbDatabaseOptions) {}

  get name(): string {
    return this.options.name
  }

  /** 物理身份：scheme + connectString。 */
  get identity(): string {
    return `oracle:${this.options.connectString}`
  }

  /** 懒开池并验证首连（fail loud：拒不可达/凭据错误于 open 时点）。 */
  open(): Promise<void> {
    this.ready ??= this.openPool()
    return this.ready
  }

  private async openPool(): Promise<void> {
    // enableQueue 取 oracledb 缺省 true（池忙时请求排队），7.x typings 已移除该显式键
    const pool = await oracledb.createPool({
      user: this.options.user,
      password: this.options.password,
      connectString: this.options.connectString,
      poolMin: this.options.poolMin,
      poolMax: this.options.poolMax,
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
    const wrapped = new OracleRdbConnection(conn, this.options.debug)
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
