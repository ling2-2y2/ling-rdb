/**
 * 表描述符——`@TableName` + `@TableField` + `@TableId` + `@TableLogic`
 * 元数据的去装饰器形态（方案 C / ORM 引入方案 §6.2）。一个描述符声明
 * 一张 Ling 风格表的全部物理事实（表名 / 主键位 / 租户位 / 审计尾 /
 * 逻辑删位 / 列类型），{@link ./mapper.ts BaseMapper} 与
 * {@link ./rowmap.ts 行映射}全部由它派生——消费者不再手写 INSERT 列序、
 * SELECT 投影与审计盖戳。
 *
 * 列定义顺序即物理列序（`Object.keys` 语义）：id → 数据列（定义序）→
 * 审计四列 → 逻辑删位 → 租户位，与 `query.ts` 的 rdbTableColumns 家族
 * 约定一致。
 * @module dsh-rdb/src/mbp/descriptor
 */

import { RDB_AUDIT_COLUMNS } from '../query.ts'

/** 数据列类型——驱动行映射与参数编码的依据。 */
export type MbpColumnType = 'string' | 'int' | 'bool' | 'datetime' | 'json'

/** 一列的物理事实。 */
export interface MbpColumnSpec {
  /** 物理列名（如 `f_en_code`）。 */
  readonly column: string
  /** 列类型；默认 `'string'`。 */
  readonly type?: MbpColumnType
  /** 允许 NULL（解码侧 null 语义声明；默认 false 仅作文档位，不做拦截）。 */
  readonly nullable?: boolean
}

/** 描述符裸规格（defineTable 入参）。 */
export interface MbpTableSpec {
  /** 表名（固定标识符，进 DML 文本——勿拼接用户输入）。 */
  readonly table: string
  /** 主键列；null/缺省 = 无 id 位（罕见）。 */
  readonly id?: string | null
  /** 租户分区列；null/缺省 = 无分区（登记表类）。 */
  readonly tenant?: string | null
  /** 是否带审计四列尾（f_creator_time/f_creator_user_id/f_last_modify_time/f_last_modify_user_id）。 */
  readonly audit: boolean
  /** 逻辑删列（`@TableLogic` 位）；null/缺省 = 硬删。 */
  readonly deleteMark?: string | null
  /** 数据列：字段名（记录侧 camelCase）→ 物理事实。 */
  readonly columns: Readonly<Record<string, MbpColumnSpec>>
}

/** 冻结后的表描述符（BaseMapper/行映射/Wrapper 的唯一事实源）——
 * `id`/`tenant`/`deleteMark` 在输出侧恒为归一化后的 `string | null`。 */
export interface MbpTableDescriptor extends Omit<MbpTableSpec, 'id' | 'tenant' | 'deleteMark'> {
  /** 主键列；归一化后 null = 无 id 位。 */
  readonly id: string | null
  /** 租户分区列；归一化后 null = 无分区。 */
  readonly tenant: string | null
  /** 逻辑删列；归一化后 null = 硬删。 */
  readonly deleteMark: string | null
  /** 数据字段名清单（定义序）。 */
  readonly fields: readonly string[]
  /** 物理数据列清单（定义序）。 */
  readonly dataColumns: readonly string[]
  /** 审计四列（audit=false 时为空）。 */
  readonly auditColumns: readonly string[]
  /** 完整投影列序：id → 数据 → 审计 → 逻辑删 → 租户。 */
  readonly projection: readonly string[]
}

/**
 * 声明一张表的描述符（`@TableName` 家族元数据的对象形态）。
 * @param spec - 表规格。
 * @returns 冻结的描述符。
 * @throws 表名不合法（防注入：进 DML 文本的固定标识符必须象合法标识名）。
 */
export function defineTable(spec: MbpTableSpec): MbpTableDescriptor {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.table)) {
    throw new Error(`mbp: 非法表名 ${JSON.stringify(spec.table)}`)
  }
  // 归一化缺席位（undefined → null）：`=== null` 判定遍布 mapper，漏归一
  // 会把 `undefined` 拼进 SQL 文本（2026-09-05 批C 踩坑：action 表缺省
  // deleteMark 时 MiniSql 报 `unparsed comparison 'undefined IS NULL'`）。
  const id = spec.id ?? null
  const tenant = spec.tenant ?? null
  const deleteMark = spec.deleteMark ?? null
  const fields = Object.keys(spec.columns)
  const dataColumns = fields.map(field => spec.columns[field]!.column)
  const auditColumns = spec.audit ? [...RDB_AUDIT_COLUMNS] : []
  const projection = [
    ...(id === null ? [] : [id]),
    ...dataColumns,
    ...auditColumns,
    ...(deleteMark === null ? [] : [deleteMark]),
    ...(tenant === null ? [] : [tenant]),
  ]
  const seen = new Set<string>()
  for (const column of projection) {
    if (seen.has(column)) throw new Error(`mbp: 表 ${spec.table} 列 ${column} 重复`)
    seen.add(column)
  }
  return Object.freeze({
    ...spec,
    id,
    tenant,
    deleteMark,
    columns: Object.freeze(spec.columns),
    fields: Object.freeze(fields),
    dataColumns: Object.freeze(dataColumns),
    auditColumns: Object.freeze(auditColumns),
    projection: Object.freeze(projection),
  })
}

/**
 * 字段名 → 物理列名（Wrapper/校验用）。
 * @param descriptor - 表描述符。
 * @param field - 记录侧字段名。
 * @returns 物理列名。
 * @throws 未知字段 fail loud（列名只能来自描述符，永不拼接用户输入）。
 */
export function columnOf(descriptor: MbpTableDescriptor, field: string): string {
  const spec = descriptor.columns[field]
  if (spec === undefined) {
    throw new Error(`mbp: 表 ${descriptor.table} 无字段 ${JSON.stringify(field)}（描述符列清单外）`)
  }
  return spec.column
}
