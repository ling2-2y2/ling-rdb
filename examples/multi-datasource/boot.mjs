// 自含示例：多数据源（README「Multi-datasource」节的可跑形态）——命名多库
// 并存无运行时切换；注册表/服务键栅栏/事务换绑（mapper.use + kyselyFor 同一
// 事务字面量混写）/withConnection 共享连接。
// 消费者视角换包名 import 即同款：import { ... } from '@ling2/ling-rdb'
import {
  BaseMapper,
  RdbDatabaseRegistry,
  RdbError,
  defineTable,
  kyselyFor,
  rdbDatabaseServiceKey,
} from '../../src/index.ts'

/** 捕获型假库：连接原语翻旗标，语句按所属连接记录——验证「同一事务字面量」。 */
function fakeDatabase(name, dialect) {
  const calls = []
  const conn = {
    began: false, committed: false, rolledBack: false,
    async query(sql, params = []) { calls.push({ conn, sql, params }); return rows.shift() ?? [] },
    async execute(sql, params = []) { calls.push({ conn, sql, params }); return { affectedRows: 1, insertId: 0 } },
    async beginTransaction() { conn.began = true },
    async commit() { conn.committed = true },
    async rollback() { conn.rolledBack = true },
  }
  const rows = []
  return {
    facade: {
      name, dialect, identity: `${name}:memory`, calls,
      async query(sql, params = []) { return conn.query(sql, params) },
      async execute(sql, params = []) { return conn.execute(sql, params) },
      async withConnection(work) { return work(conn) },
      async transaction(work) {
        await conn.beginTransaction()
        try {
          const settled = await work(conn)
          await conn.commit()
          return settled
        } catch (error) { await conn.rollback(); throw error }
      },
      async close() {},
    },
    conn,
    rows,
  }
}

// ── ① 宿主装配语义：一行一库，注册名并存（orders=PG / billing=MySQL）──
const orders = fakeDatabase('orders', 'postgresql')
const billing = fakeDatabase('billing', 'mysql')
const registry = new RdbDatabaseRegistry()
registry.register('orders', { dialect: 'postgresql' })
registry.register('billing', { dialect: 'mysql' })
if (JSON.stringify(registry.names().sort()) !== JSON.stringify(['billing', 'orders'])) throw new Error('两库应并存')

// 服务键栅栏：provider 行按 `rdbDatabaseServiceKey(name)` 提供生命周期服务，
// 消费者 inject 该键等待库就绪后再 resolve（fence 语义，防行序竞态）
if (rdbDatabaseServiceKey('orders') !== 'rdb.database.orders') throw new Error('服务键派生不符')

let unknownThrew = false
try { registry.get('nope') } catch (error) { unknownThrew = error instanceof RdbError }
if (!unknownThrew) throw new Error('未知名应 fail loud')

// ── ② 消费者语义：声明需要的名字、各取各用（无全局「当前库」可切）──
const ORDER_ITEM = defineTable({
  table: 'order_item', id: 'f_id', tenant: 'f_tenant_id', audit: true, deleteMark: null,
  columns: { title: { column: 'f_title' }, amountCents: { column: 'f_amount_cents', type: 'int' } },
})
const orderMapper = new BaseMapper(ORDER_ITEM, { database: orders.facade })
const orderKy = kyselyFor(orders.facade)

// ── ③ 事务换绑：mbp 写与 orm 语句在**同一事务连接**上原子混写 ──
const txConnCalls = await orders.facade.transaction(async conn => {
  await orderMapper.use(conn).insert({ title: '订单 A', amountCents: 9900 })
  await kyselyFor(orders.facade, conn).updateTable('order_item')
    .set({ f_amount_cents: 8800 }).where('f_title', '=', '订单 A').execute()
  return orders.facade.calls.filter(call => call.conn === conn && !call.sql.startsWith('BEGIN')).length
})
if (txConnCalls < 2) throw new Error('mbp 与 orm 应同事务混写')
if (!orders.conn.began || !orders.conn.committed) throw new Error('事务应 begin→commit')

// 回滚语义：work 拒绝 → 整体回滚并原样上抛
let rolledBack = false
try {
  await orders.facade.transaction(async conn => {
    await orderMapper.use(conn).insert({ title: '会回滚的行', amountCents: 1 })
    throw new Error('业务失败')
  })
} catch { rolledBack = orders.conn.rolledBack }
if (!rolledBack) throw new Error('失败 work 应回滚')

// ── ④ withConnection：无事务但共享同一连接的多语句读 ──
orders.rows.push([{ n: 1 }], [{ n: 2 }])
const counts = await orders.facade.withConnection(async conn => {
  const first = await conn.query('SELECT COUNT(*) AS n FROM order_item')
  const second = await conn.query('SELECT COUNT(*) AS n FROM order_item_history')
  return [Number(first[0].n), Number(second[0].n)]
})
if (JSON.stringify(counts) !== JSON.stringify([1, 2])) throw new Error('共享连接读应回放两行')

// ── ⑤ 双库各用：billing 库照常走自己的门面（互不串扰）──
await billing.facade.execute('INSERT INTO invoice (f_order_id) VALUES (?)', ['o-1'])
if (!billing.facade.calls.at(-1).sql.includes('invoice')) throw new Error('billing 语句应落 billing 库')
if (orders.facade.calls.some(call => call.sql.includes('invoice'))) throw new Error('跨库不应串扰')

console.log('multi-datasource OK：注册表/服务键/事务混写/回滚/共享连接/双库各用全链通过')
