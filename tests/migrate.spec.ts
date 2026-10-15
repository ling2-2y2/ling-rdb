/**
 * 迁移运行器并发锁测试（2026-09-28 A6 缺陷回归）：真机实证 audit+ledger
 * 双服务并发同链迁移三启两败（PG pg_type 目录唯一冲突）——本组以离线
 * 「假 PG 服务器」模型复现该并发形态，并钉死 advisory lock 键派生、进程
 * 内互斥、异常路径锁释放三项语义；无需真库（真库腿在 provider-postgres
 * 门控套件内）。
 * @module @ling2/ling-rdb/tests/migrate
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RdbError } from '../src/hub/error.ts'
import { migrateRdb, migrationAdvisoryLockKey, resolveRdbStatements } from '../src/hub/migrate.ts'
import type { RdbConnection, RdbDatabase, RdbWriteResult } from '../src/hub/types.ts'

beforeEach(() => {
  // 迁移总开关缺省关（is_init_db 行为钉在 registry.spec）；本组专测迁移器，显式开
  vi.stubEnv('IS_INIT_DB', 'true')
})

describe('A6 advisory lock 键派生（版本表名 → bigint 键）', () => {
  it('同表恒同键、异表异键', () => {
    expect(migrationAdvisoryLockKey('dsh_schema')).toBe(migrationAdvisoryLockKey('dsh_schema'))
    expect(migrationAdvisoryLockKey('dsh_schema')).not.toBe(migrationAdvisoryLockKey('dsh_schema_other'))
  })

  it('键落在 PG 有符号 bigint 正域（十进制串形态）', () => {
    for (const table of ['dsh_schema', 'a6_shared_schema', 'x']) {
      const key = BigInt(migrationAdvisoryLockKey(table))
      expect(key > 0n).toBe(true)
      expect(key).toBeLessThan(2n ** 63n)
    }
  })
})

describe('A6 复现钉：双入口并发同链迁移互斥（假 PG 服务器模型）', () => {
  it('audit+ledger 两库实例并发跑同一链：CREATE TYPE 只执行一次、双调全绿、第二会话确曾在锁上等待', async () => {
    const server = makeFakePostgresServer()
    const audit = server.makeDatabase('audit')
    const ledger = server.makeDatabase('ledger')
    const chain = {
      postgresql: [
        { version: 1, statements: ["CREATE TYPE dsh_a6_probe AS ENUM ('v1')", 'CREATE TABLE dsh_a6_t1 (id INT)'] },
      ],
    }
    await Promise.all([
      migrateRdb(audit, { table: 'a6_shared_schema', migrations: chain }),
      migrateRdb(ledger, { table: 'a6_shared_schema', migrations: chain }),
    ])
    // pg_type 唯一冲突的根因断言：并发下 DDL 恰执行一次
    expect(server.createTypeExecutions).toBe(1)
    // 簿记恰一行：第二入口等锁后重读已应用集，跳过不再重放
    expect(server.versionRows('a6_shared_schema')).toEqual([1])
    // 互斥确实发生在 advisory lock 上（有会话曾阻塞等待），而非时序侥幸错开
    expect(server.blockedLockAcquires).toBeGreaterThanOrEqual(1)
  })

  it('迁移中途失败：advisory unlock 仍被调用（异常路径释放），错误照常上抛', async () => {
    const server = makeFakePostgresServer()
    const db = server.makeDatabase('audit')
    const failure = migrateRdb(db as unknown as RdbDatabase, {
      table: 'a6_fail_schema',
      migrations: [{ version: 1, statements: ['CREATE TYPE dsh_a6_fail AS ENUM (BAD'] }],
    })
    await expect(failure).rejects.toThrow(RdbError)
    await failure.catch(() => {}) // 拒绝已断言，避免未处理拒绝
    expect(server.unlockCalls).toBe(1)
    // 锁释放后同键重入可正常获锁（可重入安全）
    await expect(server.makeDatabase('audit2').query('SELECT pg_advisory_lock(?::bigint)', [
      migrationAdvisoryLockKey('a6_fail_schema'),
    ])).resolves.toBeDefined()
  })
})

describe('A6 进程内互斥（mysql 方言路径：无 advisory lock，同进程并发仍须串行）', () => {
  it('同库同键并发双调：第二遍读簿记跳过已应用版本，DDL 只执行一次', async () => {
    const executed: string[] = []
    const versions = new Set<number>()
    const db = {
      name: 'audit',
      dialect: 'mysql',
      identity: 'fake:audit',
      async query(sql: string, _params?: readonly unknown[]) {
        if (sql.startsWith('SELECT version FROM')) {
          return [...versions].map(version => ({ version })) as never
        }
        if (sql.startsWith('CREATE TABLE dsh_')) {
          // 模拟 MySQL 下重复建表冲突（无 IF NOT EXISTS 的 DDL 二跑即炸）
          if (executed.includes(sql)) throw new Error("Table 'dsh_x' already exists")
          executed.push(sql)
        }
        return []
      },
      async execute(sql: string, params?: readonly unknown[]): Promise<RdbWriteResult> {
        const match = /INSERT INTO \S+ \(version\)/.exec(sql)
        if (match) versions.add(Number(params![0]))
        return { affectedRows: 1, insertId: 0 }
      },
      async withConnection<T>(work: (conn: RdbConnection) => Promise<T>) {
        throw new Error('mysql 路径迁移不取独占连接')
      },
      async close() {},
    }
    const chain = [{ version: 1, statements: ['CREATE TABLE dsh_x (id INT)'] }] as const
    await Promise.all([
      migrateRdb(db as unknown as RdbDatabase, { table: 'a6_schema', migrations: chain }),
      migrateRdb(db as unknown as RdbDatabase, { table: 'a6_schema', migrations: chain }),
    ])
    expect(executed).toEqual(['CREATE TABLE dsh_x (id INT)'])
  })

  it('失败迁移不毒化进程内锁：同键重跑可继续完成', async () => {
    const executed: string[] = []
    const versions = new Set<number>()
    const db = {
      name: 'audit',
      dialect: 'mysql',
      identity: 'fake:audit',
      async query(sql: string, _params?: readonly unknown[]) {
        if (sql.startsWith('SELECT version FROM')) {
          return [...versions].map(version => ({ version })) as never
        }
        if (sql.startsWith('CREATE TABLE dsh_')) {
          if (executed.includes(sql)) throw new Error("Table 'dsh_y' already exists")
          executed.push(sql)
        }
        if (sql === 'BAD DDL') throw new Error('driver says no')
        return []
      },
      async execute(sql: string, params?: readonly unknown[]): Promise<RdbWriteResult> {
        const match = /INSERT INTO \S+ \(version\)/.exec(sql)
        if (match) versions.add(Number(params![0]))
        return { affectedRows: 1, insertId: 0 }
      },
      async withConnection<T>(work: (conn: RdbConnection) => Promise<T>) {
        throw new Error('mysql 路径迁移不取独占连接')
      },
      async close() {},
    }
    // 第一遍：坏语句失败上抛
    await expect(migrateRdb(db as unknown as RdbDatabase, {
      table: 'a6_schema2',
      migrations: [{ version: 1, statements: ['BAD DDL'] }],
    })).rejects.toThrow(/migration to version 1 failed/)
    // 第二遍：语句已修，同键重跑正常完成（进程内锁未被子第一次失败毒化）
    await migrateRdb(db as unknown as RdbDatabase, {
      table: 'a6_schema2',
      migrations: [{ version: 1, statements: ['CREATE TABLE dsh_y (id INT)'] }],
    })
    expect(executed).toEqual(['CREATE TABLE dsh_y (id INT)'])
  })
})

describe('方言分派语句条目（2026-10-02 用户裁定：守卫组工厂单一入口，执行期按所连库方言选支）', () => {
  /** 最小假库：捕获迁移主体执行的 SQL（dialect 可指定；PG 形态 withConnection 递假连接）。 */
  function makeCapturingDb(dialect: 'mysql' | 'postgresql') {
    const executed: string[] = []
    const versions = new Set<number>()
    const db = {
      name: 'cap',
      dialect,
      identity: `fake:${dialect}:cap`,
      async query(sql: string) {
        if (sql.startsWith('SELECT version FROM')) return [...versions].map(version => ({ version })) as never
        // 簿记建表与 PG advisory lock/unlock 都不是迁移语句，不入捕获
        if (!sql.startsWith('CREATE TABLE IF NOT EXISTS') && !sql.startsWith('SELECT pg_advisory_')) executed.push(sql)
        return []
      },
      async execute(sql: string, params?: readonly unknown[]): Promise<RdbWriteResult> {
        const match = /INSERT INTO \S+ \(version\)/.exec(sql)
        if (match) versions.add(Number(params![0]))
        return { affectedRows: 1, insertId: 0 }
      },
      async withConnection<T>(work: (conn: RdbConnection) => Promise<T>) {
        if (dialect !== 'postgresql') throw new Error('PG 以外方言迁移不取独占连接')
        return await work(db as unknown as RdbConnection)
      },
      async close() {},
    }
    return { db: db as unknown as RdbDatabase, executed }
  }

  it('同一链在 mysql 与 postgresql 两库上各取各支、条目顺序与语句序保持', async () => {
    const chain = [{
      version: 1,
      statements: [
        '-- 公共前置',
        {
          mysql: ['SET @x := (SELECT 1)', 'PREPARE st FROM @x', 'EXECUTE st', 'DEALLOCATE PREPARE st'],
          postgresql: ['ALTER TABLE t ADD COLUMN IF NOT EXISTS c INT'],
        },
        '-- 公共后置',
      ],
    }]
    const mysqlRun = makeCapturingDb('mysql')
    await migrateRdb(mysqlRun.db, { table: 'cap_schema', migrations: chain })
    expect(mysqlRun.executed).toEqual([
      '-- 公共前置', 'SET @x := (SELECT 1)', 'PREPARE st FROM @x', 'EXECUTE st', 'DEALLOCATE PREPARE st', '-- 公共后置',
    ])
    const pgRun = makeCapturingDb('postgresql')
    await migrateRdb(pgRun.db, { table: 'cap_schema', migrations: chain })
    expect(pgRun.executed).toEqual([
      '-- 公共前置', 'ALTER TABLE t ADD COLUMN IF NOT EXISTS c INT', '-- 公共后置',
    ])
  })

  it('方言分派组缺支 fail loud：不静默回退另一方言的语句（解析先于执行，零语句落库）', async () => {
    const run = makeCapturingDb('postgresql')
    await expect(migrateRdb(run.db, {
      table: 'cap_schema',
      // 故意只给 mysql 支——类型面上必须绕过穷举检查，运行期由解析器拦下
      migrations: [{ version: 1, statements: [{ mysql: ['SELECT 1'] }] as never }],
    })).rejects.toThrow(/方言语句组缺支/)
    expect(run.executed).toEqual([])
  })

  it('mysql/postgresql 之外的方言遇方言分派组 fail loud；字符串条目任意方言原样直通', () => {
    expect(() => resolveRdbStatements({ mysql: ['SELECT 1'], postgresql: ['SELECT 2'] }, 'kingbase')).toThrow(/方言语句组缺支/)
    expect(() => resolveRdbStatements({ mysql: ['SELECT 1'], postgresql: ['SELECT 2'] }, 'dm')).toThrow(/方言语句组缺支/)
    expect(resolveRdbStatements('SELECT 3', 'kingbase')).toEqual(['SELECT 3'])
  })
})

