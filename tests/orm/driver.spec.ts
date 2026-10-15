/**
 * RdbKyselyDriver 单测（无服务器）：租约生命周期映射（acquire→
 * withConnection 占住 / release→归还）、executeQuery 参数透传、写返回
 * 三族形态归一化（OkPacket/rowsAffected/rowCount）、事务原语落点、
 * 非租约连接 fail loud。fake 复用 dsh-rdb registry.spec 的手写范式。
 * @module dsh-orm/tests/driver.spec
 */
import { describe, expect, it } from 'vitest'
import type { RdbConnection, RdbDatabase, RdbWriteResult } from '../../src/types.ts'
import { RdbKyselyBoundDriver, RdbKyselyConnection, RdbKyselyDriver } from '../../src/orm/driver.ts'

/** 录制型 fake：withConnection 的 work 完成时刻 = 租约归还时刻。 */
function fakeDatabase(dialect: RdbDatabase['dialect'] = 'mysql'): {
  db: RdbDatabase
  calls: Array<{ sql: string; params?: readonly unknown[] }>
  events: string[]
} {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
  const events: string[] = []
  const conn: RdbConnection = {
    query: async (sql, params) => { calls.push({ sql, params }); return [] },
    execute: async (sql, params): Promise<RdbWriteResult> => { calls.push({ sql, params }); return { affectedRows: 0, insertId: 0 } },
    beginTransaction: async () => { events.push('BEGIN') },
    commit: async () => { events.push('COMMIT') },
    rollback: async () => { events.push('ROLLBACK') },
  }
  const db: RdbDatabase = {
    name: 'fake', dialect, identity: 'fake:1',
    query: conn.query.bind(null) as never,
    execute: conn.execute,
    withConnection: async work => { events.push('ACQUIRE'); await work(conn); events.push('RELEASE') },
    transaction: async work => {
      events.push('BEGIN')
      try { const value = await work(conn); events.push('COMMIT'); return value }
      catch (error) { events.push('ROLLBACK'); throw error }
    },
    close: async () => { events.push('CLOSE') },
  }
  db.query = async (sql, params) => { calls.push({ sql, params }); return [] }
  return { db, conn, calls, events }
}

