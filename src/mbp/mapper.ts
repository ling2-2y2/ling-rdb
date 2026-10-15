/**
 * BaseMapper——描述符派生的 CRUD 四件套 + 分页 + saveOrUpdate（方案 C
 * P0 主体，MyBatis-Plus BaseMapper 的对应物）。SQL 全部是描述符派生的
 * 内联 `?` 占位符语句（与手写常量同一形态，字节可审计），全部流量经
 * {@link MbpExecutor}（RdbDatabase 或事务连接）——不建连、不开池、零旁路。
 *
 * **强制填充（MetaObjectHandler 等价）**：走本 mapper 的写路径必盖戳——
 * insert 无条件生成 id + creator 对 + 逻辑删位 + 租户；updateById 无条件
 * 追加 last_modify 对。调用方无法跳过（值来源见 {@link ./fill.ts}）。
 *
 * 记录侧元字段固定命名（Ling 域记录惯例）：`id` / `tenantId` /
 * `creatorTime` / `creatorUserId` / `lastModifyTime` / `lastModifyUserId` /
 * `deleteMark`；数据字段名由描述符 columns 键给定。
 * @module @ling2/ling-rdb/hub/mbp/mapper
 */
import { randomUUID } from 'node:crypto'
import type { MbpTableDescriptor } from './descriptor.ts'
import { columnOf } from './descriptor.ts'
import { decodeRowWith, decodeValue, encodeValue } from './rowmap.ts'
import { toSqlDateTime } from './datetime.ts'
import type { MbpFillSource, MbpFillValues } from './fill.ts'
import { alsFillSource, NULL_FILL } from './fill.ts'
import type { RdbListCondition, RdbListQuery } from '../kit/query.ts'
import { buildRdbListQuery, inFragment } from '../kit/query.ts'
import type { RdbWriteResult } from '../hub/types.ts'

/** id 生成器注入点（裁定②：默认 randomUUID 保现状语义；切 Ling Snowflake 时换实现）。 */
export type IdentifierGenerator = () => string

/** 默认 id 生成器：randomUUID（36 位带连字符）。 */
export const randomUuidGenerator: IdentifierGenerator = () => randomUUID()

/** 执行面：RdbDatabase 与事务连接（RdbConnection）都结构满足。 */
export interface MbpExecutor {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>
  execute(sql: string, params?: readonly unknown[]): Promise<RdbWriteResult>
}

/** mapper 构造项。 */
export interface MbpMapperOptions {
  /** 执行面（库外观；事务内用 {@link BaseMapper.use} 换绑连接）。 */
  readonly database: MbpExecutor
  /** 填充值来源；缺省读请求作用域 ALS（runWithMbpFill）。 */
  readonly fill?: MbpFillSource
  /** id 生成器；缺省 randomUUID。 */
  readonly idGenerator?: IdentifierGenerator
  /** 时钟；缺省真实时间（测试注入定值）。 */
  readonly now?: () => Date
}

/** 分页查询入参。 */
export interface MbpPageQuery {
  /** 1 起页码；缺省 1。 */
  readonly page?: number
  /** 页大小；缺省 20。 */
  readonly pageSize?: number
  /** 附加条件（Wrapper 或声明式）；租户与逻辑删谓词由 mapper 自动前置。 */
  readonly conditions?: readonly RdbListCondition[]
  /** ORDER BY 项（固定标识符文本，调用方拥有）。 */
  readonly order?: readonly string[]
}

/** 分页结果。 */
export interface MbpPage<T> {
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly items: readonly T[]
}

/** 逻辑删谓词（NULL 安全——真实库存量行存在 NULL 位）。 */
const notDeletedFragment = (column: string): string => `(${column} IS NULL OR ${column} = 0)`

/**
 * 一张表的派生 CRUD mapper。
 * @typeParam T - 消费者声明的记录类型（描述符字段 + 元字段惯例命名）。
 */
export class BaseMapper<T extends object> {
  private readonly fill: MbpFillSource
  private readonly idGenerator: IdentifierGenerator
  private readonly now: () => Date

