/**
 * provider-postgres/adhoc（withAdhocPostgres 一次性连接）探针：离线断言
 * 连接串拼装与不可达快失败；`DSH_POSTGRES_URL=postgres://user:pwd@host:
 * port/dbname` 在场时真连执行（探针表建删 / `?`→`$n` 翻译 / 扩展协议多语句
 * 拒绝 / currentSchema 落位），缺省整套 skip（既有门控先例同款）。
 * @module @ling2/ling-rdb-postgres/tests/adhoc
 */
import { describe, expect, it } from 'vitest'
import { buildAdhocPostgresUrl, withAdhocPostgres } from '../../src/provider-postgres/adhoc.ts'
import { toPostgresParams, toPostgresSql } from '../../src/provider-postgres/translate.ts'

const url = process.env.DSH_POSTGRES_URL

describe('withAdhocPostgres 离线（无需真库）', () => {
  it('连接串拼装：库名 pathname + schema currentSchema；无 schema 无查询串', () => {
    expect(buildAdhocPostgresUrl({ host: '10.0.0.9', port: 5432, user: 'u', password: 'p', database: 'db1' }))
      .toBe('postgres://u:p@10.0.0.9:5432/db1')
    expect(buildAdhocPostgresUrl({ host: 'h', port: 5433, user: 'u', password: 'p', database: 'db1', schema: 'sales' }))
      .toBe('postgres://u:p@h:5433/db1?currentSchema=sales')
    // 库名缺省不落 pathname 段（探测类操作）；schema 空串同缺省
    expect(buildAdhocPostgresUrl({ host: 'h', port: 5432, user: 'u', password: 'p' }))
      .toBe('postgres://u:p@h:5432')
    expect(buildAdhocPostgresUrl({ host: 'h', port: 5432, user: 'u', password: 'p', database: 'db1', schema: '' }))
      .toBe('postgres://u:p@h:5432/db1')
  })

  it('特殊字符凭据 percent-encoding（pg 连接串解析端解码还原）', () => {
    expect(buildAdhocPostgresUrl({ host: 'h', port: 5432, user: 'u@x', password: 'p@ss:word', database: 'db1' }))
      .toBe('postgres://u%40x:p%40ss%3Aword@h:5432/db1')
  })

  it('不可达 fail loud：connect 即拒（缺省 8s 预算内快失败）', async () => {
    await expect(withAdhocPostgres({ host: '127.0.0.1', port: 1, user: 'nobody', password: 'x' }, async () => undefined))
      .rejects.toThrow()
  })
})

describe.skipIf(url === undefined)('withAdhocPostgres 真连 (requires DSH_POSTGRES_URL)', () => {
  // 从门控 URL 拆出建连参数——探针不走 provider 池，直接 adhoc 短连
  // （惰性求值：skipIf 只守 describe 体，顶层急切 new URL 在无门控环境下炸 Invalid URL）。
  const options = () => {
    const parsed = new URL(url!)
    return {
      host: parsed.hostname,
      port: Number(parsed.port === '' ? 5432 : parsed.port),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(parsed.pathname.slice(1)),
      schema: 'public',
    }
  }

  it('真连 query/execute：`?`→`$n` 翻译 + 探针表建删（values 恒传形态）', async () => {
    await withAdhocPostgres(options(), async conn => {
      await conn.query(toPostgresSql('CREATE TABLE dsh_adhoc_probe (f_id VARCHAR(64) NOT NULL, f_n INT)'))
      try {
        const written = await conn.query(toPostgresSql('INSERT INTO dsh_adhoc_probe (f_id, f_n) VALUES (?, ?)'), toPostgresParams(['a', 1]))
        expect(written.rowCount).toBe(1)
        const found = await conn.query<{ f_id: string; f_n: number }>(
          toPostgresSql('SELECT f_id, f_n FROM dsh_adhoc_probe WHERE f_id = ?'), toPostgresParams(['a']))
        expect(found.rows).toEqual([{ f_id: 'a', f_n: 1 }])
      } finally {
        await conn.query('DROP TABLE dsh_adhoc_probe')
      }
    })
  })

  it('多语句拒绝（在层守卫闸）：单条 query 正文多命令即拒（pg 空数组 values 回落 simple 协议不拒多命令，2026-10-02 证伪驱动层闸后改 assertAdhocSingleStatement 在层守卫）', async () => {
    await withAdhocPostgres(options(), async conn => {
      await expect(conn.query('select 1; select 2', [])).rejects.toThrow(/多语句拒绝/)
      // 对照腿：串内分号（字面量）不是语句分隔——放行；尾分号放行
      await conn.query("select ';' as s", [])
      await conn.query('select 1;', [])
      // 无 values（simple 协议形态）同守卫——守卫不依赖协议形态
      await expect(conn.query('select 1; select 2')).rejects.toThrow(/多语句拒绝/)
      await conn.query('select 1')
    })
  })

  it('跑完即关：fn 返回后连接已终止（一次性语义，无池无复用）', async () => {
    await withAdhocPostgres(options(), async conn => {
      await conn.query('select 1')
      return conn
    }).then(async used => {
      // 连接对象被带出后已 end：再查询必拒（pg 对已结束 client 拒绝提交查询）
      await expect(used.query('select 1')).rejects.toThrow()
    })
  })

  it('currentSchema 落位：schema=public 连通且 current_schema() 回 public', async () => {
    await withAdhocPostgres(options(), async conn => {
      const rows = await conn.query<{ schema: string | null }>('SELECT current_schema() AS "schema"')
      expect(rows.rows[0]!.schema).toBe('public')
    })
  })
})
