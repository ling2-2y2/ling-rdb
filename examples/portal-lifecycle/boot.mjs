// 完整业务生命周期示例：照 ling-dsh-admin-pro/src/portal 域形态（types →
// migrations → repository → service → 创建/判重/列表/详情/三态数据/发布快照/
// 逻辑删）走通 rdb 两层（mbp 单表 CRUD + 手写特型 SQL）+ 强制填充 + 租户拦截
// 换值路径协作。捕获型假库读路径回放预置行——真实库上语句形态一致。
// 消费者视角换包名 import 即同款：import { ... } from '@ling2/ling-rdb'
import {
  BaseMapper,
  currentMbpFill,
  decodeRowWith,
  defineTable,
  migrateRdb,
  runWithMbpFill,
  runWithTenantLine,
  wrapTenantLineDatabase,
} from '../../src/index.ts'

// 迁移受 IS_INIT_DB 总开关闸——示例显式打开
process.env.IS_INIT_DB = 'true'

const VERSION_TABLE = 'demo_schema_version'
const ALIVE = '(f_delete_mark IS NULL OR f_delete_mark = 0)'

/** 门户记录（PortalRecord 形态：描述符字段 + 元字段惯例命名）。 @typedef {{
 * id: string, fullName: string|null, enCode: string|null, category: string|null,
 * type: number|null, sortCode: number|null, enabledMark: boolean|null,
 * creatorUserId: string|null, creatorTime: string|null, lastModifyTime: string|null,
 * deleteMark: number|null, tenantId: string|null }} PortalRecord */

/** 门户布局数据记录（base_portal_data 一表三态：MODEL/CUSTOM/RELEASE）。 @typedef {{
 * id: string, portalId: string|null, type: string|null, platform: string|null,
 * formData: string|null, creatorUserId: string|null }} PortalDataRecord */

// ── ① 捕获型假库：DDL 簿记 + 语句捕获 + 读回放预置行 + 连接旗标 ──
function memoryDatabase() {
  const applied = []
  const calls = []
  const rows = []
  const conn = {
    began: false, committed: false, rolledBack: false,
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (sql.startsWith('SELECT version FROM')) return applied.map(version => ({ version }))
      if (sql.includes(`INSERT INTO ${VERSION_TABLE}`)) applied.push(Number(params[0]))
      return rows.shift() ?? []
    },
    async execute(sql, params = []) { calls.push({ sql, params }); return { affectedRows: 1, insertId: 0 } },
    async beginTransaction() { conn.began = true },
    async commit() { conn.committed = true },
    async rollback() { conn.rolledBack = true },
  }
  const facade = {
    name: 'portal-demo', dialect: 'postgresql', identity: 'portal-demo:memory', calls,
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
  }
  return { facade, conn, rows, calls }
}

// ── ② 迁移（方言分派组：MySQL 列内 COMMENT / PG 走 COMMENT ON）──
const MIGRATIONS = [
  {
    version: 1,
    statements: [{
      mysql: [
        'CREATE TABLE demo_portal (f_id VARCHAR(36) NOT NULL PRIMARY KEY, f_full_name VARCHAR(200) NULL, f_en_code VARCHAR(100) NULL, f_category VARCHAR(50) NULL, f_type INT NULL, f_sort_code INT NULL, f_enabled_mark TINYINT NULL, f_creator_time DATETIME NULL, f_creator_user_id VARCHAR(36) NULL, f_last_modify_time DATETIME NULL, f_last_modify_user_id VARCHAR(36) NULL, f_delete_mark TINYINT NULL, f_tenant_id VARCHAR(50) NULL)',
        'CREATE TABLE demo_portal_data (f_id VARCHAR(36) NOT NULL PRIMARY KEY, f_portal_id VARCHAR(36) NULL, f_type VARCHAR(20) NULL, f_platform VARCHAR(50) NULL, f_form_data MEDIUMTEXT NULL, f_creator_time DATETIME NULL, f_creator_user_id VARCHAR(36) NULL, f_last_modify_time DATETIME NULL, f_last_modify_user_id VARCHAR(36) NULL, f_delete_mark TINYINT NULL, f_tenant_id VARCHAR(50) NULL)',
      ],
      postgresql: [
        'CREATE TABLE demo_portal (f_id VARCHAR(36) NOT NULL PRIMARY KEY, f_full_name VARCHAR(200) NULL, f_en_code VARCHAR(100) NULL, f_category VARCHAR(50) NULL, f_type INT NULL, f_sort_code INT NULL, f_enabled_mark SMALLINT NULL, f_creator_time TIMESTAMP NULL, f_creator_user_id VARCHAR(36) NULL, f_last_modify_time TIMESTAMP NULL, f_last_modify_user_id VARCHAR(36) NULL, f_delete_mark SMALLINT NULL, f_tenant_id VARCHAR(50) NULL)',
        'CREATE TABLE demo_portal_data (f_id VARCHAR(36) NOT NULL PRIMARY KEY, f_portal_id VARCHAR(36) NULL, f_type VARCHAR(20) NULL, f_platform VARCHAR(50) NULL, f_form_data TEXT NULL, f_creator_time TIMESTAMP NULL, f_creator_user_id VARCHAR(36) NULL, f_last_modify_time TIMESTAMP NULL, f_last_modify_user_id VARCHAR(36) NULL, f_delete_mark SMALLINT NULL, f_tenant_id VARCHAR(50) NULL)',
      ],
    }],
  },
]