  constructor(
    /** 本 mapper 服务的表描述符。 */
    public readonly descriptor: MbpTableDescriptor,
    private readonly options: MbpMapperOptions,
  ) {
    this.fill = options.fill ?? alsFillSource
    this.idGenerator = options.idGenerator ?? randomUuidGenerator
    // now seam 归一为 Date：部分域的 clock seam 直接回毫秒数（旧 codec 的
    // number 契约），mapper 内部统一按 Date 消费（2026-09-05 批E oauth 域）。
    const rawNow = options.now ?? ((): Date => new Date())
    this.now = () => new Date(rawNow())
  }

  /** 换绑执行面（事务内：`mapper.use(conn)` 返回同配置的事务版）。 */
  use(exec: MbpExecutor): BaseMapper<T> {
    return new BaseMapper<T>(this.descriptor, { ...this.options, database: exec })
  }

  private fillValues(): MbpFillValues {
    return this.fill() ?? NULL_FILL
  }

  /** `WHERE id = ? [AND tenant = ?]` 片段与参数（租户仅在分区表且有会话租户时出现）。 */
  private idWhere(id: string): { sql: string; params: unknown[] } {
    const desc = this.descriptor
    if (desc.id === null) throw new Error(`mbp: 表 ${desc.table} 无 id 位，不能按 id 操作`)
    const tenantId = this.fillValues().tenantId
    if (desc.tenant !== null && tenantId !== null) {
      return { sql: ` WHERE ${desc.id} = ? AND ${desc.tenant} = ?`, params: [id, tenantId] }
    }
    return { sql: ` WHERE ${desc.id} = ?`, params: [id] }
  }