/**
 * 假 PG 服务器：跨库实例共享「类型目录 + 簿记表 + advisory 锁位」三态，
 * 会话锁语义对齐真 PG——同会话可重入、异会话阻塞排队、unlock 唤醒一位
 * 等待者。用于离线复现 pg_type 目录唯一冲突的并发形态。
 */
function makeFakePostgresServer() {
  const bookkeeping = new Map<string, number[]>()
  const typeDirectory = new Set<string>()
  let createTypeExecutions = 0
  let blockedLockAcquires = 0
  let unlockCalls = 0
  let lockHolder: number | null = null
  const lockWaiters: Array<() => void> = []
  let sessionSeq = 0

  async function acquireAdvisoryLock(session: number): Promise<void> {
    // 同会话重入直接成功（PG advisory lock 同会话叠加计数语义的简化模型）
    if (lockHolder === session) return
    while (lockHolder !== null) {
      blockedLockAcquires++
      await new Promise<void>(resolve => { lockWaiters.push(resolve) })
    }
    lockHolder = session
  }

  function releaseAdvisoryLock(session: number): void {
    unlockCalls++
    if (lockHolder !== session) return
    lockHolder = null
    lockWaiters.shift()?.()
  }

  function makeDatabase(name: string): RdbDatabase {
    const session = ++sessionSeq
  async function runQuery<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]> {
    // 驱动级语法错误模型：迁移主体失败路径用（异常释放/不毒化断言的触发点）
    if (sql.includes('BAD')) throw new Error('syntax error at or near "BAD"')
    if (sql.startsWith('SELECT pg_advisory_lock')) {
      await acquireAdvisoryLock(session)
      return [{ locked: true }] as unknown as readonly T[]
    }
    if (sql.startsWith('SELECT pg_advisory_unlock')) {
      releaseAdvisoryLock(session)
      return [{ unlocked: true }] as unknown as readonly T[]
    }
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) {
      const table = sql.split(' ')[5]
      if (!bookkeeping.has(table)) bookkeeping.set(table, [])
      return []
    }
      if (sql.startsWith('SELECT version FROM')) {
        const table = sql.split(' ')[3]
        return (bookkeeping.get(table) ?? []).map(version => ({ version })) as unknown as readonly T[]
      }
      if (sql.startsWith('CREATE TYPE')) {
        createTypeExecutions++
        const typeName = sql.split(' ')[2]
        // 模拟 pg_type 目录唯一约束：类型已存在即抛（真机缺陷的冲突点）
        if (typeDirectory.has(typeName)) {
          throw new Error(`type "${typeName}" already exists（模拟 pg_type 唯一冲突）`)
        }
        typeDirectory.add(typeName)
        return []
      }
      if (sql.startsWith('INSERT INTO')) {
        const table = sql.split(' ')[2]
        bookkeeping.get(table)?.push(Number(params![0]))
        return []
      }
      return []
    }
    const conn: RdbConnection = {
      query: runQuery,
      async execute(sql: string, params?: readonly unknown[]) {
        await runQuery(sql, params)
        return { affectedRows: 1, insertId: 0 }
      },
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
    }
    return {
      name,
      dialect: 'postgresql' as const,
      identity: `fakepg:${name}`,
      query: runQuery,
      execute: conn.execute,
      async withConnection<T>(work: (conn: RdbConnection) => Promise<T>) {
        // 每实例一个固定会话：持锁连接即迁移段执行连接（与修复实现同形）
        return await work(conn)
      },
      async transaction<T>(work: (conn: RdbConnection) => Promise<T>) {
        return await work(conn)
      },
      async close() {},
    }
  }

  return {
    makeDatabase,
    get createTypeExecutions() { return createTypeExecutions },
    get blockedLockAcquires() { return blockedLockAcquires },
    get unlockCalls() { return unlockCalls },
    versionRows(table: string): number[] {
      return [...(bookkeeping.get(table) ?? [])].sort((a, b) => a - b)
    },
  }
}
