/**
 * PostgreSQL provider 门控集成壳：`DSH_POSTGRES_URL=postgres://user:pwd@
 * host:port/dbname` 时真连执行，缺省整套 skip。首轮即实测门（2026-09-17
 * ParadeDB 17.9 @ 192.168.74.129:5432 已过）：wire 直连性 / `?`→`$n` 翻
 * 译 / 事务 / 一 hub 双库 / 不可达 fail loud。
 * @module @ling2/ling-rdb-postgres/tests/postgres.spec
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@ling2/ling-coris'
import { Rdb } from '../../src/index.ts'
import { migrateRdb } from '../../src/hub/migrate.ts'
import { apply, Config as RdbPostgresConfig, name, inject } from '../../src/provider-postgres/index.ts'
import { toPostgresSql } from '../../src/provider-postgres/translate.ts'

const url = process.env.DSH_POSTGRES_URL

describe('toPostgresSql 纯单测', () => {
  it('? 序号化为 $1/$2（引号感知）', () => {
    expect(toPostgresSql("select '?' as q from t where c = ? and d = ?"))
      .toBe("select '?' as q from t where c = $1 and d = $2")
  })

  it('双引号标识符内的 ? 是字面字符不翻译', () => {
    expect(toPostgresSql('select "col?name" from t where c = ?'))
      .toBe('select "col?name" from t where c = $1')
  })
})

describe.skipIf(url === undefined)('provider-postgres (requires DSH_POSTGRES_URL)', () => {
  let ctx: Context
  let provider: any

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(Rdb)
    provider = await ctx.plugin({ name, inject, apply }, {
      database: 'postgres_it',
      url: url!,
    } satisfies RdbPostgresConfig)
  })

  afterEach(async () => {
    // 树内姿势：只 dispose 插件 fiber（ctx.plugin 返回值）；Context 根无 dispose
    await provider.dispose()
  })

  it('dialect 归位 postgresql（orm 分派键）', () => {
    expect(ctx.rdb.database.get('postgres_it').dialect).toBe('postgresql')
  })

  it('query/execute 归一化（探针表，? 翻译为 $n）', async () => {
    const db = ctx.rdb.database.get('postgres_it')
    await db.execute('CREATE TABLE dsh_postgres_probe (f_id VARCHAR(64) NOT NULL, f_n INT)')
    try {
      await db.execute('INSERT INTO dsh_postgres_probe (f_id, f_n) VALUES (?, ?)', ['a', 1])
      const rows = await db.query<{ f_id: string; f_n: number }>(
        'SELECT f_id, f_n FROM dsh_postgres_probe WHERE f_id = ?', ['a'])
      expect(rows.length).toBe(1)
    } finally {
      await db.execute('DROP TABLE dsh_postgres_probe')
    }
  })

  it('事务：work 成功提交', async () => {
    const db = ctx.rdb.database.get('postgres_it')
    await db.execute('CREATE TABLE dsh_postgres_probe (f_id VARCHAR(64) NOT NULL, f_n INT)')
    try {
      await db.transaction(async conn => {
        await conn.execute('INSERT INTO dsh_postgres_probe (f_id, f_n) VALUES (?, ?)', ['tx', 1])
      })
      expect((await db.query('SELECT f_id FROM dsh_postgres_probe')).length).toBe(1)
    } finally {
      await db.execute('DROP TABLE dsh_postgres_probe')
    }
  })

  it('事务：work 拒绝则回滚并重抛原错', async () => {
    const db = ctx.rdb.database.get('postgres_it')
    await db.execute('CREATE TABLE dsh_postgres_probe (f_id VARCHAR(64) NOT NULL, f_n INT)')
    try {
      await expect(db.transaction(async conn => {
        await conn.execute('INSERT INTO dsh_postgres_probe (f_id, f_n) VALUES (?, ?)', ['tx', 1])
        throw new Error('boom')
      })).rejects.toThrow('boom')
      expect((await db.query('SELECT f_id FROM dsh_postgres_probe')).length).toBe(0)
    } finally {
      await db.execute('DROP TABLE dsh_postgres_probe')
    }
  })

  it('migrateRdb 建版本表并应用两版迁移（PG 可移植性）', async () => {
    const db = ctx.rdb.database.get('postgres_it')
    await migrateRdb(db, {
      table: 'dsh_postgres_probe_versions',
      migrations: [
        { version: 1, statements: ['CREATE TABLE dsh_postgres_m1 (f_id VARCHAR(64) NOT NULL)'] },
        { version: 2, statements: ['ALTER TABLE dsh_postgres_m1 ADD COLUMN f_n INT'] },
      ],
    })
    try {
      // 重放幂等：已应用版本跳过
      await migrateRdb(db, {
        table: 'dsh_postgres_probe_versions',
        migrations: [
          { version: 1, statements: ['CREATE TABLE dsh_postgres_m1 (f_id VARCHAR(64) NOT NULL)'] },
          { version: 2, statements: ['ALTER TABLE dsh_postgres_m1 ADD COLUMN f_n INT'] },
        ],
      })
      await db.execute('INSERT INTO dsh_postgres_m1 (f_id, f_n) VALUES (?, ?)', ['v', 9])
      expect((await db.query<{ f_n: number }>('SELECT f_n FROM dsh_postgres_m1'))[0].f_n).toBe(9)
    } finally {
      await db.execute('DROP TABLE dsh_postgres_m1')
      await db.execute('DROP TABLE dsh_postgres_probe_versions')
    }
  })

  it('一 hub 双库并挂（一源两行两注册名）', async () => {
    const provider2 = await ctx.plugin({ name, inject, apply }, {
      database: 'postgres_it_2',
      url: url!,
    } satisfies RdbPostgresConfig)
    expect(ctx.rdb.database.names()).toContain('postgres_it_2')
    await provider2.dispose()
  })

  it('A6 迁移并发锁：双库实例（不同注册名同物理库）并发同链迁移互斥——DDL 只重放一次', async () => {
    // 真机缺陷形态：audit+ledger 双服务同链三启两败（pg_type 目录唯一冲突）
    vi.stubEnv('IS_INIT_DB', 'true')
    const providerB = await ctx.plugin({ name, inject, apply }, {
      database: 'postgres_it_b',
      url: url!,
    } satisfies RdbPostgresConfig)
    const a = ctx.rdb.database.get('postgres_it')
    const b = ctx.rdb.database.get('postgres_it_b')
    try {
      // 残留自愈：上轮失败遗留先清掉（清残留不改并发语义——冲突由并发重放制造）
      await a.execute('DROP TABLE IF EXISTS dsh_a6_it_versions')
      await a.execute('DROP TYPE IF EXISTS dsh_a6_it_probe')
      const chain = {
        postgresql: [{ version: 1, statements: ['CREATE TYPE dsh_a6_it_probe AS ENUM (\'v1\')'] }],
      }
      await Promise.all([
        migrateRdb(a, { table: 'dsh_a6_it_versions', migrations: chain }),
        migrateRdb(b, { table: 'dsh_a6_it_versions', migrations: chain }),
      ])
      // 簿记恰一行：第二入口等 advisory lock 后重读已应用集跳过，不再重放
      const rows = await a.query<{ version: number }>('SELECT version FROM dsh_a6_it_versions')
      expect(rows.map(row => Number(row.version))).toEqual([1])
      // 锁已释放：持锁会话之外对任意键 unlock 正常执行返回 false（未持锁），
      // 会话可继续跑语句即证无死锁残留
      const unlocked = await a.query<{ pg_advisory_unlock: boolean }>('SELECT pg_advisory_unlock(?::bigint)', ['1'])
      expect(unlocked[0].pg_advisory_unlock).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      await providerB.dispose()
      await a.execute('DROP TABLE IF EXISTS dsh_a6_it_versions')
      await a.execute('DROP TYPE IF EXISTS dsh_a6_it_probe')
    }
  })

  it('服务器不可达时插件行拒绝且注册表无该名', async () => {
    const ctx2 = new Context()
    await ctx2.plugin(Rdb)
    await expect(ctx2.plugin({ name, inject, apply }, {
      database: 'postgres_dead',
      url: 'postgres://nouser:nopass@127.0.0.1:1/dead',
    } satisfies RdbPostgresConfig)).rejects.toThrow()
    expect(ctx2.rdb.database.names()).not.toContain('postgres_dead')
  })
})
