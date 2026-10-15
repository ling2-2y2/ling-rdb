/**
 * Oracle 传输层翻译：`?` 位置占位符 → `:1,:2…` 编号占位符（复用
 * dsh-rdb/src/placeholders），并把连接 URL 归一为 oracledb 的
 * connectString 形态。语句层（含 dsh-orm）统一出口 `?`。
 * @module dsh-rdb-oracle/src/translate
 */
import { numberedPlaceholders } from '../placeholders.ts'

/**
 * `oracle://user:password@host:port/service` → oracledb connectString
 * `host:port/service` 与独立凭据。已带 `oracle://` 前缀外的原样 connectString
 * （如 EZConnect 串）直接透传（凭据位为空）。
 * @param url - 连接 URL 或原生 connectString。
 * @returns 凭据与 connectString。
 */
export function parseOracleUrl(url: string): { user: string; password: string; connectString: string } {
  if (!url.startsWith('oracle://')) {
    return { user: '', password: '', connectString: url }
  }
  const parsed = new URL(url)
  const connectString = `${parsed.hostname}${parsed.port === '' ? '' : `:${parsed.port}`}${parsed.pathname}`
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    connectString,
  }
}

/**
 * 翻译语句占位符为 Oracle 编号形态。
 * @param sql - 带 `?` 占位符的语句。
 * @returns `:1,:2…` 形态语句。
 */
export function toOracleSql(sql: string): string {
  return numberedPlaceholders(sql, 'oracle')
}
