/**
 * 达梦 provider 门控集成壳：`DSH_DM_URL=dm://user:pwd@host:port` 时真连
 * 执行，缺省整套 skip。实例到位后首轮即 **PoC 门**（dmdb 池行为 /
 * `[{val}]` 绑定 / 事务隐式模型 / 列名大小写——达夌默认未引用 DDL 折
 * 大写，探针查询按驱动 `columnNameCase` 实测后校准断言键名）。
 * @module @ling2/ling-rdb-dm/tests/dm.spec
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@ling2/ling-coris'
import { Rdb } from '../../src/index.ts'
import { apply, Config as RdbDmConfig, name, inject } from '../../src/provider-dm/index.ts'

const url = process.env.DSH_DM_URL

describe.skipIf(url === undefined)('dsh-rdb-dm (requires DSH_DM_URL)', () => {
  let ctx: Context
  let provider: any

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(Rdb)
    provider = await ctx.plugin({ name, inject, apply }, {
      database: 'dm_it',
      url: url!,
    } satisfies RdbDmConfig)
  })

  afterEach(async () => {
    await provider.dispose()
  })

  it('query/execute 归一化（探针表，? 翻译为 :n、[{val}] 绑定）', async () => {
    const db = ctx.rdb.database.get('dm_it')
    await db.execute('CREATE TABLE dsh_dm_probe (f_id VARCHAR(64) NOT NULL, f_n INT)')
    try {
      await db.execute('INSERT INTO dsh_dm_probe (f_id, f_n) VALUES (?, ?)', ['a', 1])
      const rows = await db.query<Record<string, unknown>>('SELECT f_id, f_n FROM dsh_dm_probe WHERE f_id = ?', ['a'])
      expect(rows.length).toBe(1)
    } finally {
      await db.execute('DROP TABLE dsh_dm_probe')
    }
  })

  it('事务：work 成功提交', async () => {
    const db = ctx.rdb.database.get('dm_it')
    await db.execute('CREATE TABLE dsh_dm_probe (f_id VARCHAR(64) NOT NULL, f_n INT)')
    try {
      await db.transaction(async conn => {
        await conn.execute('INSERT INTO dsh_dm_probe (f_id, f_n) VALUES (?, ?)', ['tx', 1])
      })
      expect((await db.query('SELECT f_id FROM dsh_dm_probe')).length).toBe(1)
    } finally {
      await db.execute('DROP TABLE dsh_dm_probe')
    }
  })

  it('事务：work 拒绝则回滚并重抛原错', async () => {
    const db = ctx.rdb.database.get('dm_it')
    await db.execute('CREATE TABLE dsh_dm_probe (f_id VARCHAR(64) NOT NULL, f_n INT)')
    try {
      await expect(db.transaction(async conn => {
        await conn.execute('INSERT INTO dsh_dm_probe (f_id, f_n) VALUES (?, ?)', ['tx', 1])
        throw new Error('boom')
      })).rejects.toThrow('boom')
      expect((await db.query('SELECT f_id FROM dsh_dm_probe')).length).toBe(0)
    } finally {
      await db.execute('DROP TABLE dsh_dm_probe')
    }
  })

  it('一 hub 双库并挂（一源两行两注册名）', async () => {
    const provider2 = await ctx.plugin({ name, inject, apply }, {
      database: 'dm_it_2',
      url: url!,
    } satisfies RdbDmConfig)
    expect(ctx.rdb.database.names()).toContain('dm_it_2')
    await provider2.dispose()
  })

  it('服务器不可达时插件行拒绝且注册表无该名', async () => {
    const ctx2 = new Context()
    await ctx2.plugin(Rdb)
    await expect(ctx2.plugin({ name, inject, apply }, {
      database: 'dm_dead',
      url: 'dm://nouser:nopass@127.0.0.1:1',
    } satisfies RdbDmConfig)).rejects.toThrow()
    expect(ctx2.rdb.database.names()).not.toContain('dm_dead')
  })
})
