/**
 * mbp 单表 CRUD —— README「mbp 语义层」一章的可跑孪生件。
 *
 * 一个表描述符 + 一个 BaseMapper 撑起单表全套增删改查：业务代码只写业务列，
 * 主键、审计四列、逻辑删位、租户列全部自动盖戳。
 *
 * 跑起来（无需真实数据库，生成的 SQL 由 examples/_lib 假库捕获并打印）：
 *   node --import tsx/esm examples/mbp-crud/boot.mjs
 */
import { BaseMapper, defineTable, mbpWrapper, runWithMbpFill } from '../../src/index.ts'
import { fakeDatabase, lastCall, show, step } from '../_lib/fake-db.mjs'

// ── 声明表：一个描述符承载全部物理事实 ────────────────────────────
// 照 ling-dsh-admin-pro 的 portal.repository.ts 形态：id / 租户列 / 审计开关 /
// 逻辑删位属于「登记」；columns 只写「属性名 → 物理列」映射，定义顺序即物理列序。
const PORTAL_TABLE = defineTable({
  table: 'demo_portal',
  id: 'f_id',
  tenant: 'f_tenant_id',        // 租户分区列；null = 无分区（登记表类）
  audit: true,                  // 审计四列（creator / last_modify 对）
  deleteMark: 'f_delete_mark',  // 逻辑删位；null = 硬删
  columns: {
    fullName:    { column: 'f_full_name' },
    enCode:      { column: 'f_en_code' },
    category:    { column: 'f_category', nullable: true },
    type:        { column: 'f_type', type: 'int', nullable: true },
    sortCode:    { column: 'f_sort_code', type: 'int', nullable: true },
    enabledMark: { column: 'f_enabled_mark', type: 'bool', nullable: true },
  },
})

const db = fakeDatabase()
// 固定演示时刻，让打印里的时间戳稳定可读
const FIXED_NOW = new Date(2026, 9, 15, 12, 0, 0)
const mapper = new BaseMapper(PORTAL_TABLE, { database: db, now: () => FIXED_NOW })

// ── 插入：强制填充 ────────────────────────────────────────────────
// 业务代码只传业务列；写路径无条件盖戳——id 随机生成、creator 对与租户取
// 填充上下文（runWithMbpFill 作用域）、逻辑删位初始化 0。
step('① 插入：强制填充（id + 审计四列 + 逻辑删位 + 租户全自动盖）')
const created = await runWithMbpFill({ operatorId: 'op-1', tenantId: '000000' }, () =>
  mapper.insert({ fullName: '工作台门户', enCode: 'workbench', type: 0, sortCode: 1, enabledMark: true }))
show('业务只写了 5 个业务列，INSERT 却是全列（f_id → 业务列 → 审计尾 → 删位/租户）：',
  lastCall(db, 'INSERT INTO demo_portal'), created)

// 没有填充上下文时审计与租户落 NULL——不炸、不猜
const anonymous = await mapper.insert({ fullName: '无上下文行' })
show('无填充上下文的写路径：', lastCall(db, 'INSERT INTO demo_portal'), anonymous)

// ── 读：行映射 ────────────────────────────────────────────────────
// 假库按队列回放一行「数据库原样」的物理行——驱动返回的 int 是数字 2、
// bool 是 true、NULL 保持 null，全由描述符类型还原。
step('② 读：物理行经描述符类型还原')
db.rows.push([{
  f_id: 'row-1', f_full_name: '工作台门户', f_en_code: 'workbench', f_category: null,
  f_type: '2', f_sort_code: 1, f_enabled_mark: 1,
  f_creator_time: '2026-10-15 12:00:00', f_creator_user_id: 'op-1',
  f_delete_mark: 0, f_tenant_id: '000000',
}])
const loaded = await mapper.selectById('row-1')
show('selectById（驱动出的 f_type = "2" / f_enabled_mark = 1）：', lastCall(db, 'SELECT'), loaded)

// ── Wrapper 类型化条件 + 分页双查 ─────────────────────────────────
// COUNT 与取页两条语句同条件：租户、未删谓词自动前置，业务条件跟在后面。
step('③ Wrapper 条件 + 分页双查')
const conditions = mbpWrapper(PORTAL_TABLE)
  .eq('type', 0)                                  // undefined 自动跳过（传了才生效）
  .keyword(['fullName', 'enCode'], '工作')        // (fullName LIKE ? OR enCode LIKE ?)
  .rawCmp('f_creator_time', '>=', '2026-01-01')   // 审计列逃生口（列名须固定字面量）
  .build()
db.rows.push([{ n: 7 }], [{ f_id: 'row-1', f_full_name: '工作台门户', f_en_code: 'workbench' }])
const page = await mapper.selectPage({ page: 2, pageSize: 10, conditions, order: ['f_sort_code ASC'] })
show('第 1 条 COUNT：', lastCall(db, 'COUNT(*)'))
show('第 2 条取页：', lastCall(db, 'LIMIT'))
show('返回（total + 行映射后的 items）：', null, page)

// ── 更新：SET 白名单 + last_modify 盖戳 ───────────────────────────
step('④ 更新：SET 白名单 = 描述符列；未知字段 fail loud')
try {
  await mapper.updateById(created.id, { stranger: 'x' })
} catch (error) {
  console.log(`  未知字段被拒绝：${error.message}`)
}
await runWithMbpFill({ operatorId: 'op-2', tenantId: '000000' }, () =>
  mapper.updateById(created.id, { sortCode: 2 }))
show('合法更新（SET 只有白名单列 + last_modify 盖戳）：', lastCall(db, 'UPDATE demo_portal'))

// ── saveOrUpdate 分流：有 id 走更新、无 id 走插入 ─────────────────
step('⑤ saveOrUpdate 分流')
await mapper.saveOrUpdate({ fullName: '新门户' })
show('无 id → INSERT：', lastCall(db, 'INSERT INTO demo_portal'))
db.rows.push([{ f_id: created.id, f_full_name: '改名门户' }]) // 喂给更新后的回读 SELECT
const saved = await mapper.saveOrUpdate({ id: created.id, fullName: '改名门户' })
show('有 id → UPDATE（并回读）：', lastCall(db, 'UPDATE demo_portal'), saved)

// ── 判重 / 批量读 / 逻辑删 ────────────────────────────────────────
step('⑥ 判重、批量读与逻辑删')
db.rows.push([{ n: 0 }])
const exists = await mapper.existsBy('enCode', 'workbench', { excludeId: created.id })
show('existsBy 判重（排除自身）：', lastCall(db, 'COUNT'), exists)

const batch = await mapper.selectByIds([created.id, 'row-1'])
show('selectByIds 批量读（IN）：', lastCall(db, 'IN'), batch)

await mapper.deleteById(created.id, { deleteTime: '2026-10-15 12:00:00', deleteUserId: 'op-2' })
show('deleteById：逻辑删表走 UPDATE 盖删位（不是 DELETE）：', lastCall(db, 'f_delete_mark'))

// ── 事务换绑 ──────────────────────────────────────────────────────
// mapper.use(conn) 让同一 mapper 在事务连接上跑——和外层 transaction 字面量
// 天然同一事务（多数据源示例里有 mbp + orm 混写的完整形态）。
step('⑦ 事务换绑：mapper.use(conn)')
await db.transaction(async conn => {
  await mapper.use(conn).insert({ fullName: '事务内行' })
})
show('事务内语句（begin → … → commit 全程同一连接）：', lastCall(db, 'INSERT INTO demo_portal'))

console.log('\nmbp-crud 完成 ✓')