  /**
   * 插入一行（强制盖戳：id + creator 对 + 逻辑删位 + 租户；modify 对按
   * 家族惯例落 NULL——对齐 Ling insertFill 只填 creator 的语义）。id 位
   * 沿用 MyBatis-Plus 语义：**entity 携带非空 id 时用之（saveOrUpdate 的
   * unknown-id 插入分支保留调用方 id），缺席才走 IdentifierGenerator**
   * （消费方 action 域 `update({id:'x'})` 落插分支时
   * 回读必须命中传入 id）。
   * @param entity - 数据字段（缺省字段落 NULL）。
   * @returns 完整记录（含 id 与元字段，ISO 时间串）。
   */
  async insert(entity: Partial<T> & Record<string, unknown>): Promise<T> {
    const desc = this.descriptor
    const values = this.fillValues()
    const now = this.now()
    const columns: string[] = []
    const params: unknown[] = []
    const record: Record<string, unknown> = { ...entity }
    if (desc.id !== null) {
      columns.push(desc.id)
      const manual = entity.id
      const id = typeof manual === 'string' && manual !== '' ? manual : this.idGenerator()
      params.push(id)
      record.id = id
    }
    for (const field of desc.fields) {
      const spec = desc.columns[field]!
      columns.push(spec.column)
      const raw = entity[field]
      params.push(encodeValue(spec, raw))
      // 归一记录侧形态（Date→ISO、对象 json 克隆、bool 还原）
      record[field] = decodeValue(spec, encodeValue(spec, raw))
    }
    if (desc.audit) {
      columns.push('f_creator_time', 'f_creator_user_id', 'f_last_modify_time', 'f_last_modify_user_id')
      params.push(this.sqlNow(), values.operatorId, null, null)
      record.creatorTime = now.toISOString()
      record.creatorUserId = values.operatorId
      record.lastModifyTime = null
      record.lastModifyUserId = null
    }
    if (desc.deleteMark !== null) {
      columns.push(desc.deleteMark)
      params.push(0)
      record.deleteMark = 0
    }
    if (desc.tenant !== null) {
      columns.push(desc.tenant)
      params.push(values.tenantId)
      record.tenantId = values.tenantId
    }
    await this.options.database.execute(
      `INSERT INTO ${desc.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      params,
    )
    return record as T
  }

  /**
   * 按 id 更新数据列（动态 SET 白名单 = 描述符字段集，未知字段 fail loud；
   * SET 尾无条件追加 last_modify 对）。
   * @param id - 主键值。
   * @param patch - 要更新的数据字段。
   * @returns 命中且更新了 1 行为 true；行不存在（或租户外）为 false。
   */
  async updateById(id: string, patch: Partial<T> & Record<string, unknown>): Promise<boolean> {
    const desc = this.descriptor
    const sets: string[] = []
    const params: unknown[] = []
    for (const [field, value] of Object.entries(patch)) {
      const spec = desc.columns[field]
      if (spec === undefined) {
        throw new Error(`mbp: 表 ${desc.table} 更新拒绝未知字段 ${JSON.stringify(field)}（白名单=描述符列）`)
      }
      if (value === undefined) continue
      sets.push(`${spec.column} = ?`)
      params.push(encodeValue(spec, value))
    }
    if (desc.audit) {
      sets.push('f_last_modify_time = ?', 'f_last_modify_user_id = ?')
      params.push(this.sqlNow(), this.fillValues().operatorId)
    }
    if (sets.length === 0) return true
    const where = this.idWhere(id)
    params.push(...where.params)
    const result = await this.options.database.execute(
      `UPDATE ${desc.table} SET ${sets.join(', ')}${where.sql}`,
      params,
    )
    return result.affectedRows === 1
  }

  /**
   * 按 id 删除：描述符带逻辑删位 → `UPDATE SET <mark> = 1`（可携带富化
   * 删除戳：Ling 语义的 delete_time/delete_user_id 位）；否则物理 DELETE。
   * @param id - 主键值。
   * @param opts - 逻辑删富化位（仅逻辑删表生效）：`deleteTime` 传
   *   `toSqlDateTime(now)` 形态的本地时区文本，`deleteUserId` 传操作人。
   * @returns 命中为 true。
   */
  async deleteById(id: string, opts: { deleteTime?: string; deleteUserId?: string | null } = {}): Promise<boolean> {
    const desc = this.descriptor
    const where = this.idWhere(id)
    let sql: string
    if (desc.deleteMark === null) {
      sql = `DELETE FROM ${desc.table}${where.sql}`
    } else {
      const sets = [`${desc.deleteMark} = 1`]
      // 富化位列名从描述符外按 Ling 惯例固定名探测（无该列的表传了也忽略）；
      // lead 参数序必须与 SET 子句序一致（曾因逐个 unshift 把序反掉：delete_user
      // 抢了 delete_time 的位——真连报 Incorrect datetime value 'system'）
      const leadParams: unknown[] = []
      if (opts.deleteTime !== undefined && desc.fields.some(f => desc.columns[f]!.column === 'f_delete_time')) {
        sets.push('f_delete_time = ?')
        leadParams.push(opts.deleteTime)
      }
      if (opts.deleteUserId !== undefined && desc.fields.some(f => desc.columns[f]!.column === 'f_delete_user_id')) {
        sets.push('f_delete_user_id = ?')
        leadParams.push(opts.deleteUserId)
      }
      where.params.unshift(...leadParams)
      sql = `UPDATE ${desc.table} SET ${sets.join(', ')}${where.sql}`
    }
    const result = await this.options.database.execute(sql, where.params)
    return result.affectedRows === 1
  }

  /** 驱动行 → 完整记录（元字段惯例命名 + 类型驱动数据字段；公共纯函数形态见 {@link decodeRowWith}）。 */
  decode(row: Record<string, unknown>): T {
    return decodeRowWith<T>(this.descriptor, row)
  }

  /** 单行读的公共选项：`forUpdate` 附加行锁（SQL 标准语法，MySQL/pg/Oracle 族通用）。 */
  private async selectOne(whereSql: string, params: readonly unknown[], forUpdate: boolean): Promise<T | undefined> {
    const desc = this.descriptor
    const notDeleted = desc.deleteMark === null ? '' : ` AND ${notDeletedFragment(desc.deleteMark)}`
    const lock = forUpdate ? ' FOR UPDATE' : ''
    const rows = await this.options.database.query<Record<string, unknown>>(
      `SELECT ${desc.projection.join(', ')} FROM ${desc.table}${whereSql}${notDeleted}${lock}`,
      params,
    )
    const row = rows[0]
    return row === undefined ? undefined : this.decode(row)
  }

  /**
   * 按 id 读一行（逻辑删表自动带未删谓词；租户谓词同 updateById 规则）。
   * @param id - 主键值。
   * @param opts - `forUpdate: true` 附带行锁（事务内：先 `mapper.use(conn)`）。
   * @returns 记录；不存在或已删返回 undefined。
   */
  async selectById(id: string, opts: { forUpdate?: boolean } = {}): Promise<T | undefined> {
    const where = this.idWhere(id)
    return this.selectOne(where.sql, where.params, opts.forUpdate === true)
  }

  /**
   * 按非主键列等值读一行（Ling 高频动词：按账号/编码取记录）。
   * @param field - 描述符字段名（白名单外 fail loud）。
   * @param value - 等值。
   * @param opts - `forUpdate: true` 附带行锁（事务内使用）。
   * @returns 记录；无匹配/已删返回 undefined。
   */
  async selectBy(field: string, value: unknown, opts: { forUpdate?: boolean } = {}): Promise<T | undefined> {
    const column = columnOf(this.descriptor, field)
    const parts = [`${column} = ?`]
    const params: unknown[] = [value]
    const tenantId = this.fillValues().tenantId
    if (this.descriptor.tenant !== null && tenantId !== null) {
      parts.push(`${this.descriptor.tenant} = ?`)
      params.push(tenantId)
    }
    return this.selectOne(` WHERE ${parts.join(' AND ')}`, params, opts.forUpdate === true)
  }

  /**
   * 分页双查（rows + COUNT 共享 WHERE；逻辑删/租户谓词自动前置，调用方
   * 条件接在其后——参数序 = 谓词出现序）。
   * @param query - 分页与条件。
   * @returns 总数与当页记录。
   */
  async selectPage(query: MbpPageQuery = {}): Promise<MbpPage<T>> {
    const desc = this.descriptor
    const page = Math.max(1, query.page ?? 1)
    const pageSize = Math.max(1, query.pageSize ?? 20)
    const conditions: RdbListCondition[] = []
    const tenantId = this.fillValues().tenantId
    if (desc.tenant !== null && tenantId !== null) {
      conditions.push({ kind: 'tenant', value: tenantId })
    }
    if (desc.deleteMark !== null) {
      conditions.push({ kind: 'raw', sql: notDeletedFragment(desc.deleteMark) })
    }
    conditions.push(...query.conditions ?? [])
    const built: RdbListQuery = buildRdbListQuery({
      table: desc.table,
      columns: desc.projection,
      conditions,
      order: query.order ?? [],
      tenantColumn: desc.tenant,
      paging: { pageSize, offset: (page - 1) * pageSize },
    })
    // 家族惯例：先 COUNT 后取行（dsh-demo page / store historyPage 同序）
    const countRows = await this.options.database.query<{ n?: unknown }>(built.countSql, built.countParams)
    const items = await this.options.database.query<Record<string, unknown>>(built.sql, built.params)
    return {
      total: Number(countRows[0]?.n ?? 0),
      page,
      pageSize,
      items: items.map(row => this.decode(row)),
    }
  }

  /**
   * 有 id 走更新、无 id 走插入（**Ling `BaseServiceImpl.saveOrUpdate` 分流
   * 语义**，2026-09-05（十三）对齐：不做"更新未命中回退插入"）。
   * @param entity - 数据字段；可带 `id`（记录惯例位）决定更新目标。
   * @returns 落库后的完整记录；带 id 更新未命中返回 null（Ling 返回 false 的记录形态）。
   */
  async saveOrUpdate(entity: Partial<T> & Record<string, unknown>): Promise<T | null> {
    const id = entity.id
    if (typeof id === 'string' && id !== '') {
      const { id: _ignored, ...patch } = entity
      void _ignored
      if (await this.updateById(id, patch as Partial<T> & Record<string, unknown>)) {
        return await this.selectById(id) ?? null
      }
      return null
    }
    return this.insert(entity)
  }

  /**
   * 按 id 批量读（Ling `listByIds` 语义）：IN + 未删谓词 + 租户谓词。
   * @param ids - 主键值清单；空清单返回空数组。
   */
  async selectByIds(ids: readonly string[]): Promise<readonly T[]> {
    if (ids.length === 0) return []
    const conditions: RdbListCondition[] = [{
      kind: 'raw',
      sql: inFragment(this.descriptor.id!, [...ids]),
      params: [...ids],
    }]
    const tenantId = this.fillValues().tenantId
    if (this.descriptor.tenant !== null && tenantId !== null) conditions.push({ kind: 'tenant', value: tenantId })
    if (this.descriptor.deleteMark !== null) {
      conditions.push({ kind: 'raw', sql: notDeletedFragment(this.descriptor.deleteMark) })
    }
    const built = buildRdbListQuery({
      table: this.descriptor.table,
      columns: this.descriptor.projection,
      conditions,
      order: [this.descriptor.id!],
    })
    const rows = await this.options.database.query<Record<string, unknown>>(built.sql, built.params)
    return rows.map(row => this.decode(row))
  }

  /**
   * 批量逻辑删（Ling `BaseService.deleteLogic` 语义：盖 update 戳 + 逻辑删；
   * 富化位同 {@link deleteById}）。
   * @param ids - 主键值清单；空清单返回 false。
   */
  async deleteByIds(ids: readonly string[], opts: { deleteTime?: string; deleteUserId?: string | null } = {}): Promise<boolean> {
    if (ids.length === 0) return false
    const desc = this.descriptor
    if (desc.deleteMark === null) {
      // 硬删表：物理 DELETE IN
      const parts = [`${desc.id} IN (${ids.map(() => '?').join(', ')})`]
      const params: unknown[] = [...ids]
      const tenantId = this.fillValues().tenantId
      if (desc.tenant !== null && tenantId !== null) { parts.push(`${desc.tenant} = ?`); params.push(tenantId) }
      const result = await this.options.database.execute(`DELETE FROM ${desc.table} WHERE ${parts.join(' AND ')}`, params)
      return result.affectedRows === ids.length
    }
    const sets = [`${desc.deleteMark} = 1`]
    const leadParams: unknown[] = []
    if (opts.deleteTime !== undefined && desc.fields.some(f => desc.columns[f]!.column === 'f_delete_time')) {
      sets.push('f_delete_time = ?'); leadParams.push(opts.deleteTime)
    }
    if (opts.deleteUserId !== undefined && desc.fields.some(f => desc.columns[f]!.column === 'f_delete_user_id')) {
      sets.push('f_delete_user_id = ?'); leadParams.push(opts.deleteUserId)
    }
    const parts = [`${desc.id} IN (${ids.map(() => '?').join(', ')})`, notDeletedFragment(desc.deleteMark)]
    const params: unknown[] = [...leadParams, ...ids]
    const tenantId = this.fillValues().tenantId
    if (desc.tenant !== null && tenantId !== null) { parts.push(`${desc.tenant} = ?`); params.push(tenantId) }
    const result = await this.options.database.execute(
      `UPDATE ${desc.table} SET ${sets.join(', ')} WHERE ${parts.join(' AND ')}`, params)
    return result.affectedRows === ids.length
  }

  /**
   * 字段值是否已存在（Ling `BaseService.isFieldDuplicate` 语义——编辑判重
   * 的通用动词）：等值 + 未删 + 租户谓词，可排除自身 id。
   * @param field - 描述符字段名。
   * @param value - 待判重的值。
   * @param opts - `excludeId`：编辑场景排除自身。
   */
  async existsBy(field: string, value: unknown, opts: { excludeId?: string } = {}): Promise<boolean> {
    const column = columnOf(this.descriptor, field)
    const conditions: RdbListCondition[] = [{ kind: 'eq', column, value }]
    if (opts.excludeId !== undefined && this.descriptor.id !== null) {
      conditions.push({ kind: 'raw', sql: `${this.descriptor.id} <> ?`, params: [opts.excludeId] })
    }
    const tenantId = this.fillValues().tenantId
    if (this.descriptor.tenant !== null && tenantId !== null) conditions.push({ kind: 'tenant', value: tenantId })
    if (this.descriptor.deleteMark !== null) {
      conditions.push({ kind: 'raw', sql: notDeletedFragment(this.descriptor.deleteMark) })
    }
    const built = buildRdbListQuery({
      table: this.descriptor.table,
      columns: ['COUNT(*) AS n'],
      conditions,
      order: [],
    })
    const rows = await this.options.database.query<{ n?: unknown }>(built.sql, built.params)
    return Number(rows[0]?.n ?? 0) > 0
  }

  /** now → SQL DATETIME 参数（本地时区文本）。 */
  private sqlNow(): string {
    return toSqlDateTime(this.now())!
  }
}
