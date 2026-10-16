/**
 * orm 语句构造层（Kysely）—— README「orm statement layer」一章的可跑孪生件。
 *
 * 复杂查询走 kyselyFor；语句仍全部经数据库门面执行（池/事务/租户包装零旁路）。
 * 本例演示一条真的复杂查询：三表 JOIN + 条件聚合 + GROUP BY + HAVING +
 * CASE WHEN + 分页，再看写三通道、sql 模板逃生口与事务绑定。
 *
 * 跑起来（无需真实数据库，生成的 SQL 由 examples/_lib 假库捕获并打印）：
 *   node --import tsx/esm examples/orm-queries/boot.mjs
 */
import { kyselyFor, sql } from '../../src/index.ts'
import { fakeDatabase, lastCall, show, step } from '../_lib/fake-db.mjs'

const db = fakeDatabase('demo', 'postgresql')
const ky = kyselyFor(db) // 方言按 database.dialect 分派（postgresql → PG 族编译器）

// ── ① 读：一条真的复杂查询 ──────────────────────────────────────────
// 门户表 JOIN 布局数据表（RELEASE 快照条件复合进 ON）再 JOIN 用户表取创建人；
// 聚合列里用 CASE WHEN 数「已发布数」，HAVING 卡至少两条数据，最后分页。
step('① 三表 JOIN + 条件聚合 + GROUP BY + HAVING + 分页')
db.rows.push([{ f_id: 'p-1', f_full_name: '工作台门户', creator_name: '张三', snapshot_count: '3', released_count: '1' }])
const found = await ky
  .selectFrom('demo_portal as p')
  .innerJoin('demo_portal_data as d', join =>
    join.onRef('d.f_portal_id', '=', 'p.f_id').on('d.f_type', '=', 'RELEASE')) // 条件进 ON
  .innerJoin('base_user as u', 'u.f_id', 'p.f_creator_user_id')
  .select(eb => [
    'p.f_id',
    'p.f_full_name',
    'u.f_full_name as creator_name',
    eb.fn.count('d.f_id').as('snapshot_count'),
    eb.fn.max('d.f_last_modify_time').as('last_release_at'),
    eb.fn.sum(eb.case().when('p.f_state', '=', 1).then(1).else(0).end()).as('released_count'),
  ])
  .where('p.f_tenant_id', '=', '000000')
  .where('p.f_enabled_mark', '=', 1)
  .groupBy(['p.f_id', 'p.f_full_name', 'u.f_full_name'])
  .having(eb => eb.fn.count('d.f_id'), '>=', 2)
  .orderBy('last_release_at', 'desc')   // 按聚合别名排序
  .limit(20)
  .offset(5)
  .execute()
show('编译产物（参数序 = ON → WHERE → HAVING → LIMIT → OFFSET）：', lastCall(db, 'select'), found)

// ── ② 写：三条通道 ──────────────────────────────────────────────────
// INSERT 走 query 通道（INSERT..RETURNING 需行集回传）；UPDATE / DELETE 走
// execute 通道——写计数位保真，kysely 的 numUpdatedRows 不会断成 0。
step('② 写：insert / update / delete 三通道')
await ky.insertInto('demo_portal').values({ f_full_name: '新门户', f_tenant_id: '000000' }).execute()
show('INSERT：', lastCall(db, 'insert into demo_portal'))

const updateResult = await ky.updateTable('demo_portal')
  .set({ f_sort_code: 2 })
  .where('f_id', '=', 'p-1')
  .executeTakeFirst()
show('UPDATE（注意 numUpdatedRows 是真计数）：', lastCall(db, 'update demo_portal'), { numUpdatedRows: updateResult.numUpdatedRows })

await ky.deleteFrom('demo_portal').where('f_id', '=', 'p-1').execute()
show('DELETE：', lastCall(db, 'delete from demo_portal'))

// ── ③ 构造器覆盖不到的形态：sql 模板逃生口 ──────────────────────────
// 相关子查询这类形态构造器表达不了——写 sql 模板；`${}` 里的值仍然参数绑定，
// 语句仍过门面（租户包装照常生效）。
step('③ sql 模板：相关子查询')
db.rows.push([{ f_id: 'p-1', last_release_at: '2026-10-15 12:00:00' }])
const latest = await sql`
  select p.f_id,
         (select max(d.f_last_modify_time) from demo_portal_data d
           where d.f_portal_id = p.f_id and d.f_type = 'RELEASE') as last_release_at
    from demo_portal p
    where p.f_tenant_id = ${'000000'} and p.f_enabled_mark = 1
`.execute(ky)
show('模板编译产物（${\'000000\'} 变成了参数位）：', lastCall(db, 'select max'), latest.rows)

// ── ④ 事务绑定 ──────────────────────────────────────────────────────
// kyselyFor(db, conn) 绑定事务连接后，事务控制权归外层门面——绑定实例自己
// 不再开新事务。这样 mapper.use(conn)、原生 conn.execute 与绑定 Kysely
// 可以在同一事务字面量里并用。
step('④ 事务绑定：kyselyFor(db, conn)')
await db.transaction(async conn => {
  const bound = kyselyFor(db, conn)
  await bound.insertInto('demo_portal_data').values({ f_portal_id: 'p-1', f_form_data: '{}' }).execute()
})
show('事务内语句（与 BEGIN/COMMIT 同一连接）：', lastCall(db, 'insert into demo_portal_data'))

console.log('\norm-queries 完成 ✓')