// ── ③ 数据访问层（portal.repository.ts 形态：描述符 + 双 Mapper + 特型语句）──
const PORTAL_TABLE = defineTable({
  table: 'demo_portal', id: 'f_id', tenant: 'f_tenant_id', audit: true, deleteMark: 'f_delete_mark',
  columns: {
    fullName: { column: 'f_full_name' },
    enCode: { column: 'f_en_code' },
    category: { column: 'f_category', nullable: true },
    type: { column: 'f_type', type: 'int', nullable: true },
    sortCode: { column: 'f_sort_code', type: 'int', nullable: true },
    enabledMark: { column: 'f_enabled_mark', type: 'bool', nullable: true },
  },
})

const PORTAL_DATA_TABLE = defineTable({
  table: 'demo_portal_data', id: 'f_id', tenant: 'f_tenant_id', audit: true, deleteMark: 'f_delete_mark',
  columns: {
    portalId: { column: 'f_portal_id' },
    type: { column: 'f_type' },
    platform: { column: 'f_platform' },
    formData: { column: 'f_form_data' },
  },
})

/** 三态数据多行守卫（portal 的 VS414 语义——键应命中至多一行）。 */
class PortalDataDuplicateError extends Error {
  constructor() { super('portal data: 同键多行（三态读守卫）') }
}

/** 业务失败用异常不用返回值（portal.errors.ts 形态）。 */
class PortalCodeDuplicateError extends Error {
  constructor() { super('门户编码已存在') }
}

class PortalRepository {
  constructor(database) {
    this.database = database
    const fill = () => ({
      operatorId: currentMbpFill()?.operatorId ?? null,
      tenantId: currentMbpFill()?.tenantId ?? null,
    })
    const shared = { database, fill }
    this.mapper = new BaseMapper(PORTAL_TABLE, shared)
    this.dataMapper = new BaseMapper(PORTAL_DATA_TABLE, shared)
  }

  query(sql, params) { return this.database.query(sql, params) }

  byId(id) { return this.mapper.selectById(id) }

  insert(entity) { return this.mapper.insert(entity) }

  /** 编码判重（源 isExistByEnCode 形态：等值 + 未删 + 租户 + 可排除自身）。 */
  async enCodeExists(enCode, excludeId) {
    const rows = await this.query(
      `SELECT COUNT(*) AS n FROM demo_portal WHERE f_en_code = ? AND ${ALIVE} AND f_tenant_id = ?${excludeId ? ' AND f_id <> ?' : ''}`,
      excludeId ? [enCode, 'raw-tenant', excludeId] : [enCode, 'raw-tenant'])
    return Number(rows[0]?.n ?? 0) > 0
  }

  /** 列表（keyword/category 过滤 + sortCode 排序 + 分页；行经描述符类型还原）。 */
  async list(query) {
    const where = [ALIVE, 'f_tenant_id = ?']
    const params = ['raw-tenant']
    if (query.keyword) { where.push('(f_full_name LIKE ? OR f_en_code LIKE ?)'); params.push(`%${query.keyword}%`, `%${query.keyword}%`) }
    if (query.category) { where.push('f_category = ?'); params.push(query.category) }
    const size = query.pageSize ?? 20
    const page = Math.max(1, query.page ?? 1)
    const limitSql = size > 0 ? ' LIMIT ? OFFSET ?' : ''
    if (size > 0) params.push(size, (page - 1) * size)
    const rows = await this.query(
      `SELECT * FROM demo_portal WHERE ${where.join(' AND ')} ORDER BY f_sort_code ASC${limitSql}`, params)
    return rows.map(row => decodeRowWith(PORTAL_TABLE, row))
  }

