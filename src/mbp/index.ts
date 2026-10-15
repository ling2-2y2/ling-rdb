/**
 * mbp——dsh-rdb 内建的 MyBatis-Plus 语义层（方案 C，`src/query.ts` 语句
 * kit 路线的延长）：表描述符 → BaseMapper 派生 CRUD → 强制自动填充 →
 * 行映射自动化 → Wrapper 类型化条件。全部纯函数/纯派生，零 IO、零新依赖，
 * SQL 仍是内联可审计的 `?` 占位符文本，流量全经 RdbDatabase 门面。
 * @module dsh-rdb/src/mbp
 */
export { defineTable, columnOf } from './descriptor.ts'
export type { MbpColumnType, MbpColumnSpec, MbpTableSpec, MbpTableDescriptor } from './descriptor.ts'
export { runWithMbpFill, currentMbpFill, alsFillSource, NULL_FILL, MbpFillHolder } from './fill.ts'
export type { MbpFillValues, MbpFillSource } from './fill.ts'
export { BaseMapper, randomUuidGenerator } from './mapper.ts'
export type { IdentifierGenerator, MbpExecutor, MbpMapperOptions, MbpPageQuery, MbpPage } from './mapper.ts'
export { encodeValue, decodeValue, decodeDataRow, decodeRowWith, patchFromInput } from './rowmap.ts'
export type { MbpRow } from './rowmap.ts'
export { mbpWrapper, MbpWrapper } from './wrapper.ts'
export { toSqlDateTime, toIsoDateTime } from './datetime.ts'
