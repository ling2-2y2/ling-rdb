/**
 * 五方言编译黄金断言（离线，无任何连接）：同一查询树在 mysql/kingbase/
 * postgresql/oracle/dm 的 SQL 形态——mysql 反引号引用、其余族未引用标识
 * 符；占位符全族统一 `?`（编号翻译归 provider）；Oracle/DM 分页为
 * OFFSET…FETCH 形态（limit→fetch 节点改写），金仓/PG 为 LIMIT…OFFSET。
 * fake database 只借 dialect 字段做分派，compile() 不触驱动。
 * @module @ling2/ling-rdb/tests/orm/compile.spec
 */
import { describe, expect, it } from 'vitest'
import type { RdbDatabase } from '../../src/hub/types.ts'
import { kyselyFor } from '../../src/orm/index.ts'

interface DemoDb {
  orm_demo_item: {
    f_id: string
    f_full_name: string
    f_en_code: string
    f_sort_code: number
    f_enabled_mark: number
  }
}

function fakeDatabase(dialect: RdbDatabase['dialect']): RdbDatabase {
  return {
    name: `fake-${dialect}`, dialect, identity: `fake:${dialect}`,
    query: async () => { throw new Error('compile 不应触达连接') },
    execute: async () => { throw new Error('compile 不应触达连接') },
    withConnection: async () => { throw new Error('compile 不应触达连接') },
    transaction: async () => { throw new Error('compile 不应触达连接') },
    close: async () => {},
  }
}

/** 同一分页查询树（Ling 列表页形态：过滤 + 排序 + 分页）。 */
function pagedQuery(db: ReturnType<typeof kyselyFor<DemoDb>>) {
  return db.selectFrom('orm_demo_item')
    .select(['f_id', 'f_full_name'])
    .where('f_en_code', '=', 'demo')
    .orderBy('f_id', 'asc')
    .limit(20)
    .offset(40)
    .compile()
}

