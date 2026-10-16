/**
 * 多数据源 —— README「Multi-datasource」一章的可跑孪生件。
 *
 * 命名多库并存，没有全局「当前库」可切：宿主一行一库，消费者按名字各取
 * 各用。重点演示事务换绑——mbp 的 mapper.use(conn) 与 orm 的
 * kyselyFor(db, conn) 在同一事务字面量里原子混写。
 *
 * 跑起来（无需真实数据库，语句由 examples/_lib 假库捕获并打印）：
 *   node --import tsx/esm examples/multi-datasource/boot.mjs
 */
import { BaseMapper, RdbDatabaseRegistry, defineTable, kyselyFor } from '../../src/index.ts'
import { fakeDatabase, lastCall, show, step } from '../_lib/fake-db.mjs'

// ── 宿主装配语义：一行一库，注册名并存 ────────────────────────────
// 真实宿主里这两行对应 cordis.yml 的 rdb-postgres-orders / rdb-mysql-billing：
// 每行按 rdbDatabaseServiceKey(name) 提供生命周期服务，消费者 inject 该键
// 等库就绪后再 resolve（fence 语义，防行序竞态）。
step('① 注册表：orders（PG）与 billing（MySQL）两库并存')
const orders = fakeDatabase('orders', 'postgresql')
const billing = fakeDatabase('billing', 'mysql')
const registry = new RdbDatabaseRegistry()
registry.register('orders', { dialect: 'postgresql' })
registry.register('billing', { dialect: 'mysql' })
console.log(`  已登记：${registry.names().sort().join('、')}（未知名取用直接 fail loud）`)

// ── 消费者语义：声明需要的名字，各取各用 ──────────────────────────
const ORDER_ITEM = defineTable({
  table: 'order_item', id: 'f_id', tenant: 'f_tenant_id', audit: true, deleteMark: null,
  columns: { title: { column: 'f_title' }, amountCents: { column: 'f_amount_cents', type: 'int' } },
})
const orderMapper = new BaseMapper(ORDER_ITEM, { database: orders })

// ── 事务换绑：mbp 写与 orm 语句同一事务连接原子混写 ────────────────
step('② 事务混写：mapper.use(conn) + kyselyFor(db, conn) 同一事务')
await orders.transaction(async conn => {
  await orderMapper.use(conn).insert({ title: '订单 A', amountCents: 9900 })
  await kyselyFor(orders, conn).updateTable('order_item')
    .set({ f_amount_cents: 8800 }).where('f_title', '=', '订单 A').execute()
})
show('INSERT（mbp 通道）：', lastCall(orders, 'INSERT INTO order_item'))
show('UPDATE（orm 通道，同一事务，kysely 语句为小写）：', lastCall(orders, 'update order_item'))
console.log(`  事务 ${orders.conn.began ? '已 begin' : '未 begin'} → ${orders.conn.committed ? '已 commit ✓' : '未 commit'}`)

// ── 回滚语义 ──────────────────────────────────────────────────────
step('③ 回滚：事务体抛错 → 整体回滚并原样上抛')
try {
  await orders.transaction(async conn => {
    await orderMapper.use(conn).insert({ title: '会回滚的行', amountCents: 1 })
    throw new Error('业务失败')
  })
} catch (error) {
  console.log(`  捕获到上抛的业务异常：「${error.message}」，事务 ${orders.conn.rolledBack ? '已 rollback ✓' : '未回滚'}`)
}

// ── withConnection：无事务但共享同一连接的多语句 ───────────────────
step('④ withConnection：两条查询共享同一连接（非事务）')
orders.rows.push([{ n: 1 }], [{ n: 2 }])
const counts = await orders.withConnection(async conn => {
  const first = await conn.query('SELECT COUNT(*) AS n FROM order_item')
  const second = await conn.query('SELECT COUNT(*) AS n FROM order_item_history')
  return [Number(first[0].n), Number(second[0].n)]
})
console.log(`  两次 COUNT 复用同一连接，结果：${JSON.stringify(counts)}`)

// ── 双库各用：互不串扰 ────────────────────────────────────────────
step('⑤ 双库各用：billing 的语句只落 billing')
await billing.execute('INSERT INTO invoice (f_order_id) VALUES (?)', ['o-1'])
show('billing 库：', lastCall(billing, 'invoice'))
console.log(`  orders 库有没有混进 invoice 语句？${orders.calls.some(call => call.sql.includes('invoice')) ? '有（不该发生）' : '没有 ✓'}`)

console.log('\nmulti-datasource 完成 ✓')
