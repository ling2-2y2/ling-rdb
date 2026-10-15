/**
 * Consumer-facing contracts of the relational database hub: one connection
 * shape, one database shape, and the normalization rules every provider
 * honors. SQL text itself stays consumer-owned — the hub standardizes
 * transport (placeholders, transactions, pooling), not query language.
 * @module @ling2/ling-rdb/hub/types
 */

/**
 * Engine family of a provider. Consumers branch on it only when a statement
 * cannot be expressed portably; dialect-neutral code never reads it.
 * `oracle`/`dm`/`kingbase` join the union for the migration-source database
 * family (2026-09-05, ORM adoption plan §6.6); providers translate the hub's
 * `?` positional placeholders per dialect before handing statements to the
 * native driver — see `placeholders.ts`.
 */
export type RdbDialectName = 'mysql' | 'postgresql' | 'sqlite' | 'oracle' | 'dm' | 'kingbase'

/**
 * Normalized write outcome. Providers map driver-native fields onto it
 * (mysql2 `affectedRows`/`insertId` pass through 1:1; `insertId` is 0 when
 * the engine reports none, e.g. after an UPDATE).
 */
export interface RdbWriteResult {
  /** Rows the statement changed (inserted, updated, or deleted). */
  readonly affectedRows: number
  /** Engine-generated key of the first inserted row, or 0 when absent. */
  readonly insertId: number
}

/**
 * One acquired connection. All work inside a transaction binds to the same
 * handle, so row locks and snapshots hold for the whole unit of work.
 */
export interface RdbConnection {
  /**
   * Client-interpolated query, matching mysql2 `conn.query`: usable for
   * dynamically assembled SQL (multi-row VALUES lists, DDL) and therefore
   * the path migrations take.
   * @param sql - Statement text with `?` placeholders.
   * @param params - Positional parameter values.
   * @returns rows as the driver decoded them (JSON columns already parsed,
   * datetime columns as the driver's date type).
   */
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>
  /**
   * Prepared-statement execution, matching mysql2 `conn.execute`.
   * @param sql - Statement text with `?` placeholders.
   * @param params - Positional parameter values.
   * @returns the normalized write outcome.
   */
  execute(sql: string, params?: readonly unknown[]): Promise<RdbWriteResult>
  /** Open a transaction on this connection; consumers usually prefer {@link RdbDatabase.transaction}. */
  beginTransaction(): Promise<void>
  /** Commit the open transaction. */
  commit(): Promise<void>
  /** Roll back the open transaction. */
  rollback(): Promise<void>
}

/**
 * One named relational database mounted on the hub. A provider row owns the
 * pool; consumers never see pool mechanics, only this facade.
 */
export interface RdbDatabase {
  /** Registry name this database is mounted under. */
  readonly name: string
  /** Engine family of the providing row. */
  readonly dialect: RdbDialectName
  /**
   * Stable identity of the physical store backing this database
   * (provider-defined, e.g. `mysql:host:3306/dbname`). Consumers embed it in
   * revisions so records originating from different stores never compare equal.
   */
  readonly identity: string
  /**
   * Run one client-interpolated query on a pool connection.
   * @param sql - Statement text with `?` placeholders.
   * @param params - Positional parameter values.
   * @returns rows as the driver decoded them.
   */
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>
  /**
   * Run one prepared statement on a pool connection.
   * @param sql - Statement text with `?` placeholders.
   * @param params - Positional parameter values.
   * @returns the normalized write outcome.
   */
  execute(sql: string, params?: readonly unknown[]): Promise<RdbWriteResult>
  /**
   * Acquire a connection for the duration of `work`; release in a `finally`
   * so both success and failure paths return it to the pool.
   * @param work - Unit of work bound to one connection.
   * @returns settlement of `work`.
   */
  withConnection<T>(work: (conn: RdbConnection) => Promise<T>): Promise<T>
  /**
   * `beginTransaction` → `work` → `commit`; when `work` rejects, roll back
   * and rethrow. A rollback that also fails aggregates both errors.
   * @param work - Unit of work bound to one transaction-scoped connection.
   * @returns settlement of `work`, or its rejection after a clean rollback.
   */
  transaction<T>(work: (conn: RdbConnection) => Promise<T>): Promise<T>
  /**
   * Idempotently release the pool. A database whose open failed has nothing
   * further to release.
   * @returns resolution once the provider's medium is released.
   */
  close(): Promise<void>
}