describe('RdbKyselyDriver', () => {
  it('acquireConnection 占住 withConnection 连接，releaseConnection 才归还', async () => {
    const { db, events } = fakeDatabase()
    const driver = new RdbKyselyDriver(db)
    const connection = await driver.acquireConnection()
    await Promise.resolve()
    expect(events).toEqual(['ACQUIRE'])
    await driver.releaseConnection(connection)
    await Promise.resolve()
    expect(events).toEqual(['ACQUIRE', 'RELEASE'])
  })

  it('executeQuery 把编译语句与参数原样透传给 RdbConnection.query', async () => {
    const { db, calls } = fakeDatabase()
    const driver = new RdbKyselyDriver(db)
    const connection = await driver.acquireConnection()
    await connection.executeQuery({ sql: 'select f_id from base_role where f_en_code = ?', parameters: ['admin'], query: {} as never } as never)
    expect(calls).toEqual([{ sql: 'select f_id from base_role where f_en_code = ?', params: ['admin'] }])
    await driver.releaseConnection(connection)
  })

  it('写返回归一化：mysql OkPacket → insertId/numAffectedRows（BigInt）', async () => {
    const { db } = fakeDatabase()
    const conn = { query: async () => ({ insertId: 42, affectedRows: 1, changedRows: 1 }) } as unknown as RdbConnection
    const wrapper = new RdbKyselyConnection(conn, () => {})
    const result = await wrapper.executeQuery({ sql: 'insert …', parameters: [] } as never)
    expect(result.insertId).toBe(42n)
    expect(result.numAffectedRows).toBe(1n)
    expect(result.rows).toEqual([])
  })

  it('写返回归一化：Oracle/达梦 rowsAffected → numAffectedRows，insertId=0 视为缺省', async () => {
    // U-1042 后写语句（delete/update 前缀）经 execute 通道——conn 需带 execute
    const conn = { execute: async () => ({ affectedRows: 3, insertId: 0 }) } as unknown as RdbConnection
    const wrapper = new RdbKyselyConnection(conn, () => {})
    const result = await wrapper.executeQuery({ sql: 'delete …', parameters: [] } as never)
    expect(result.numAffectedRows).toBe(3n)
    expect(result.insertId).toBeUndefined()
  })

  it('写返回归一化：pg/金仓 rowCount → numAffectedRows；读数组直通 rows', async () => {
    const write = new RdbKyselyConnection({ query: async () => ({ rowCount: 2, rows: [] }) } as unknown as RdbConnection, () => {})
    expect((await write.executeQuery({ sql: '', parameters: [] } as never)).numAffectedRows).toBe(2n)
    const read = new RdbKyselyConnection({ query: async () => [{ f_id: '1' }] } as unknown as RdbConnection, () => {})
    expect((await read.executeQuery({ sql: '', parameters: [] } as never)).rows).toEqual([{ f_id: '1' }])
  })

  it('U-1042 回归钉：Update/Delete 走 execute 计数保真通道（query() 数组化丢 rowCount 曾致假 not_found+回滚）', async () => {
    const calls: Array<{ sql: string; via?: string }> = []
    const conn = {
      query: async (sql: string) => { calls.push({ sql }); return [] },
      execute: async (sql: string): Promise<RdbWriteResult> => { calls.push({ sql, via: 'execute' }); return { affectedRows: 1, insertId: 0 } },
    } as unknown as RdbConnection
    const wrapper = new RdbKyselyConnection(conn, () => {})
    // 真实 kysely CompiledQuery 不带 queryKind（dist compiled-query.js 实证）——
    // 分派判据=SQL 形状，两例均**不带** queryKind。
    const del = await wrapper.executeQuery({ sql: 'delete from apps where id = $1', parameters: ['x'], query: {} } as never)
    expect(del.numDeletedRows).toBe(1n)
    expect(del.numAffectedRows).toBe(1n)
    const upd = await wrapper.executeQuery({ sql: 'update t set a = 1', parameters: [], query: {} } as never)
    expect(upd.numUpdatedRows).toBe(1n)
    // Insert 仍走 query()（INSERT..RETURNING 行集保留）；读语句（select）同。
    await wrapper.executeQuery({ sql: 'insert into t () values ()', parameters: [], query: {}, queryKind: 'Insert' } as never)
    await wrapper.executeQuery({ sql: 'select 1', parameters: [], query: {} } as never)
    expect(calls.filter(c => c.via === 'execute')).toHaveLength(2)
    expect(calls.filter(c => c.via === undefined)).toHaveLength(2)
  })

  it('U-1042 加成钉：显式 queryKind（若未来 kysely 补字段）与 SQL 前缀分派并轨', async () => {
    const conn = {
      query: async () => [],
      execute: async (): Promise<RdbWriteResult> => ({ affectedRows: 3, insertId: 0 }),
    } as unknown as RdbConnection
    const wrapper = new RdbKyselyConnection(conn, () => {})
    const del = await wrapper.executeQuery({ sql: 'delete from x', parameters: [], query: {}, queryKind: 'Delete' } as never)
    expect(del.numDeletedRows).toBe(3n)
    // Insert/Raw/Select 仍走 query()（INSERT..RETURNING 行集保留）。
    await wrapper.executeQuery({ sql: 'insert into t () values ()', parameters: [], query: {}, queryKind: 'Insert' } as never)
    await wrapper.executeQuery({ sql: 'select 1', parameters: [], query: {}, queryKind: 'Select' } as never)
  })

  it('事务原语映射到租约连接的 RdbConnection', async () => {
    const { db, events } = fakeDatabase()
    const driver = new RdbKyselyDriver(db)
    const connection = await driver.acquireConnection()
    await driver.beginTransaction(connection, {})
    await driver.commitTransaction(connection)
    const second = await driver.acquireConnection()
    await driver.beginTransaction(second, {})
    await driver.rollbackTransaction(second)
    await driver.releaseConnection(connection)
    await driver.releaseConnection(second)
    expect(events.filter(e => e !== 'ACQUIRE' && e !== 'RELEASE')).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK'])
  })

  it('beginTransaction 带隔离级别时先下发 set transaction', async () => {
    const { db, calls } = fakeDatabase()
    const driver = new RdbKyselyDriver(db)
    const connection = await driver.acquireConnection()
    await driver.beginTransaction(connection, { isolationLevel: 'repeatable read' })
    expect(calls[0]?.sql).toBe('set transaction isolation level repeatable read')
    await driver.releaseConnection(connection)
  })

  it('非租约连接进入事务原语时 fail loud', async () => {
    const { db } = fakeDatabase()
    const driver = new RdbKyselyDriver(db)
    await expect(driver.commitTransaction({ executeQuery: async () => ({ rows: [] }) } as never))
      .rejects.toThrow('connection is not an RdbKyselyConnection lease')
  })
})

describe('RdbKyselyBoundDriver（事务连接绑定形态，2026-09-05（九））', () => {
  it('acquire 恒返回外层连接且空租约——release 不触发任何池事件', async () => {
    const { conn, events } = fakeDatabase()
    const driver = new RdbKyselyBoundDriver(conn)
    const connection = await driver.acquireConnection()
    await driver.releaseConnection(connection)
    await Promise.resolve()
    // 全程不出现 ACQUIRE/RELEASE（连接归外层事务门面，驱动不动池）
    expect(events).toEqual([])
  })

  it('executeQuery 语句落在绑定的外层连接上（同事务混用的执行面）', async () => {
    const { conn, calls } = fakeDatabase()
    const driver = new RdbKyselyBoundDriver(conn)
    const connection = await driver.acquireConnection()
    await connection.executeQuery({ sql: 'select 1 where f_id = ?', parameters: ['x'], query: {} as never } as never)
    expect(calls).toEqual([{ sql: 'select 1 where f_id = ?', params: ['x'] }])
  })

  it('事务原语 fail loud（事务控制归外层 db.transaction 门面）', async () => {
    const { conn } = fakeDatabase()
    const driver = new RdbKyselyBoundDriver(conn)
    await expect(driver.beginTransaction()).rejects.toThrow(/外层事务内/)
    await expect(driver.commitTransaction()).rejects.toThrow(/外层事务内/)
    await expect(driver.rollbackTransaction()).rejects.toThrow(/外层事务内/)
  })
})
