/**
 * 金仓 provider 门控集成壳：`DSH_KINGBASE_URL=postgres://user:pwd@host:
 * port/dbname` 时真连执行，缺省整套 skip。实例到位后首轮即 **PoC 门**
 * （wire 直连性 / `?`→`$n` 翻译 / 事务 / `sql_compatibility` 模式确认）。
 * @module @ling2/ling-rdb-kingbase/tests/kingbase.spec
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@ling2/ling-coris'
import { Rdb } from '../../src/index.ts'
import { apply, Config as RdbKingbaseConfig, name, inject } from '../../src/provider-kingbase/index.ts'
import { toKingbaseSql } from '../../src/provider-kingbase/translate.ts'

const url = process.env.DSH_KINGBASE_URL

describe('toKingbaseSql 纯单测', () => {
  it('? 序号化为 $1/$2（引号感知）', () => {
    expect(toKingbaseSql("select '?' as q from t where c = ? and d = ?"))
      .toBe("select '?' as q from t where c = $1 and d = $2")
  })
})

describe.skipIf(url === undefined)('kingbase provider (requires DSH_KINGBASE_URL)', () => {
  let ctx: Context
  let provider: any

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(Rdb)
    provider = await ctx.plugin({ name, inject, apply }, {
      database: 'kingbase_it',
      url: url!,
    } satisfies RdbKingbaseConfig)
  })

  afterEach(async () => {
    // 树内姿势：只 dispose 插件 fiber（ctx.plugin 返回值）；Context 根无 dispose
    await provider.dispose()
  })

  it('query/execute 归一化（探针表，? 翻译为 $n）', async () => {
    const db = ctx.rdb.database.get('kingbase_it')
    await db.execute('CREATE TABLE dsh_kingbase_probe (f_id VARCHAR(64) NOT NULL, f_n INT)')
    try {
      await db.execute('INSERT INTO dsh_kingbase_probe (f_id, f_n) VALUES (?, ?)', ['a', 1])
      const rows = await db.query<{ f_id: string; f_n: number }>(
        'SELECT f_id, f_n FROM dsh_kingbase_probe WHERE f_id = ?', ['a'])
      expect(rows.length).toBe(1)
    } finally {
      await db.execute('DROP TABLE dsh_kingbase_probe')
    }
  })

  it('事务：work 成功提交', async () => {
    const db = ctx.rdb.database.get('kingbase_it')
    await db.execute('CREATE TABLE dsh_kingbase_probe (f_id VARCHAR(64) NOT NULL, f_n INT)')
    try {
      await db.transaction(async conn => {
        await conn.execute('INSERT INTO dsh_kingbase_probe (f_id, f_n) VALUES (?, ?)', ['tx', 1])
      })
      expect((await db.query('SELECT f_id FROM dsh_kingbase_probe')).length).toBe(1)
    } finally {
      await db.execute('DROP TABLE dsh_kingbase_probe')
    }
  })

  it('事务：work 拒绝则回滚并重抛原错', async () => {
    const db = ctx.rdb.database.get('kingbase_it')
    await db.execute('CREATE TABLE dsh_kingbase_probe (f_id VARCHAR(64) NOT NULL, f_n INT)')
    try {
      await expect(db.transaction(async conn => {
        await conn.execute('INSERT INTO dsh_kingbase_probe (f_id, f_n) VALUES (?, ?)', ['tx', 1])
        throw new Error('boom')
      })).rejects.toThrow('boom')
      expect((await db.query('SELECT f_id FROM dsh_kingbase_probe')).length).toBe(0)
    } finally {
      await db.execute('DROP TABLE dsh_kingbase_probe')
    }
  })

  it('一 hub 双库并挂（一源两行两注册名）', async () => {
    const provider2 = await ctx.plugin({ name, inject, apply }, {
      database: 'kingbase_it_2',
      url: url!,
    } satisfies RdbKingbaseConfig)
    expect(ctx.rdb.database.names()).toContain('kingbase_it_2')
    await provider2.dispose()
  })

  it('服务器不可达时插件行拒绝且注册表无该名', async () => {
    const ctx2 = new Context()
    await ctx2.plugin(Rdb)
    await expect(ctx2.plugin({ name, inject, apply }, {
      database: 'kingbase_dead',
      url: 'postgres://nouser:nopass@127.0.0.1:1/dead',
    } satisfies RdbKingbaseConfig)).rejects.toThrow()
    expect(ctx2.rdb.database.names()).not.toContain('kingbase_dead')
  })
})
