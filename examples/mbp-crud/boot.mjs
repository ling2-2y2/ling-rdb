// 自含示例：mbp 语义层完整 CRUD（README「mbp semantic layer」节的可跑形态；
// 描述符/Mapper/强制填充/Wrapper/分页/事务换绑照 ling-dsh-admin-pro portal 域
// 仓库形态）。捕获型假执行面记语句与参数——真实库上语句一致。
// 消费者视角换包名 import 即同款：import { ... } from '@ling2/ling-rdb'
import {
  BaseMapper,
  decodeRowWith,
  defineTable,
  mbpWrapper,
  runWithMbpFill,
} from '../../src/index.ts'

/** 捕获型假执行面（MbpExecutor 形状）：记语句/参数；rows = 结果集队列
 * （每次 query 消耗一个结果集，缺队回空集）。 */
class FakeExec {
  calls = []
  rows = []
  writeResult = { affectedRows: 1, insertId: 0 }

  async query(sql, params = []) {
    this.calls.push({ sql, params })
    return this.rows.shift() ?? []
  }

  async execute(sql, params = []) {
    this.calls.push({ sql, params })
    return this.writeResult
  }
}

// ── ① 声明表：一个描述符承载全部物理事实（照 portal.repository.ts 的
//      PORTAL_TABLE 形态；列定义顺序即物理列序）────────────────
const PORTAL_TABLE = defineTable({
  table: 'demo_portal',
  id: 'f_id',
  tenant: 'f_tenant_id',       // 租户分区列；null = 无分区（登记表类）
  audit: true,                 // 审计四列尾（creator/last_modify 对）
  deleteMark: 'f_delete_mark', // 逻辑删位；null = 硬删
  columns: {
    fullName: { column: 'f_full_name' },
    enCode: { column: 'f_en_code' },
    category: { column: 'f_category', nullable: true },
    type: { column: 'f_type', type: 'int', nullable: true },
    sortCode: { column: 'f_sort_code', type: 'int', nullable: true },
    enabledMark: { column: 'f_enabled_mark', type: 'bool', nullable: true },
  },
})

const exec = new FakeExec()
const FIXED_NOW = new Date(2026, 9, 15, 12, 0, 0)
const mapper = new BaseMapper(PORTAL_TABLE, { database: exec, now: () => FIXED_NOW })

// ── ② 强制填充插入：写路径无条件盖戳（id + creator 对 + 逻辑删位 + 租户）──
const created = await runWithMbpFill({ operatorId: 'op-1', tenantId: '000000' }, () =>
  mapper.insert({ fullName: '工作台门户', enCode: 'workbench', type: 0, sortCode: 1, enabledMark: true }))

const insertCall = exec.calls[0]
if (!insertCall.sql.startsWith('INSERT INTO demo_portal (f_id, ')) throw new Error('INSERT 列序应 id 在首')
if (!insertCall.sql.includes('f_creator_time, f_creator_user_id, f_last_modify_time, f_last_modify_user_id')) throw new Error('审计尾应盖戳')
if (!insertCall.sql.includes('f_delete_mark, f_tenant_id) VALUES')) throw new Error('逻辑删与租户位应收列尾')
if (typeof created.id !== 'string' || created.id === '') throw new Error('id 应由生成器落值')
if (created.creatorUserId !== 'op-1') throw new Error('creator 盖戳应取填充上下文')
if (created.tenantId !== '000000') throw new Error('租户盖戳应取填充上下文')
if (created.deleteMark !== 0) throw new Error('逻辑删位应初始化 0')
if (created.enabledMark !== true) throw new Error('bool 列应还原 true')
if (created.creatorTime !== FIXED_NOW.toISOString()) throw new Error('creatorTime 应为 ISO 串')

// 无填充上下文的写路径落 NULL（不炸、不猜）
const anonymous = await mapper.insert({ fullName: '无上下文行' })
if (anonymous.creatorUserId !== null || anonymous.tenantId !== null) throw new Error('无上下文应落 NULL')

// ── ③ 读 + 行映射：驱动物理行经描述符类型还原为记录 ──
exec.rows.push([{
  f_id: 'row-1', f_full_name: '工作台门户', f_en_code: 'workbench', f_category: null,
  f_type: '2', f_sort_code: 1, f_enabled_mark: 1,
  f_creator_time: '2026-10-15 12:00:00', f_creator_user_id: 'op-1',
  f_last_modify_time: null, f_last_modify_user_id: null, f_delete_mark: 0, f_tenant_id: '000000',
}])
const loaded = await mapper.selectById('row-1')
if (loaded.type !== 2) throw new Error('int 列应还原数值')
if (loaded.enabledMark !== true) throw new Error('bool 列应还原 true')
if (loaded.category !== null) throw new Error('NULL 应保持 null')

