/**
 * mbp 语义层的 datetime 双向转换（CLAUDE.md 硬规则 8 的 kit 化）：
 * 记录对象上存 ISO 串，进 SQL 参数前转本地时区 `YYYY-MM-DD HH:MM:SS`
 * （MySQL DATETIME 拒绝带 `T`/`Z` 的 ISO 串）；驱动返回的 Date/串归一为
 * ISO 串。与各消费者私有 toSqlDateTime 同语义，收敛为单源。
 * @module dsh-rdb/src/mbp/datetime
 */

/** 两位补零。 */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 记录侧时间值 → SQL DATETIME 参数（本地时区文本）。
 * @param value - Date 对象、ISO 串或毫秒时间戳（旧域 codec 的 number 契约
 *   兼容——部分域的 `now()` seam 直接回毫秒数，2026-09-05 批E oauth 域
 *   实证）；`null`/`undefined`/空串归 `NULL`。
 * @returns `YYYY-MM-DD HH:MM:SS` 文本，空值返回 null。
 * @throws 非法时间串 fail loud（静默落 NULL 会掩盖调用方 bug）。
 */
export function toSqlDateTime(value: Date | string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`mbp: 非法时间值 ${JSON.stringify(value)}`)
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/**
 * 驱动行时间值 → 记录侧 ISO 串。
 * @param value - 驱动返回值（mysql2 的 Date 对象 / 其他驱动的文本 / null）。
 * @returns ISO 串；null/undefined 归 null；无法解析的串原样透传（容忍
 *   驱动方言形态，不猜）。
 */
export function toIsoDateTime(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') {
    if (value === '') return null
    // 已是 ISO 形态直接透传；其他形态（如 'YYYY-MM-DD HH:MM:SS'）按本地时区解析
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value
    const parsed = new Date(value.replace(' ', 'T'))
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
  }
  return String(value)
}
