/**
 * 金仓传输层翻译：`?` 位置占位符 → `$1,$2…` 编号占位符（复用
 * dsh-rdb/src/placeholders）。金仓说 PG wire 协议，连接串 `postgres://`
 * 形态 pg 驱动原生可读，无需归一。
 * @module dsh-rdb-kingbase/src/translate
 */
import { numberedPlaceholders } from '../placeholders.ts'

/**
 * 翻译语句占位符为金仓/PG 编号形态。
 * @param sql - 带 `?` 占位符的语句。
 * @returns `$1,$2…` 形态语句。
 */
export function toKingbaseSql(sql: string): string {
  return numberedPlaceholders(sql, 'postgres')
}
