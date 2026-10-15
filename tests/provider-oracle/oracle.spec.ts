/**
 * Oracle provider 门控集成壳（镜像 mysql provider tests 同款五用
 * 例）：`DSH_ORACLE_URL=oracle://user:pwd@host:port/service` 时真连执行，
 * 缺省整套 skip 不失败。实例到位后首轮即 **PoC 门**（thin 模式 ≥12.1、
 * 事务隐式模型、行键大小写折叠三项一并验证）。
 * @module @ling2/ling-rdb-oracle/tests/oracle.spec
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@ling2/ling-cordis'
import { Rdb } from '../../src/index.ts'
import { apply, Config as RdbOracleConfig, name, inject } from '../../src/provider-oracle/index.ts'

const url = process.env.DSH_ORACLE_URL

describe.skipIf(url === undefined)('dsh-rdb-oracle (requires DSH_ORACLE_URL)', () => {
  let ctx: Context
  let provider: any

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(Rdb)
    provider = await ctx.plugin({ name, inject, apply }, {
      database: 'oracle_it',
      url: url!,
    } satisfies RdbOracleConfig)
  })

  afterEach(async () => {
    await provider.dispose()
  })

  it('query/execute 归一化（探针表， ? 翻译为 :n）', async () => {
    const db = ctx.rdb.database.get('oracle_it')
    await db.execute('CREATE TABLE dsh_oracle_probe (f_id VARCHAR2(64) NOT NULL, f_n NUMBER)')
    try {
      await db.execute('INSERT INTO dsh_oracle_probe (f_id, f_n) VALUES (?, ?)', ['a', 1])
      const rows = await db.query<{ F_ID: string; F_N: number } | { f_id: string; f_n: number }>(
        'SELECT f_id, f_n FROM dsh_oracle_probe WHERE f_id = ?', ['a'])
      expect(rows.length).toBe(1)
    } finally {
      await db.execute('DROP TABLE dsh_oracle_probe')
    }
  })

  it('事务：work 成功提交', async () => {
    const db = ctx.rdb.database.get('oracle_it')
    await db.execute('CREATE TABLE dsh_oracle_probe (f_id VARCHAR2(64) NOT NULL, f_n NUMBER)')
    try {
      await db.transaction(async conn => {
        await conn.execute('INSERT INTO dsh_oracle_probe (f_id, f_n) VALUES (?, ?)', ['tx', 1])
      })
      const rows = await db.query('SELECT f_id FROM dsh_oracle_probe')
      expect(rows.length).toBe(1)
    } finally {
      await db.execute('DROP TABLE dsh_oracle_probe')
    }
  })

  it('事务：work 拒绝则回滚并重抛原错', async () => {
    const db = ctx.rdb.database.get('oracle_it')
    await db.execute('CREATE TABLE dsh_oracle_probe (f_id VARCHAR2(64) NOT NULL, f_n NUMBER)')
    try {
      await expect(db.transaction(async conn => {
        await conn.execute('INSERT INTO dsh_oracle_probe (f_id, f_n) VALUES (?, ?)', ['tx', 1])
        throw new Error('boom')
      })).rejects.toThrow('boom')
      const rows = await db.query('SELECT f_id FROM dsh_oracle_probe')
      expect(rows.length).toBe(0)
    } finally {
      await db.execute('DROP TABLE dsh_oracle_probe')
    }
  })

  it('一 hub 双库并挂（一源两行两注册名）', async () => {
    const provider2 = await ctx.plugin({ name, inject, apply }, {
      database: 'oracle_it_2',
      url: url!,
    } satisfies RdbOracleConfig)
    expect(ctx.rdb.database.names()).toContain('oracle_it_2')
    await provider2.dispose()
  })

  it('服务器不可达时插件行拒绝且注册表无该名', async () => {
    const ctx2 = new Context()
    await ctx2.plugin(Rdb)
    await expect(ctx2.plugin({ name, inject, apply }, {
      database: 'oracle_dead',
      url: 'oracle://nouser:nopass@127.0.0.1:1/DEAD',
    } satisfies RdbOracleConfig)).rejects.toThrow()
    expect(ctx2.rdb.database.names()).not.toContain('oracle_dead')
  })
})
