/**
 * Kysely Driver 的 RdbDatabase 适配——把 Kysely 的连接生命周期全量映射到
 * hub 的事务门面上（方案文档 §6.4：租户层/事务/debug sink 全保留）。
 *
 * 租约模型：`acquireConnection` 经 `withConnection` 取得一条池连接，并用
 * 一个未决 Promise **占住**连接（withConnection 的 work 不结束，连接就
 * 不归还池），直到 Kysely 调 `releaseConnection` 才放行——Kysely 的连接
 * 提供器就是按 acquire/use/release 严格配对设计的，两者对齐。
 *
 * 语句出口统一为 `?` 位置占位符（RdbConnection 契约）；Oracle/达梦/金仓
 * 的编号占位符翻译由各 provider 在传输层完成（kit/placeholders）。
 * @module @ling2/ling-rdb/orm/driver
 */
import type { AbortableOperationOptions, CompiledQuery, DatabaseConnection, Driver, QueryResult, TransactionSettings } from 'kysely'
import type { RdbConnection, RdbDatabase } from '../hub/types.ts'

/** Kysely 查询结果里写路径的可选计数位（读路径恒为 rows）。 */
type DriverWriteShape = {
  rows?: unknown
  insertId?: unknown
  affectedRows?: unknown
  rowsAffected?: unknown
  rowCount?: unknown
}

/**
 * 把各 provider 的返回形态归一化为 Kysely QueryResult：读路径 = 行数组
 * （mysql 族直接数组；Oracle/达梦 `{rows}`）；写路径 = mysql 族 OkPacket
 * （insertId/affectedRows）、Oracle/达梦（rowsAffected）、PostgreSQL/金仓
 * （rowCount）三族收敛为 Kysely 的计数位。
 */
function normalizeDriverResult(raw: unknown): QueryResult<unknown> {
  if (Array.isArray(raw)) return { rows: raw }
  if (typeof raw !== 'object' || raw === null) return { rows: [] }
  const shape = raw as DriverWriteShape
  // 计数位以字面量一次成型——QueryResult 的计数位是只读属性，赋值式写法 tsc 拒绝
  if (Array.isArray(shape.rows)) {
    const affected = shape.rowsAffected ?? shape.rowCount
    return { rows: shape.rows, numAffectedRows: toCountBit(affected) }
  }
  const insertId = shape.insertId
  return {
    rows: [],
    numAffectedRows: toCountBit(shape.affectedRows ?? shape.rowsAffected ?? shape.rowCount),
    insertId:
      insertId !== undefined && insertId !== null && String(insertId) !== '0'
        ? BigInt(insertId as number | bigint)
        : undefined,
  }
}

/** 计数位收敛：null/undefined → undefined（写路径读侧消费 undefined 与缺位同义）。 */
function toCountBit(affected: unknown): bigint | undefined {
  return affected !== undefined && affected !== null ? BigInt(affected as number | bigint) : undefined
}

/** 一条租约连接：executeQuery 全部走 RdbConnection.query（事务内同一连接）。 */
export class RdbKyselyConnection implements DatabaseConnection {
  constructor(
    /** 租约持有的底层连接（Driver 的事务原语直接落在它上面）。 */
    readonly conn: RdbConnection,
    private readonly releaseLease: () => void,
  ) {}

  // 泛型签名对齐 kysely DatabaseConnection（基类声明为 <R>；行形态由调用面约束）
  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    // Update/Delete 走 execute 计数保真通道（U-1042 真机实证 2026-09-27）：各
    // provider 的 query() 顶层数组化返回行集（PG rowCount 丢弃）→ 写计数位
    // 恒缺 → kysely numUpdatedRows/numDeletedRows 恒 0，deleteApp 这类
    // 「0 行=not_found」判定误伤真删（假 not_found+事务回滚）。
    // ⚠️ 分派判据=SQL 形状而非 queryKind——kysely 0.29 的 CompiledQuery 实际
    // **不含** queryKind 字段（仅 sql/query/parameters/queryId，dist
    // compiled-query.js 实证；首版按 queryKind 分流在真实链路永假，终验轮
    // U-1042 复发实证）。Insert/Raw 仍走 query()——INSERT..RETURNING 需要
    // 行集回传；本树无 returning 消费。
    const sqlText = compiledQuery.sql.trimStart()
    const kind = (compiledQuery as { queryKind?: string }).queryKind
    if (kind === 'Update' || kind === 'Delete' || /^(delete|update)[ (]/i.test(sqlText)) {
      const w = await this.conn.execute(
        compiledQuery.sql,
        compiledQuery.parameters as readonly unknown[],
      )
      const count = toCountBit(w.affectedRows) ?? 0n
      // 计数位三名并给——kysely DeleteResult/UpdateResult 各读各的位，不依赖内部映射。
      return { rows: [], numAffectedRows: count, numUpdatedRows: count, numDeletedRows: count } as unknown as QueryResult<O>
    }
    const raw: unknown = await this.conn.query(
      compiledQuery.sql,
      compiledQuery.parameters as readonly unknown[],
    )
    return normalizeDriverResult(raw) as unknown as QueryResult<O>
  }

