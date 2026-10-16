/**
 * 完整业务生命周期 —— 照 ling-dsh-admin-pro/src/portal 域形态走通 rdb 全家：
 * 迁移 → 仓储（portal.repository.mjs）→ 服务（portal.service.mjs）→
 * 创建/判重/列表/三态数据/发布快照/多行守卫/逻辑删。
 *
 * 三层协作一次看全：mbp 强制填充盖写路径、租户拦截换值兜手写语句、
 * 描述符行映射还原读路径。
 *
 * 跑起来（无需真实数据库，语句由 examples/_lib 假库捕获并打印）：
 *   node --import tsx/esm examples/portal-lifecycle/boot.mjs
 */
import { migrateRdb, runWithMbpFill, runWithTenantLine, wrapTenantLineDatabase } from '../../src/index.ts'
import { fakeDatabase, lastCall, show, step } from '../_lib/fake-db.mjs'
import { PortalCodeDuplicateError, PortalDataDuplicateError, PortalRepository } from './portal.repository.mjs'
import { PortalService } from './portal.service.mjs'

// 迁移受 IS_INIT_DB 总开关闸——示例显式打开
process.env.IS_INIT_DB = 'true'

const VERSION_TABLE = 'demo_schema_version'

// 方言分派组迁移：MySQL 列内 COMMENT / PG 走 COMMENT ON（migrations 示例有详解）
const MIGRATIONS = [
  {
    version: 1,
    statements: [{
      mysql: [
        `CREATE TABLE demo_portal (
           f_id VARCHAR(36) NOT NULL PRIMARY KEY, f_full_name VARCHAR(200) NULL COMMENT '门户名',
           f_en_code VARCHAR(100) NULL, f_category VARCHAR(50) NULL, f_type INT NULL, f_sort_code INT NULL,
           f_enabled_mark TINYINT NULL, f_creator_time DATETIME NULL, f_creator_user_id VARCHAR(36) NULL,
           f_last_modify_time DATETIME NULL, f_last_modify_user_id VARCHAR(36) NULL,
           f_delete_mark TINYINT NULL, f_tenant_id VARCHAR(50) NULL)`,
        `CREATE TABLE demo_portal_data (
           f_id VARCHAR(36) NOT NULL PRIMARY KEY, f_portal_id VARCHAR(36) NULL COMMENT '所属门户',
           f_type VARCHAR(20) NULL, f_platform VARCHAR(50) NULL, f_form_data MEDIUMTEXT NULL,
           f_creator_time DATETIME NULL, f_creator_user_id VARCHAR(36) NULL,
           f_last_modify_time DATETIME NULL, f_last_modify_user_id VARCHAR(36) NULL,
           f_delete_mark TINYINT NULL, f_tenant_id VARCHAR(50) NULL)`,
      ],
      postgresql: [
        `CREATE TABLE demo_portal (
           f_id VARCHAR(36) NOT NULL PRIMARY KEY, f_full_name VARCHAR(200) NULL,
           f_en_code VARCHAR(100) NULL, f_category VARCHAR(50) NULL, f_type INT NULL, f_sort_code INT NULL,
           f_enabled_mark SMALLINT NULL, f_creator_time TIMESTAMP NULL, f_creator_user_id VARCHAR(36) NULL,
           f_last_modify_time TIMESTAMP NULL, f_last_modify_user_id VARCHAR(36) NULL,
           f_delete_mark SMALLINT NULL, f_tenant_id VARCHAR(50) NULL)`,
        `CREATE TABLE demo_portal_data (
           f_id VARCHAR(36) NOT NULL PRIMARY KEY, f_portal_id VARCHAR(36) NULL,
           f_type VARCHAR(20) NULL, f_platform VARCHAR(50) NULL, f_form_data TEXT NULL,
           f_creator_time TIMESTAMP NULL, f_creator_user_id VARCHAR(36) NULL,
           f_last_modify_time TIMESTAMP NULL, f_last_modify_user_id VARCHAR(36) NULL,
           f_delete_mark SMALLINT NULL, f_tenant_id VARCHAR(50) NULL)`,
        `COMMENT ON COLUMN demo_portal.f_full_name IS '门户名'`,
        `COMMENT ON COLUMN demo_portal_data.f_portal_id IS '所属门户'`,
      ],
    }],
  },
]

// 假库 + 租户拦截包装：仓储手写语句里的占位租户值在执行期被换成会话租户
const db = fakeDatabase('portal-demo', 'postgresql')
const tenantDb = wrapTenantLineDatabase(db, {
  column: 'f_tenant_id', tables: ['demo_portal', 'demo_portal_data'],
})

step('⓪ 迁移：两张表按 PG 方言支建好')
await migrateRdb(tenantDb, { table: VERSION_TABLE, migrations: MIGRATIONS })
const ddlCount = db.calls.filter(call => /^(CREATE|ALTER|COMMENT)/i.test(call.sql.trim())).length
console.log(`  应用了 ${ddlCount} 条 DDL（簿记表 CREATE + 两张业务表 + 两条 COMMENT ON）`)

