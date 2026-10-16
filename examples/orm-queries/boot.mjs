// 自含示例：orm 语句构造层（Kysely）——复杂查询走 kyselyFor，语句仍全部
// 经数据库门面执行（池/事务/租户包装零旁路）。捕获型假库验证编译形态与
// 参数绑定——真实库上语句一致。
// 消费者视角换包名 import 即同款：import { kyselyFor, sql } from '@ling2/ling-rdb'
import { kyselyFor, sql } from '../../src/index.ts'

/** 捕获型假库（RdbDatabase 形状）：记语句/参数，读回放预置行；事务/连接
 * 原语只翻旗标不建连——语句出口统一 `?` 位置占位符。 */
function fakeDatabase() {
  const calls = []
  const conn = {
    began: false, committed: false, rolledBack: false,
    async query(sqlText, params = []) { calls.push({ conn, sql: sqlText, params }); return rows.shift() ?? [] },
    async execute(sqlText, params = []) { calls.push({ conn, sql: sqlText, params }); return { affectedRows: 1, insertId: 0 } },
    async beginTransaction() { conn.began = true },
    async commit() { conn.committed = true },
    async rollback() { conn.rolledBack = true },
  }
  const rows = []
  const db = {
    name: 'demo', dialect: 'postgresql', identity: 'demo:memory', calls,
    async query(sqlText, params = []) { return conn.query(sqlText, params) },
    async execute(sqlText, params = []) { return conn.execute(sqlText, params) },
    async withConnection(work) { return work(conn) },
    async transaction(work) {
      await conn.beginTransaction()
      try {
        const settled = await work(conn)
        await conn.commit()
        return settled
      } catch (error) {
        await conn.rollback()
        throw error
      }
    },
    async close() {},
  }
  return { db, conn, rows }
}

const { db, rows } = fakeDatabase()
const ky = kyselyFor(db) // 方言按 database.dialect 分派（postgresql → PG 族编译器）

// ── ① 读：三表 JOIN（条件复合进 ON）+ 条件聚合 + GROUP BY + HAVING + CASE WHEN + 分页 ──
rows.push([{ f_id: 'p-1', f_full_name: '工作台门户', creator_name: '张三', snapshot_count: '3', released_count: '1' }])
const found = await ky
  .selectFrom('demo_portal as p')
  .innerJoin('demo_portal_data as d', join =>
    join.onRef('d.f_portal_id', '=', 'p.f_id').on('d.f_type', '=', 'RELEASE'))
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
  .orderBy('last_release_at', 'desc')
  .limit(20)
  .offset(5)
  .execute()
const selectCall = db.calls.at(-1)
const lowered = selectCall.sql.toLowerCase()
if (!lowered.includes('inner join demo_portal_data')) throw new Error('数据表 JOIN 应编译')
if (!lowered.includes('inner join base_user')) throw new Error('用户表 JOIN 应编译')
if (!lowered.includes('group by')) throw new Error('分组应编译')
if (!lowered.includes('having count(d.f_id) >= ?')) throw new Error('HAVING 应编译')
if (!lowered.includes('sum(case when p.f_state = ? then 1 else 0 end)')) throw new Error('CASE WHEN 聚合应编译')
if (!lowered.includes('order by last_release_at desc')) throw new Error('别名排序应编译')
if (JSON.stringify(selectCall.params) !== JSON.stringify([1, 'RELEASE', '000000', 1, 2, 20, 5])) {
  throw new Error(`参数序应 ON→WHERE→HAVING→LIMIT→OFFSET：${JSON.stringify(selectCall.params)}`)
}
if (found[0].creator_name !== '张三' || Number(found[0].snapshot_count) !== 3) throw new Error('行应回放')

// ── ② 写：insert（query 通道——INSERT..RETURNING 需行集回传）/update/delete
//      （execute 通道——写计数位保真，kysely numUpdatedRows 不断 0）──
await ky.insertInto('demo_portal').values({ f_full_name: '新门户', f_tenant_id: '000000' }).execute()
if (!db.calls.at(-1).sql.startsWith('insert into demo_portal')) throw new Error('INSERT 应编译')

const updateResult = await ky.updateTable('demo_portal')
  .set({ f_sort_code: 2 })
  .where('f_id', '=', 'p-1')
  .executeTakeFirst()
if (updateResult.numUpdatedRows !== 1n) throw new Error('写计数位应保真（execute 通道）')

await ky.deleteFrom('demo_portal').where('f_id', '=', 'p-1').execute()
if (!db.calls.at(-1).sql.startsWith('delete from demo_portal')) throw new Error('DELETE 应编译')

// ── ③ 构造器覆盖不到的形态（相关子查询）走 sql 模板（值仍参数绑定，语句仍过门面）──
rows.push([{ f_id: 'p-1', last_release_at: '2026-10-15 12:00:00' }])
const latest = await sql`
  select p.f_id,
         (select max(d.f_last_modify_time) from demo_portal_data d
           where d.f_portal_id = p.f_id and d.f_type = 'RELEASE') as last_release_at
    from demo_portal p
    where p.f_tenant_id = ${'000000'} and p.f_enabled_mark = 1
`.execute(ky)
const rawCall = db.calls.at(-1)
if (rawCall.params[0] !== '000000') throw new Error('sql 模板值应参数绑定')
if (!rawCall.sql.includes('select max(d.f_last_modify_time)')) throw new Error('相关子查询应保留原文')
if (latest.rows[0].f_id !== 'p-1') throw new Error('sql 模板行应回放')

// ── ④ 事务绑定：kyselyFor(db, conn) 与外层 transaction 字面量同一连接 ──
// 契约：绑定实例的事务控制归外层门面（kyselyFor 第二参传入连接后，自身
// 不再开新事务）——mbp 的 mapper.use(conn)、原生 conn.execute 与绑定
// Kysely 在同一事务字面量里并用。
const txConnCalls = await db.transaction(async conn => {
  const bound = kyselyFor(db, conn)
  await bound.insertInto('demo_portal_data').values({ f_portal_id: 'p-1', f_form_data: '{}' }).execute()
  return db.calls.filter(call => call.conn === conn).length
})
if (txConnCalls < 2) throw new Error(`事务内语句应全落同一连接（含 begin/commit），实得 ${txConnCalls}`)

console.log('orm-queries OK：JOIN 分页/三通道写计数/sql 模板/事务绑定全链通过')