  /**
   * 流式查询门面——orm 不提供流式消费（无 `.stream()` 路径，分页/批量
   * 全走 query 出口）；触达即程序性错误，fail loud。
   */
  async *streamQuery<O>(
    _compiledQuery: CompiledQuery,
    _chunkSize: number,
    _options?: AbortableOperationOptions,
  ): AsyncIterableIterator<QueryResult<O>> {
    throw new Error('ling-rdb/orm: streamQuery 未支持——流式消费请改走 query 出口分页/批量')
  }

  /** 释放租约：withConnection 的 work 结束，连接归还池。 */
  release(): void {
    this.releaseLease()
  }
}

/**
 * 跑在 RdbDatabase 上的 Kysely Driver。连接池归 provider（destroy 不关
 * 池）；事务控制映射 RdbConnection 的同名方法。隔离级别/访问模式以
 * MySQL 语义先行下发 `set transaction`（作用于下一个事务），三库型真连
 * PoC 时按方言校准。
 */
export class RdbKyselyDriver implements Driver {
  constructor(private readonly database: RdbDatabase) {}

  async init(): Promise<void> {
    // 连接池由 provider 独占管理（插件行 eager open），无需初始化。
  }

  async acquireConnection(): Promise<RdbKyselyConnection> {
    return await new Promise<RdbKyselyConnection>((resolve, reject) => {
      let lease!: () => void
      const held = new Promise<void>(resolveLease => { lease = resolveLease })
      void this.database.withConnection(async conn => {
        const wrapper = new RdbKyselyConnection(conn, () => lease())
        resolve(wrapper)
        // 占住连接直到 Kysely 释放租约
        await held
      }).catch(reject)
    })
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    this.cast(connection).release()
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    const { conn } = this.cast(connection)
    if (settings.isolationLevel !== undefined || settings.accessMode !== undefined) {
      const parts: string[] = []
      if (settings.isolationLevel !== undefined) parts.push(`isolation level ${settings.isolationLevel}`)
      if (settings.accessMode !== undefined) parts.push(`${settings.accessMode}`)
      await conn.query(`set transaction ${parts.join(', ')}`)
    }
    await conn.beginTransaction()
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await this.cast(connection).conn.commit()
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await this.cast(connection).conn.rollback()
  }

  async destroy(): Promise<void> {
    // 池归 provider；插件行卸载时统一 close（先除名后关池）。
  }

  /** 同模块私类收敛：非租约连接进入即程序性错误，fail loud。 */
  private cast(connection: DatabaseConnection): RdbKyselyConnection {
    if (!(connection instanceof RdbKyselyConnection)) {
      throw new Error('rdb kysely driver: connection is not an RdbKyselyConnection lease')
    }
    return connection
  }
}

/**
 * **绑定既有事务连接**的 Kysely Driver（`kyselyFor(db, conn)` 的执行面，
 * 2026-09-05（九）补——mbp/Kysely/原生语句在同一 `db.transaction` 字面量
 * 里并用的入口）：acquire 恒返回外层事务的那条连接（空租约——连接的
 * 归还归外层事务门面，此处释放会把在途事务的连接错还回池）；事务原语
 * 一律 fail loud——实例已在外层事务内，嵌套 begin/commit/rollback 是
 * 程序性错误（要走事务请用外层 `db.transaction` 门面）。
 */
export class RdbKyselyBoundDriver implements Driver {
  constructor(private readonly conn: RdbConnection) {}

  async init(): Promise<void> {}

  async acquireConnection(): Promise<RdbKyselyConnection> {
    return new RdbKyselyConnection(this.conn, () => {})
  }

  async releaseConnection(): Promise<void> {
    // 空操作：连接归外层事务门面管理（释放 = 把在途事务连接错还回池）。
  }

  async beginTransaction(): Promise<void> {
    throw new Error('ling-rdb/orm: 连接绑定的 Kysely 实例已在外层事务内——直接执行语句即可；要控制事务请用外层 db.transaction 门面')
  }

  async commitTransaction(): Promise<void> {
    throw new Error('ling-rdb/orm: 连接绑定的 Kysely 实例已在外层事务内——提交归外层 db.transaction 门面')
  }

  async rollbackTransaction(): Promise<void> {
    throw new Error('ling-rdb/orm: 连接绑定的 Kysely 实例已在外层事务内——回滚归外层 db.transaction 门面')
  }

  async destroy(): Promise<void> {}
}
