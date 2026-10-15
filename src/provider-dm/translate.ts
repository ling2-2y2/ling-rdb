/**
 * 达梦传输层翻译：`?` 位置占位符 → `:1,:2…` 编号占位符（复用
 * kit/placeholders）、连接 URL 归一为 `dm://` connectString（强制
 * `autoCommit=false`——事务由门面收口）、参数数组塑形为官方文档的
 * `[{val: x}, …]` 绑定形态。
 * @module @ling2/ling-rdb-dm/src/translate
 */
import { numberedPlaceholders } from '../kit/placeholders.ts'

/**
 * `dm://user:password@host:port`（可带 query 参数）→ 达梦 connectString。
 * 无论入参是否带 `autoCommit`，强制置 `false`（隐式事务模型的前提）。
 * 非 `dm://` 前缀的原生 connectString 原样透传并补 `autoCommit=false`。
 * @param url - 连接 URL 或原生 connectString。
 * @returns 达梦 connectString。
 */
export function toDmConnectString(url: string): string {
  let connectString = url
  if (url.startsWith('dm://')) {
    const parsed = new URL(url)
    const auth = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
    const host = `${parsed.hostname}${parsed.port === '' ? '' : `:${parsed.port}`}`
    connectString = `dm://${auth}@${host}${parsed.search}`
  }
  const separator = connectString.includes('?') ? '&' : '?'
  return connectString.includes('autoCommit=')
    ? connectString.replace(/autoCommit=[^&]*/u, 'autoCommit=false')
    : `${connectString}${separator}autoCommit=false`
}

/**
 * 翻译语句占位符为达梦编号形态（与 Oracle 同族）。
 * @param sql - 带 `?` 占位符的语句。
 * @returns `:1,:2…` 形态语句。
 */
export function toDmSql(sql: string): string {
  return numberedPlaceholders(sql, 'oracle')
}

/**
 * 参数数组塑形为达梦官方文档的位置绑定形态 `[{val: x}, …]`；空参数返回
 * 空数组（execute 的 binds 可省）。
 * @param params - 位置参数。
 * @returns 达梦绑定数组。
 */
export function toDmBinds(params: readonly unknown[] | undefined): Array<{ val: unknown }> {
  return (params ?? []).map(value => ({ val: value }))
}
