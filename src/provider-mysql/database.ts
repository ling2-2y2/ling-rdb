/**
 * MySQL implementation of the {@link RdbDatabase} facade: one lazy-opened
 * mysql2 pool per provider row, connection-scoped transactions with rollback
 * aggregation, and normalized write results.
 * @module @ling2/ling-rdb-mysql/src/database
 */

import { createPool, type Pool, type PoolConnection, type ResultSetHeader } from 'mysql2/promise'
import type { RdbConnection, RdbDatabase, RdbWriteResult } from '../hub/types.ts'
import { connectWithRetry } from './pool.ts'

/**
 * Debug sink invoked after each executed statement (or transaction-control
 * call, labeled `BEGIN`/`COMMIT`/`ROLLBACK`) with its SQL text, bound
 * parameters, and duration. Fires in a `finally`, so failed executions log
 * too. The provider wires this from `ctx.logger`; absent disables SQL
 * logging for the database.
 */
export type SqlDebugSink = (sql: string, params: readonly unknown[] | undefined, elapsedMs: number) => void

/** Pool options resolved by the provider row's config. */
export interface MysqlRdbDatabaseOptions {
  /** Registry name this database mounts under. */
  readonly name: string
  /** Connection URL: `mysql://user:password@host:port/database`. */
  readonly url: string
  /** Maximum simultaneous connections the pool may open. */
  readonly connectionLimit: number
  /** Client-side handshake budget in milliseconds. */
  readonly connectTimeoutMs: number
  /**
   * Connection collation (mysql2's `charset` pool option). Defaults to
   * `utf8mb4_general_ci` — the collation every schema in this tree is
   * created with (the tenant CREATE DATABASE statement and the
   * externally provisioned management databases). mysql2's own default
   * is `utf8mb4_unicode_ci`, whose literals collation-mix against
   * general_ci columns.
   */
  readonly charset?: string
  /** Per-statement debug sink; absent disables SQL logging. */
  readonly debug?: SqlDebugSink
}

/**
 * Adapt one mysql2 connection (pool-scoped or transaction-scoped) to the
 * hub's connection contract; isolates consumers from mysql2 result tuples.
 */
class MysqlRdbConnection implements RdbConnection {
  constructor(private readonly conn: PoolConnection, private readonly debug?: SqlDebugSink) {}

  async query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> {
    const start = Date.now()
    try {
      // mysql2 的 values 形参按可变数组声明，hub 契约是 readonly——调用点断言放宽（运行时同值）
      const [rows] = await this.conn.query(sql, params as unknown[])
      return rows as unknown as readonly T[]
    } finally {
      this.debug?.(sql, params, Date.now() - start)
    }
  }

  async execute(sql: string, params?: readonly unknown[]): Promise<RdbWriteResult> {
    const start = Date.now()
    try {
      const [result] = await this.conn.execute(sql, params as any[])
      return writeResult(result)
    } finally {
      this.debug?.(sql, params, Date.now() - start)
    }
  }

  beginTransaction(): Promise<void> {
    return this.control('BEGIN', () => this.conn.beginTransaction())
  }

  commit(): Promise<void> {
    return this.control('COMMIT', () => this.conn.commit())
  }

  rollback(): Promise<void> {
    return this.control('ROLLBACK', () => this.conn.rollback())
  }

  /** Run one transaction-control call, logged like a statement. */
  private async control(label: string, run: () => Promise<void>): Promise<void> {
    const start = Date.now()
    try {
      await run()
    } finally {
      this.debug?.(label, undefined, Date.now() - start)
    }
  }
}

function writeResult(result: unknown): RdbWriteResult {
  const header = result as ResultSetHeader
  return {
    affectedRows: Number(header?.affectedRows ?? 0),
    insertId: Number(header?.insertId ?? 0),
  }
}

/** One named MySQL database on the hub, owning its connection pool. */
export class MysqlRdbDatabase implements RdbDatabase {
  readonly dialect = 'mysql' as const

  private pool!: Pool
  private ready: Promise<void> | undefined
  private closing: Promise<void> | undefined

  constructor(private readonly options: MysqlRdbDatabaseOptions) {}

  /** Registry name this database mounts under. */
  get name(): string {
    return this.options.name
  }

  /**
   * Connection URL — host-internal only (same-server derivations, like
   * the tenant provisioning flow that swaps the database segment);
   * carries credentials, so it never crosses an RPC face.
   */
  get url(): string {
    return this.options.url
  }

  /** Physical store identity: scheme, server, and database name from the URL. */
  get identity(): string {
    const url = new URL(this.options.url)
    return `mysql:${url.host}${url.pathname}`
  }

  /**
   * Lazily open the pool and verify the first connection, so an unreachable
   * server or refused credentials reject the opener rather than the first query.
   * @returns settlement of the database's one open operation.
   */
  open(): Promise<void> {
    this.ready ??= this.openPool()
    return this.ready
  }

  private async openPool(): Promise<void> {
    const pool = createPool({
      uri: this.options.url,
      connectionLimit: this.options.connectionLimit,
      connectTimeout: this.options.connectTimeoutMs,
      charset: this.options.charset ?? 'utf8mb4_general_ci',
      // BPL-16（2026-09-18 用户裁定全局修）：BIGINT/DECIMAL 按字符串读回——
      // JS Number 对 19 位雪花 id/大十进制丢尾数（>2^53），字符串直传无失真；
      // 写路径不受影响（mysql2 按绑定参数类型发送）。
      supportBigNumbers: true,
      bigNumberStrings: true,
    })
    try {
      const conn = await connectWithRetry(pool)
      conn.release()
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
      const [rows] = await this.pool.query(sql, params as unknown[])
      return rows as unknown as readonly T[]
    } finally {
      this.options.debug?.(sql, params, Date.now() - start)
    }
  }

  async execute(sql: string, params?: readonly unknown[]): Promise<RdbWriteResult> {
    await this.open()
    const start = Date.now()
    try {
      const [result] = await this.pool.execute(sql, params as any[])
      return writeResult(result)
    } finally {
      this.options.debug?.(sql, params, Date.now() - start)
    }
  }

  async withConnection<T>(work: (conn: RdbConnection) => Promise<T>): Promise<T> {
    await this.open()
    const conn = await this.pool.getConnection()
    const wrapped = new MysqlRdbConnection(conn, this.options.debug)
    try {
      return await work(wrapped)
    } finally {
      conn.release()
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
        return await rollback(conn, error)
      }
    })
  }

  /**
   * Idempotently release the pool; concurrent and repeated calls resolve
   * once teardown finishes. A database whose open failed already ended its
   * pool and has nothing further to release.
   * @returns resolution once the pool is ended.
   */
  close(): Promise<void> {
    this.closing ??= this.doClose()
    return this.closing
  }

  private async doClose(): Promise<void> {
    if (this.ready === undefined) return
    try {
      await this.ready
    } catch {
      // open() already ended its pool on failure; nothing further to close.
      return
    }
    await this.pool.end()
  }
}

/** Roll back and rethrow; a failed rollback aggregates both errors. */
async function rollback(conn: RdbConnection, error: unknown): Promise<never> {
  try {
    await conn.rollback()
  } catch (rollbackError: unknown) {
    throw new AggregateError([error, rollbackError], 'transaction failed and rollback also failed')
  }
  throw error
}