  async count(query) {
    const where = [ALIVE, 'f_tenant_id = ?']
    const params = ['raw-tenant']
    if (query.keyword) { where.push('(f_full_name LIKE ? OR f_en_code LIKE ?)'); params.push(`%${query.keyword}%`, `%${query.keyword}%`) }
    const rows = await this.query(`SELECT COUNT(*) AS n FROM demo_portal WHERE ${where.join(' AND ')}`, params)
    return Number(rows[0]?.n ?? 0)
  }

  /** 三态数据读（CUSTOM 态按用户维过滤；多行抛守卫异常）。 */
  async dataOf(portalId, type, platform, creatorUserId) {
    const params = [portalId, type]
    let sql = 'SELECT * FROM demo_portal_data WHERE f_portal_id = ? AND f_type = ?'
    if (creatorUserId !== undefined) { sql += ' AND f_platform = ? AND f_creator_user_id = ?'; params.push(platform, creatorUserId) }
    else { sql += ' AND f_platform = ?'; params.push(platform) }
    sql += ` AND ${ALIVE} AND f_tenant_id = ?`
    params.push('raw-tenant')
    const rows = await this.query(sql, params)
    if (rows.length === 0) return undefined
    if (rows.length > 1) throw new PortalDataDuplicateError()
    return decodeRowWith(PORTAL_DATA_TABLE, rows[0])
  }

  /** 三态数据 upsert（读判存 → insert / updateById）。 */
  async upsertData(portalId, type, platform, formData, creatorUserId) {
    const existing = await this.dataOf(portalId, type, platform, creatorUserId)
    if (existing === undefined) {
      await this.dataMapper.insert({ id: crypto.randomUUID(), portalId, type, platform, formData })
      return 'inserted'
    }
    await this.dataMapper.updateById(existing.id, { formData })
    return 'updated'
  }
}

// ── ④ 业务层（判重走异常；发布 = RELEASE 快照行）──
class PortalService {
  constructor(repository) { this.repo = repository }

  async create(input) {
    if (await this.repo.enCodeExists(input.enCode)) throw new PortalCodeDuplicateError()
    return this.repo.insert({ ...input, enabledMark: 1 })
  }

  async saveCustomLayout(portalId, formData, userId) {
    return this.repo.upsertData(portalId, 'CUSTOM', 'default', formData, userId)
  }

  async publishSnapshot(portalId, platform, formData) {
    return this.repo.upsertData(portalId, 'RELEASE', platform, formData)
  }

  async listPage(query) {
    const items = await this.repo.list(query)
    return { total: await this.repo.count(query), items }
  }

  async remove(id) { return this.repo.mapper.deleteById(id) }
}

// ── ⑤ 全生命周期驱动 ──
const memory = memoryDatabase()
// 租户拦截换值路径：手写 f_tenant_id = ? 的存量语句绑定值在执行期改写为
// 会话租户（portal 存量仓的真实形态）；mbp 写路径盖戳与此互不干扰
const db = wrapTenantLineDatabase(memory.facade, {
  column: 'f_tenant_id', tables: ['demo_portal', 'demo_portal_data'],
})
await migrateRdb(db, { table: VERSION_TABLE, migrations: MIGRATIONS })
if (!memory.calls.some(call => call.sql.includes('CREATE TABLE demo_portal ('))) throw new Error('迁移应建表')

