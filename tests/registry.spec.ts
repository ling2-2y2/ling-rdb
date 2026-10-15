/**
 * Hub registry and migration-runner tests against an in-memory fake
 * database: no server required.
 * @module @ling2/ling-rdb/tests/registry
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RdbError } from '../src/hub/error.ts'
import { migrateRdb } from '../src/hub/migrate.ts'
import { RdbDatabaseRegistry } from '../src/hub/registry.ts'
import type { RdbConnection, RdbDatabase, RdbWriteResult } from '../src/hub/types.ts'

function fakeDatabase(name: string): RdbDatabase & { log: string[] } {
  const log: string[] = []
  const conn: RdbConnection = {
    async query<T = unknown>(sql: string): Promise<readonly T[]> { log.push(sql); return [] as readonly T[] },
    async execute(sql: string): Promise<RdbWriteResult> { log.push(sql); return { affectedRows: 1, insertId: 0 } },
    async beginTransaction() { log.push('BEGIN') },
    async commit() { log.push('COMMIT') },
    async rollback() { log.push('ROLLBACK') },
  }
  return {
    name,
    dialect: 'mysql',
    identity: `fake:${name}`,
    log,
    async query<T = unknown>(sql: string): Promise<readonly T[]> { log.push(sql); return [] as readonly T[] },
    async execute(sql: string): Promise<RdbWriteResult> { log.push(sql); return { affectedRows: 1, insertId: 0 } },
    async withConnection<T>(work: (conn: RdbConnection) => Promise<T>) { log.push('ACQUIRE'); return await work(conn) },
    async transaction<T>(work: (conn: RdbConnection) => Promise<T>) {
      log.push('BEGIN')
      try {
        const value = await work(conn)
        log.push('COMMIT')
        return value
      } catch (error) {
        log.push('ROLLBACK')
        throw error
      }
    },
    async close() { log.push('CLOSE') },
  }
}

describe('RdbDatabaseRegistry', () => {
  it('registers, resolves, and unregisters by name', () => {
    const registry = new RdbDatabaseRegistry()
    const db = fakeDatabase('sessions')
    const dispose = registry.register('sessions', db)
    expect(registry.names()).toEqual(['sessions'])
    expect(registry.get('sessions')).toBe(db)
    dispose()
    expect(registry.names()).toEqual([])
  })

  it('rejects duplicate names', () => {
    const registry = new RdbDatabaseRegistry()
    registry.register('sessions', fakeDatabase('sessions'))
    expect(() => registry.register('sessions', fakeDatabase('sessions')))
      .toThrow(RdbError)
    try {
      registry.register('sessions', fakeDatabase('sessions'))
    } catch (error) {
      expect((error as RdbError).code).toBe('duplicate-database')
    }
  })

  it('fails loud on unknown names, listing what is registered', () => {
    const registry = new RdbDatabaseRegistry()
    registry.register('sessions', fakeDatabase('sessions'))
    expect(() => registry.get('users')).toThrow(/'users' is not registered \(registered: sessions\)/)
    expect(() => registry.get('users')).toThrow(RdbError)
  })

  it('a stale disposer cannot remove a successor registration', () => {
    const registry = new RdbDatabaseRegistry()
    const first = fakeDatabase('sessions')
    const second = fakeDatabase('sessions')
    const disposeFirst = registry.register('sessions', first)
    disposeFirst()
    const disposeSecond = registry.register('sessions', second)
    disposeFirst() // stale: fires again after the successor registered
    expect(registry.get('sessions')).toBe(second)
    disposeSecond()
    expect(registry.names()).toEqual([])
  })
})

describe('migrateRdb', () => {
  beforeEach(() => {
    // 2026-09-23 割接裁定（is_init_db）：迁移总开关缺省关——本组专测迁移器
    // 本体，显式开；末枚行为钉单独还原缺省态验证「未设即跳过」。
    vi.stubEnv('IS_INIT_DB', 'true')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('缺省（IS_INIT_DB 未设）跳过一切迁移语句（is_init_db 行为钉）', async () => {
    vi.unstubAllEnvs()
    const db = fakeDatabase('users')
    await migrateRdb(db, { table: 'dsh_schema', migrations: [{ version: 1, statements: ['CREATE TABLE a ()'] }] })
    expect(db.log).toEqual([])
  })

  it('creates the bookkeeping table, applies versions in order, records each version row', async () => {
    const db = fakeDatabase('users')
    const applied: string[] = []
    db.query = async <T = unknown>(sql: string): Promise<readonly T[]> => {
      if (sql === 'SELECT version FROM dsh_schema') return [{ version: 0 }] as unknown as readonly T[]
      applied.push(sql)
      return [] as readonly T[]
    }
    db.execute = async (sql: string): Promise<RdbWriteResult> => {
      applied.push(sql)
      return { affectedRows: 1, insertId: 0 }
    }
    await migrateRdb(db, {
      table: 'dsh_schema',
      migrations: [
        { version: 2, statements: ['CREATE TABLE b ()'] },
        { version: 1, statements: ['CREATE TABLE a1 ()', 'CREATE TABLE a2 ()'] },
      ],
    })
    expect(applied).toEqual([
      'CREATE TABLE IF NOT EXISTS dsh_schema (version BIGINT NOT NULL PRIMARY KEY)',
      'CREATE TABLE a1 ()',
      'CREATE TABLE a2 ()',
      'INSERT INTO dsh_schema (version) VALUES (?)',
      'CREATE TABLE b ()',
      'INSERT INTO dsh_schema (version) VALUES (?)',
    ])
  })

  it('skips already-applied versions', async () => {
    const db = fakeDatabase('users')
    const applied: string[] = []
    db.query = async <T = unknown>(sql: string): Promise<readonly T[]> => {
      if (sql === 'SELECT version FROM dsh_schema') return [{ version: 1 }, { version: 2 }] as unknown as readonly T[]
      applied.push(sql)
      return [] as readonly T[]
    }
    await migrateRdb(db, {
      table: 'dsh_schema',
      migrations: [{ version: 2, statements: ['CREATE TABLE b ()'] }],
    })
    expect(applied).toEqual(['CREATE TABLE IF NOT EXISTS dsh_schema (version BIGINT NOT NULL PRIMARY KEY)'])
  })

  it('aborts fail-loud on a failing statement, wrapping the driver error as cause', async () => {
    const db = fakeDatabase('users')
    db.query = async (sql: string) => {
      if (sql === 'SELECT version FROM dsh_schema') return []
      if (sql.includes('BAD')) throw new Error('driver says no')
      return []
    }
    const failure = migrateRdb(db, {
      table: 'dsh_schema',
      migrations: [{ version: 1, statements: ['BAD DDL'] }],
    })
    await expect(failure).rejects.toThrow(RdbError)
    await expect(failure).rejects.toThrow(/migration to version 1 failed on database 'users'/)
    try {
      await failure
    } catch (error) {
      expect((error as RdbError).cause).toBeInstanceOf(Error)
    }
  })

  it('rejects table names that are not plain identifiers', async () => {
    const db = fakeDatabase('users')
    await expect(migrateRdb(db, { table: 'dsh; DROP TABLE x', migrations: [] })).rejects.toThrow(RdbError)
  })
})
