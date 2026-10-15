/**
 * PostgreSQL 传输层翻译：`?` 位置占位符 → `$1,$2…` 编号占位符（复用
 * dsh-rdb/src/placeholders）。PG 原生 wire 协议，连接串 `postgres://`
 * 形态 pg 驱动原生可读，无需归一。
 * @module dsh-rdb-postgres/src/translate
 */
import { numberedPlaceholders } from '../placeholders.ts'
import { sanitizeStorableText } from '../json-text.ts'

/**
 * 翻译语句占位符为 PG 编号形态。
 * @param sql - 带 `?` 占位符的语句。
 * @returns `$1,$2…` 形态语句。
 */
export function toPostgresSql(sql: string): string {
  return numberedPlaceholders(sql, 'postgres')
}

/**
 * 绑参净化兜底：字符串参数过 {@link sanitizeStorableText}（NUL/孤立代理项
 * → U+FFFD）。PG text 列拒收 NUL 裸字符；jsonb 的违禁转义在序列化点
 * （json-text 的 stringifyJsonColumn）解决，本层只管纯文本参数可存储性。
 * @param params - 绑定参数（undefined 原样透传）。
 * @returns 净化后的参数数组。
 */
export function toPostgresParams(params?: readonly unknown[]): unknown[] | undefined {
  if (params === undefined) return undefined
  return params.map(param => (typeof param === 'string' ? sanitizeStorableText(param) : param))
}