const runLifecycle = async () => {
  const repo = new PortalRepository(tenantDb)
  const svc = new PortalService(repo)

  // 1) 创建：mbp 强制盖戳
  step('① 创建门户：业务只给 4 个字段，戳全自动盖')
  const created = await svc.create({ fullName: '工作台门户', enCode: 'workbench', type: 0, sortCode: 1 })
  show('INSERT（f_id → 业务列 → 审计尾 → 删位/租户）：', lastCall(db, 'INSERT INTO demo_portal ('),
    { id: created.id, creatorUserId: created.creatorUserId, tenantId: created.tenantId, deleteMark: created.deleteMark })

  // 2) 重复编码：判重 COUNT 命中 → 业务异常拒绝（看参数：占位租户已被换成 000000）
  step('② 重复编码被业务异常拒绝（租户拦截换值同时可见）')
  db.rows.push([{ n: 1 }])
  try {
    await svc.create({ fullName: '同码门户', enCode: 'workbench' })
  } catch (error) {
    show('判重语句（占位租户 raw-tenant 执行时已换成 000000）：', lastCall(db, 'COUNT(*) AS n FROM demo_portal'))
    console.log(`  结果 → ${error instanceof PortalCodeDuplicateError ? 'PortalCodeDuplicateError ✓' : error.message}`)
  }

  // 3) 列表：keyword 过滤 + 分页 + 行映射
  step('③ 列表分页：动态 where + LIMIT/OFFSET + 描述符行映射')
  db.rows.push([{
    f_id: created.id, f_full_name: '工作台门户', f_en_code: 'workbench', f_category: null,
    f_type: 0, f_sort_code: 1, f_enabled_mark: 1, f_creator_time: '2026-10-15 12:00:00',
    f_creator_user_id: 'op-admin', f_delete_mark: 0, f_tenant_id: '000000',
  }], [{ n: 1 }])
  const pageResult = await svc.listPage({ keyword: '工作', page: 1, pageSize: 10 })
  show('列表语句（keyword 组 + 排序 + 分页）：', lastCall(db, 'ORDER BY f_sort_code'))
  console.log(`  返回 total=${pageResult.total}，首行 enCode=${pageResult.items[0]?.enCode}，enabledMark=${pageResult.items[0]?.enabledMark}`)

  // 4) 三态数据：CUSTOM 首存 insert、再存 update（last_modify 盖戳）
  step('④ 三态数据：CUSTOM 自定义布局首存 → 再存')
  console.log(`  首存（无行 → insert）：${await svc.saveCustomLayout(created.id, '{"widgets":[1]}', 'user-1')}`)
  db.rows.push([{
    f_id: 'data-1', f_portal_id: created.id, f_type: 'CUSTOM', f_platform: 'default',
    f_form_data: '{"widgets":[1]}', f_creator_time: '2026-10-15 12:00:00', f_creator_user_id: 'user-1',
    f_delete_mark: 0, f_tenant_id: '000000',
  }])
  console.log(`  再存（命中行 → update）：${await svc.saveCustomLayout(created.id, '{"widgets":[1,2]}', 'user-1')}`)
  show('再存语句（SET 带 last_modify 盖戳）：', lastCall(db, 'UPDATE demo_portal_data'))

  // 5) 发布快照：RELEASE 行独立于 CUSTOM 存在
  step('⑤ 发布：落 RELEASE 快照（平台维，与 CUSTOM 互不覆盖）')
  console.log(`  发布（pc 平台）：${await svc.publishSnapshot(created.id, 'pc', '{"widgets":[1]}')}`)

  // 6) 三态读多行守卫：同键两行 → 守卫异常
  step('⑥ 守卫演示：同键两行被读出 → PortalDataDuplicateError')
  db.rows.push([{ f_id: 'd-1' }, { f_id: 'd-2' }])
  try {
    await repo.dataOf(created.id, 'CUSTOM', 'default', 'user-1')
  } catch (error) {
    console.log(`  结果 → ${error instanceof PortalDataDuplicateError ? 'PortalDataDuplicateError ✓（绝不静默取首行）' : error.message}`)
  }

  // 7) 逻辑删：UPDATE 盖删位；列表随即为空
  step('⑦ 逻辑删：行不物理消失，列表随即为空')
  await svc.remove(created.id)
  show('删除语句（UPDATE 盖 f_delete_mark，带租户谓词）：', lastCall(db, 'f_delete_mark = 1'))
  db.rows.push([], [{ n: 0 }])
  const after = await svc.listPage({ keyword: '工作' })
  console.log(`  删除后再查：total=${after.total}，items=${after.items.length} 条`)
}

// 会话双上下文：租户拦截（换值路径）+ mbp 强制填充（盖戳路径）同作用域协作
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  runWithMbpFill({ operatorId: 'op-admin', tenantId: '000000' }, runLifecycle))

console.log('\nportal-lifecycle 完成 ✓')
