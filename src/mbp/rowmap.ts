/**
 * 类型驱动的行映射（方案 C / §6.2.4）：按描述符列类型自动完成
 * 「记录值 ↔ SQL 参数 ↔ 驱动行」三态转换——datetime 进参数转本地文本、
 * 出行转 ISO 串；json 进参数序列化、出行解析（容忍驱动已解析对象与
 * 文本两种形态）；bool 进参数 true→1/false→0、出行还原布尔。新域不再
 * 手写 `toIso(row.…)` 系列（存量手写不动，§6.3）。
 * @module @ling2/ling-rdb/hub/mbp/rowmap
 */
import type { MbpColumnSpec, MbpTableDescriptor } from './descriptor.ts'
import { toIsoDateTime, toSqlDateTime } from './datetime.ts'
import { stringifyJsonColumn } from '../kit/json-text.ts'
export { toIsoDateTime }

/**
 * 一个记录值 → SQL 绑定参数（按列类型编码）。
 * @param spec - 列规格。
 * @param value - 记录侧值。
 * @returns 绑定参数（null 语义：`undefined` 收敛为 null）。
 */
export function encodeValue(spec: MbpColumnSpec, value: unknown): unknown {
  if (value === undefined) return null
  switch (spec.type ?? 'string') {
    case 'datetime':
      return toSqlDateTime(value as Date | string | null)
    case 'json':
      // PG jsonb 拒收 \u0000/孤立代理项转义，序列化统一走净化出口
      return value === null ? null : stringifyJsonColumn(value)
    case 'bool':
      return value === null ? null : value ? 1 : 0
    case 'int':
      return value === null ? null : Number(value)
    default:
      return value
  }
}

/**
 * 一个驱动行值 → 记录侧值（按列类型解码）。
 * @param spec - 列规格。
 * @param value - 驱动返回值。
 * @returns 记录侧值。
 */
export function decodeValue(spec: MbpColumnSpec, value: unknown): unknown {
  if (value === null || value === undefined) return spec.nullable === true ? null : (spec.type === 'json' ? null : value)
  switch (spec.type ?? 'string') {
    case 'datetime':
      return toIsoDateTime(value)
    case 'json':
      if (typeof value === 'string') {
        if (value === '') return null
        // MySQL JSON 列回的是合法 JSON 文本（串值带引号），parse 恒成；
        // PG 驱动已把 jsonb 标量预解成裸串（jsonb "auto" → auto），裸串
        // parse 必炸（tc-1102 真机实证）——parse 失败回落原串保真。
        try {
          return JSON.parse(value)
        } catch {
          return value
        }
      }
      return value
    case 'bool':
      return Number(value) !== 0
    case 'int':
      return Number(value)
    default:
      return typeof value === 'string' ? value : String(value)
  }
}

/** 描述符的数据行（字段名 → 值）。 */
export type MbpRow = Record<string, unknown>

/**
 * 整行驱动记录 → 记录侧数据字段对象（不含 id/audit/tenant——那些由
 * BaseMapper 单独处理）。
 * @param descriptor - 表描述符。
 * @param row - 驱动行（物理列名键）。
 * @returns 字段名键的记录对象。
 */
export function decodeDataRow(descriptor: MbpTableDescriptor, row: Record<string, unknown>): MbpRow {
  const out: MbpRow = {}
  for (const field of descriptor.fields) {
    const spec = descriptor.columns[field]!
    out[field] = decodeValue(spec, row[spec.column])
  }
  return out
}

/**
 * 整行驱动记录 → **完整记录**（元字段惯例命名 + 类型驱动数据字段）——
 * {@link BaseMapper.decode} 的公共纯函数形态，供 Kysely 等非 mbp 路线读出的
 * 原始行复用同一套行映射（域 repository 不再各写一份 decodeXxxRow）。
 * @typeParam T - 消费者声明的记录类型。
 * @param descriptor - 表描述符。
 * @param row - 驱动行（物理列名键）。
 * @returns 完整记录（id/tenantId/审计四元/逻辑删位 + 数据字段）。
 */
export function decodeRowWith<T extends object>(descriptor: MbpTableDescriptor, row: Record<string, unknown>): T {
  const record: Record<string, unknown> = {}
  if (descriptor.id !== null) record.id = String(row[descriptor.id])
  for (const field of descriptor.fields) {
    const spec = descriptor.columns[field]!
    record[field] = decodeValue(spec, row[spec.column])
  }
  if (descriptor.audit) {
    record.creatorTime = toIsoDateTime(row.f_creator_time)
    record.creatorUserId = row.f_creator_user_id ?? null
    record.lastModifyTime = toIsoDateTime(row.f_last_modify_time)
    record.lastModifyUserId = row.f_last_modify_user_id ?? null
  }
  if (descriptor.deleteMark !== null) record.deleteMark = row[descriptor.deleteMark] ?? null
  if (descriptor.tenant !== null) record.tenantId = row[descriptor.tenant] ?? null
  return record as T
}

/**
 * 创建/更新载荷 → 描述符字段白名单内的 patch（datetime 输入归一 ISO、
 * undefined 跳过、skip 字段排除——identity/credentials/审计等由调用方
 * 另行处理的字段）。{@link BaseMapper.insert} 前的输入过滤公共形态。
 * @typeParam T - 消费者声明的记录类型。
 * @param descriptor - 表描述符。
 * @param input - 调用方载荷（字段名键）。
 * @param skip - 排除字段名清单（不进 patch）。
 * @returns 白名单内的 patch 对象。
 */
export function patchFromInput<T extends object>(
  descriptor: MbpTableDescriptor,
  input: Record<string, unknown>,
  skip: readonly string[] = [],
): Partial<T> {
  const patch: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(input)) {
    const spec = descriptor.columns[field]
    if (spec === undefined || value === undefined || skip.includes(field)) continue
    patch[field] = spec.type === 'datetime' ? toIsoDateTime(value) : value
  }
  return patch as Partial<T>
}