const runLifecycle = async () => {
  const repo = new PortalRepository(db)
  const svc = new PortalService(repo)

  // 1) 创建：mbp 强制盖戳（id/creator 对/逻辑删位/租户）
  const created = await svc.create({ fullName: '工作台门户', enCode: 'workbench', type: 0, sortCode: 1 })
  if (typeof created.id !== 'string' || created.tenantId !== '000000') throw new Error('创建应带完整盖戳')
  const insertCall = memory.calls.find(call => call.sql.startsWith('INSERT INTO demo_portal ('))
  if (!insertCall.sql.includes('f_creator_time, f_creator_user_id')) throw new Error('INSERT 应盖审计戳')

  // 2) 重复编码被业务异常拒绝（判重 COUNT 命中行回放；租户绑定值被拦截层换值）
  memory.rows.push([{ n: 1 }])
  let duplicateRejected = false
  try { await svc.create({ fullName: '同码门户', enCode: 'workbench' }) } catch (error) {
    duplicateRejected = error instanceof PortalCodeDuplicateError
  }
  if (!duplicateRejected) throw new Error('重复编码应抛业务异常')
  const countCall = memory.calls.filter(call => call.sql.includes('COUNT(*) AS n FROM demo_portal')).at(-1)
  if (countCall.params.at(-1) !== '000000') throw new Error('判重租户绑定值应被换值')

  // 3) 列表：keyword 过滤 + 分页 + 行映射
  memory.rows.push([{
    f_id: created.id, f_full_name: '工作台门户', f_en_code: 'workbench', f_category: null,
    f_type: 0, f_sort_code: 1, f_enabled_mark: 1, f_creator_time: '2026-10-15 12:00:00',
    f_creator_user_id: 'op-admin', f_last_modify_time: null, f_last_modify_user_id: null,
    f_delete_mark: 0, f_tenant_id: '000000',
  }], [{ n: 1 }])
  const page = await svc.listPage({ keyword: '工作', page: 1, pageSize: 10 })
  const listCall = memory.calls.filter(call => call.sql.includes('ORDER BY f_sort_code')).at(-1)
  if (!listCall.sql.includes('(f_full_name LIKE ? OR f_en_code LIKE ?)')) throw new Error('keyword 组应生成')
  if (!listCall.sql.includes('LIMIT ? OFFSET ?')) throw new Error('分页应带 LIMIT/OFFSET')
  if (listCall.params[0] !== '000000') throw new Error('列表租户绑定值应被换值')
  if (page.total !== 1 || page.items[0].enCode !== 'workbench' || page.items[0].enabledMark !== true) {
    throw new Error('列表行映射不符')
  }

  // 4) 三态数据：CUSTOM 布局首存 insert、再存 update（last_modify 盖戳）
  if (await svc.saveCustomLayout(created.id, '{"widgets":[1]}', 'user-1') !== 'inserted') throw new Error('首存应 insert')
  memory.rows.push([{
    f_id: 'data-1', f_portal_id: created.id, f_type: 'CUSTOM', f_platform: 'default',
    f_form_data: '{"widgets":[1]}', f_creator_time: '2026-10-15 12:00:00', f_creator_user_id: 'user-1',
    f_last_modify_time: null, f_last_modify_user_id: null, f_delete_mark: 0, f_tenant_id: '000000',
  }])
  if (await svc.saveCustomLayout(created.id, '{"widgets":[1,2]}', 'user-1') !== 'updated') throw new Error('再存应 update')
  const dataUpdateCall = memory.calls.filter(call => call.sql.startsWith('UPDATE demo_portal_data SET')).at(-1)
  if (!dataUpdateCall.sql.includes('f_last_modify_time = ?')) throw new Error('数据行更新应盖 last_modify')

  // 5) 发布快照（RELEASE 行独立于 CUSTOM 存在）
  if (await svc.publishSnapshot(created.id, 'pc', '{"widgets":[1]}') !== 'inserted') throw new Error('发布应落 RELEASE 快照')

  // 6) 三态读多行守卫：同键两行 → 抛 PortalDataDuplicateError
  memory.rows.push([{ f_id: 'd-1' }, { f_id: 'd-2' }])
  let guardThrew = false
  try { await repo.dataOf(created.id, 'CUSTOM', 'default', 'user-1') } catch (error) {
    guardThrew = error instanceof PortalDataDuplicateError
  }
  if (!guardThrew) throw new Error('三态读多行应抛守卫异常')

  // 7) 逻辑删：UPDATE 盖删位；再查列表为空
  if (!await svc.remove(created.id)) throw new Error('逻辑删应命中')
  const removeCall = memory.calls.filter(call => call.sql.startsWith('UPDATE demo_portal SET f_delete_mark = 1')).at(-1)
  if (!removeCall.sql.includes('f_tenant_id = ?')) throw new Error('删除应带租户谓词')
  memory.rows.push([], [{ n: 0 }])
  const after = await svc.listPage({ keyword: '工作' })
  if (after.total !== 0 || after.items.length !== 0) throw new Error('已删行不应再出现')
}

// 会话双上下文：租户拦截（换值路径）+ mbp 强制填充同作用域协作
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  runWithMbpFill({ operatorId: 'op-admin', tenantId: '000000' }, runLifecycle))

console.log('portal-lifecycle OK：迁移→创建→判重→列表→三态数据→发布→守卫→逻辑删 全周期通过')
