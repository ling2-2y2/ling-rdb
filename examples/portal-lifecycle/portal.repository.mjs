/**
 * 门户域仓储层 —— 照 ling-dsh-admin-pro/src/portal/portal.repository.ts 形态：
 * 表描述符 + BaseMapper + 手写特型语句（判重/列表/三态数据），行映射走描述符。
 *
 * 职责边界：本层只管「数据怎么存取」；业务规则（判重拒绝、发布语义）在上层
 * portal.service.mjs。mapper/db 句柄不泄出本层。
 */
import { BaseMapper, currentMbpFill, decodeRowWith, defineTable } from '../../src/index.ts'

// ── 表描述符：物理事实的唯一登记处 ──────────────────────────────────
// 主表 demo_portal（门户定义）+ 数据表 demo_portal_data（一表三态：
// MODEL 设计稿 / CUSTOM 用户自定义 / RELEASE 发布快照）。

/** 门户主表。 */
export const PORTAL_TABLE = defineTable({
  table: 'demo_portal', id: 'f_id', tenant: 'f_tenant_id', audit: true, deleteMark: 'f_delete_mark',
  columns: {
    fullName:    { column: 'f_full_name' },
    enCode:      { column: 'f_en_code' },
    category:    { column: 'f_category', nullable: true },
    type:        { column: 'f_type', type: 'int', nullable: true },
    sortCode:    { column: 'f_sort_code', type: 'int', nullable: true },
    enabledMark: { column: 'f_enabled_mark', type: 'bool', nullable: true },
  },
})

/** 门户布局数据表（三态行）。 */
export const PORTAL_DATA_TABLE = defineTable({
  table: 'demo_portal_data', id: 'f_id', tenant: 'f_tenant_id', audit: true, deleteMark: 'f_delete_mark',
  columns: {
    portalId: { column: 'f_portal_id' },
    type:     { column: 'f_type' },
    platform: { column: 'f_platform' },
    formData: { column: 'f_form_data' },
  },
})

// ── 域异常：业务失败用异常不用返回值 ────────────────────────────────

/** 三态数据多行守卫：同键应至多命中一行，多行=数据被污染，绝不静默取首行。 */
export class PortalDataDuplicateError extends Error {
  constructor() { super('portal data: 同键多行（三态读守卫）') }
}

/** 编码已存在。 */
export class PortalCodeDuplicateError extends Error {
  constructor() { super('门户编码已存在') }
}

// ── 仓储 ────────────────────────────────────────────────────────────
const ALIVE = '(f_delete_mark IS NULL OR f_delete_mark = 0)' // 逻辑删行的统一存活谓词

export class PortalRepository {
  constructor(database) {
    this.database = database
    // 盖戳上下文从 mbp 强制填充作用域取（runWithMbpFill）——本层不碰会话
    const fill = () => ({
      operatorId: currentMbpFill()?.operatorId ?? null,
      tenantId: currentMbpFill()?.tenantId ?? null,
    })
    const shared = { database, fill }
    this.mapper = new BaseMapper(PORTAL_TABLE, shared)
    this.dataMapper = new BaseMapper(PORTAL_DATA_TABLE, shared)
  }

  /** 手写特型语句的统一出口。 */
  query(sql, params) { return this.database.query(sql, params) }

  /** 按主键读一行（mbp 派生语句 + 描述符行映射）。 */
  byId(id) { return this.mapper.selectById(id) }

  /** 插入（mbp 强制盖戳：id/审计四列/逻辑删位/租户）。 */
  insert(entity) { return this.mapper.insert(entity) }

  /**
   * 编码判重（源 isExistByEnCode 形态：等值 + 未删 + 租户 + 可排除自身）。
   * 注意租户绑定值写的是占位串——执行期会被租户拦截层换值成会话租户
   * （见 tenant-line 示例）；这样存量手写语句的租户语义由拦截层统一兜底。
   */
  async enCodeExists(enCode, excludeId) {
    const rows = await this.query(
      `SELECT COUNT(*) AS n FROM demo_portal WHERE f_en_code = ? AND ${ALIVE} AND f_tenant_id = ?${excludeId ? ' AND f_id <> ?' : ''}`,
      excludeId ? [enCode, 'raw-tenant', excludeId] : [enCode, 'raw-tenant'])
    return Number(rows[0]?.n ?? 0) > 0
  }

  /** 列表：keyword/category 过滤 + sortCode 排序 + 分页；行经描述符还原。 */
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

  /** 计数（与 list 同条件的 COUNT，供分页 total）。 */
  async count(query) {
    const where = [ALIVE, 'f_tenant_id = ?']
    const params = ['raw-tenant']
    if (query.keyword) { where.push('(f_full_name LIKE ? OR f_en_code LIKE ?)'); params.push(`%${query.keyword}%`, `%${query.keyword}%`) }
    const rows = await this.query(`SELECT COUNT(*) AS n FROM demo_portal WHERE ${where.join(' AND ')}`, params)
    return Number(rows[0]?.n ?? 0)
  }

  /** 三态数据读：CUSTOM 态按用户维过滤；多行抛守卫异常。 */
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

  /** 三态数据 upsert：读判存 → insert / updateById。 */
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