describe('五方言编译形态', () => {
  it('mysql：反引号引用 + LIMIT/OFFSET + ? 占位符', () => {
    const compiled = pagedQuery(kyselyFor<DemoDb>(fakeDatabase('mysql')))
    expect(compiled.sql).toBe(
      'select `f_id`, `f_full_name` from `orm_demo_item` where `f_en_code` = ? order by `f_id` asc limit ? offset ?',
    )
    expect(compiled.parameters).toEqual(['demo', 20, 40])
  })

  it('kingbase：未引用标识符 + LIMIT/OFFSET + ? 占位符', () => {
    const compiled = pagedQuery(kyselyFor<DemoDb>(fakeDatabase('kingbase')))
    expect(compiled.sql).toBe(
      'select f_id, f_full_name from orm_demo_item where f_en_code = ? order by f_id asc limit ? offset ?',
    )
    expect(compiled.parameters).toEqual(['demo', 20, 40])
  })

  it('postgresql：与 kingbase 共用 PG 方言编译器（同形态，2026-09-17 weknora 子系统启用）', () => {
    const compiled = pagedQuery(kyselyFor<DemoDb>(fakeDatabase('postgresql')))
    expect(compiled.sql).toBe(
      'select f_id, f_full_name from orm_demo_item where f_en_code = ? order by f_id asc limit ? offset ?',
    )
    expect(compiled.parameters).toEqual(['demo', 20, 40])
  })

  it('oracle：OFFSET…ROWS FETCH NEXT…ROWS ONLY（limit→fetch 改写）', () => {
    const compiled = pagedQuery(kyselyFor<DemoDb>(fakeDatabase('oracle')))
    expect(compiled.sql).toBe(
      'select f_id, f_full_name from orm_demo_item where f_en_code = ? order by f_id asc offset ? rows fetch next ? rows only',
    )
    expect(compiled.parameters).toEqual(['demo', 40, 20])
  })

  it('dm：与 oracle 同形态（达梦 Oracle 兼容族）', () => {
    const compiled = pagedQuery(kyselyFor<DemoDb>(fakeDatabase('dm')))
    expect(compiled.sql).toBe(
      'select f_id, f_full_name from orm_demo_item where f_en_code = ? order by f_id asc offset ? rows fetch next ? rows only',
    )
  })

  it('oracle 仅 limit（无 offset）：独立 FETCH FIRST/NEXT 形态', () => {
    const compiled = kyselyFor<DemoDb>(fakeDatabase('oracle'))
      .selectFrom('orm_demo_item').selectAll().limit(5).compile()
    expect(compiled.sql).toBe('select * from orm_demo_item fetch next ? rows only')
  })

  it('insert：mysql 反引号列清单，其余族未引用，占位符全族 ?', () => {
    const values = { f_id: '1', f_full_name: '演示', f_en_code: 'demo', f_sort_code: 1, f_enabled_mark: 1 }
    const mysql = kyselyFor<DemoDb>(fakeDatabase('mysql'))
      .insertInto('orm_demo_item').values(values).compile()
    expect(mysql.sql).toBe(
      'insert into `orm_demo_item` (`f_id`, `f_full_name`, `f_en_code`, `f_sort_code`, `f_enabled_mark`) values (?, ?, ?, ?, ?)',
    )
    const oracle = kyselyFor<DemoDb>(fakeDatabase('oracle'))
      .insertInto('orm_demo_item').values(values).compile()
    expect(oracle.sql).toBe(
      'insert into orm_demo_item (f_id, f_full_name, f_en_code, f_sort_code, f_enabled_mark) values (?, ?, ?, ?, ?)',
    )
  })

  it('update：动态 SET + WHERE 占位符', () => {
    const compiled = kyselyFor<DemoDb>(fakeDatabase('dm'))
      .updateTable('orm_demo_item').set({ f_full_name: '改名', f_enabled_mark: 0 }).where('f_id', '=', '1').compile()
    expect(compiled.sql).toBe('update orm_demo_item set f_full_name = ?, f_enabled_mark = ? where f_id = ?')
    expect(compiled.parameters).toEqual(['改名', 0, '1'])
  })

  it('delete：未引用形态 + ? 占位符', () => {
    const compiled = kyselyFor<DemoDb>(fakeDatabase('kingbase'))
      .deleteFrom('orm_demo_item').where('f_id', '=', '1').compile()
    expect(compiled.sql).toBe('delete from orm_demo_item where f_id = ?')
  })

  it('or 条件组：数组形态产出 (a like ? or b like ?)——varargs 形态会静默产出 1 = 0（2026-09-05 中文关键词零结果回归）', () => {
    // 正确形态：or/and 收单数组参数
    const good = kyselyFor<DemoDb>(fakeDatabase('mysql'))
      .selectFrom('orm_demo_item').selectAll()
      .where(({ or, eb }) => or([
        eb('f_full_name', 'like', '%演示%'),
        eb('f_en_code', 'like', '%演示%'),
      ])).compile()
    expect(good.sql).toBe('select * from `orm_demo_item` where (`f_full_name` like ? or `f_en_code` like ?)')
    expect(good.parameters).toEqual(['%演示%', '%演示%'])
    // 反例钉死：varargs 形态（旧 API 习惯）静默编译出恒假条件——永远不要再犯
    const bad = kyselyFor<DemoDb>(fakeDatabase('mysql'))
      .selectFrom('orm_demo_item').selectAll()
      // 反例钉死：varargs 形态在运行时静默编译出恒假条件（回归钉子；类型面
      // 与该错误形态不合，显式叉掉——运行时 golden 断言照旧）。
      .where((({ or, eb }: { or: (...a: readonly unknown[]) => never; eb: (...a: readonly unknown[]) => never }) =>
        or(eb('f_full_name', 'like', '%演示%'), eb('f_en_code', 'like', '%演示%'))) as never).compile()
    expect(bad.sql).toBe('select * from `orm_demo_item` where 1 = 0')
  })

  it('未支持方言 fail loud 并列出支持清单', () => {
    expect(() => kyselyFor(fakeDatabase('sqlite' as RdbDatabase['dialect'])))
      .toThrow("不支持的方言 'sqlite'（database 'fake-sqlite'）——支持清单：mysql / kingbase / postgresql / oracle / dm")
  })
})