exec.rows.push([{ f_id: 'row-1', f_enabled_mark: 1 }])
const byCode = await runWithMbpFill({ operatorId: null, tenantId: '000000' }, () =>
  mapper.selectBy('enCode', 'workbench'))
if (byCode === undefined) throw new Error('selectBy 应命中')

// ── ④ Wrapper 类型化条件 + 分页双查 ──
const conditions = mbpWrapper(PORTAL_TABLE)
  .eq('type', 0)                                  // undefined 自动跳过（「传了才生效」）
  .keyword(['fullName', 'enCode'], '工作')        // (a LIKE ? OR b LIKE ?)
  .rawCmp('f_creator_time', '>=', '2026-01-01')   // 审计列逃生口（列名须固定字面量）
  .build()
exec.rows.push([{ n: 1 }], [])
const page = await runWithMbpFill({ operatorId: null, tenantId: '000000' }, () =>
  mapper.selectPage({ page: 2, pageSize: 10, conditions, order: ['f_sort_code ASC'] }))
const countSql = exec.calls.at(-2).sql
if (!countSql.includes('COUNT(*)')) throw new Error('分页应先 COUNT')
if (!countSql.includes('f_tenant_id = ?') || !countSql.includes('f_delete_mark IS NULL')) throw new Error('租户/未删谓词应自动前置')
if (!countSql.includes('(f_full_name LIKE ? OR f_en_code LIKE ?)')) throw new Error('keyword 组应生成')
const pageSql = exec.calls.at(-1).sql
if (!pageSql.includes('LIMIT ? OFFSET ?')) throw new Error('分页应带 LIMIT/OFFSET')

// ── ⑤ 更新：SET 白名单 = 描述符列（未知字段 fail loud）+ last_modify 盖戳 ──
const updated = await runWithMbpFill({ operatorId: 'op-2', tenantId: '000000' }, () =>
  mapper.updateById(created.id, { sortCode: 2, stranger: 'x' }).catch(() => 'rejected'))
if (updated !== 'rejected') throw new Error('未知字段应 fail loud')
await runWithMbpFill({ operatorId: 'op-2', tenantId: '000000' }, () => mapper.updateById(created.id, { sortCode: 2 }))
const updateCall = exec.calls.at(-1)
if (!updateCall.sql.startsWith('UPDATE demo_portal SET f_sort_code = ?, f_last_modify_time = ?')) throw new Error('SET 应白名单列 + last_modify 盖戳')

// ── ⑥ saveOrUpdate 分流：有 id 走更新、无 id 走插入 ──
const savedInsert = await runWithMbpFill({ operatorId: null, tenantId: '000000' }, () =>
  mapper.saveOrUpdate({ fullName: '新门户' }))
if (!exec.calls.at(-1).sql.startsWith('INSERT')) throw new Error('无 id 应走插入')
exec.rows.push([{ f_id: created.id, f_full_name: '改名门户' }])
const savedUpdate = await runWithMbpFill({ operatorId: null, tenantId: '000000' }, () =>
  mapper.saveOrUpdate({ id: created.id, fullName: '改名门户' }))
if (!exec.calls.at(-2).sql.startsWith('UPDATE')) throw new Error('有 id 应走更新（末条 SELECT 为回读）')
if (savedInsert.id === '' || savedUpdate?.fullName !== '改名门户') throw new Error('saveOrUpdate 返回形态不符')

// ── ⑦ 判重 / 批量读 / 逻辑删 ──
exec.rows.push([{ n: 0 }])
if (await mapper.existsBy('enCode', 'workbench', { excludeId: created.id }) !== false) throw new Error('判重应排除自身')
exec.rows.push([], [])
const batch = await mapper.selectByIds([created.id, 'row-1'])
if (!exec.calls.at(-1).sql.includes('IN (?, ?)')) throw new Error('批量读应生成 IN')
await mapper.deleteById(created.id, { deleteTime: '2026-10-15 12:00:00', deleteUserId: 'op-2' })
const deleteCall = exec.calls.at(-1)
if (!deleteCall.sql.startsWith('UPDATE demo_portal SET f_delete_mark = 1')) throw new Error('逻辑删表应 UPDATE 盖删位')

// ── ⑧ 事务换绑：mapper.use(conn) 让同一 mapper 跑在事务连接上 ──
const connCalls = []
const conn = {
  async query(sql, params = []) { connCalls.push({ sql, params }); return [] },
  async execute(sql, params = []) { connCalls.push({ sql, params }); return { affectedRows: 1, insertId: 0 } },
}
await mapper.use(conn).insert({ fullName: '事务内行' })
if (!connCalls[0].sql.startsWith('INSERT')) throw new Error('换绑后语句应落事务连接')

console.log('mbp-crud OK：描述符派生 CRUD/强制填充/Wrapper 分页/逻辑删/事务换绑全链通过')
