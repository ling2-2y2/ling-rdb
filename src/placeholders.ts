/**
 * 占位符序号化——`?` 位置占位符到编号占位符的方言翻译（纯函数，无 IO）。
 *
 * hub 的传输契约是 mysql 风格的 `?` 位置占位符（{@link RdbConnection}）；
 * 部分 SQL 方言的驱动只认编号占位符（Oracle/达梦 `:1`、PostgreSQL/金仓
 * `$1`）。provider 在把语句递给原生驱动前用本模块翻译——翻译属于传输
 * 层职责，语句层（含 dsh-orm 的方言编译器）统一出口 `?`。
 *
 * 引号感知：单引号字符串字面量（含 `''` 转义）与双引号标识符（含 `""`
 * 转义）内的 `?` 是字面字符，不翻译。**码元迭代**——与 tenant-line 的
 * maskQuoted 同一纪律，避免代理对错位。
 * 注释感知（2026-09-17，WeKnora 基线批）：行注释（双减号）与块注释
 * （斜杠星号对）整段透传——迁移 SQL 的文档注释常含 `?` 示例占位符，
 * 误翻会破坏逐字照抄纪律（执行语义无损，文本保真有损）。
 * @module dsh-rdb/src/placeholders
 */

/** 编号占位符方言族：`oracle` = `:1,:2…`（Oracle/达梦），`postgres` = `$1,$2…`（PostgreSQL/金仓）。 */
export type PlaceholderStyle = 'oracle' | 'postgres'

/**
 * 把语句中引号外的 `?` 逐个替换为编号占位符（从 1 起）。
 * @param sql - 带 `?` 位置占位符的语句文本。
 * @param style - 目标方言族。
 * @returns 翻译后的语句文本；没有可翻译占位符时原引用返回。
 */
export function numberedPlaceholders(sql: string, style: PlaceholderStyle): string {
  const sigil = style === 'oracle' ? ':' : '$'
  let out = ''
  let index = 0
  let modified = false
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    // 单引号字符串字面量 / 双引号标识符：整段透传（含成对转义）
    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue }
          break
        }
        j++
      }
      out += sql.slice(i, Math.min(j + 1, sql.length))
      i = j + 1
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      // 行注释：透传到行尾（换行符本身留给下轮）
      let j = i
      while (j < sql.length && sql[j] !== '\n') j++
      out += sql.slice(i, j)
      i = j
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      // 块注释：透传到 `*/`（未闭合则保守透传到串尾）
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      out += sql.slice(i, stop)
      i = stop
      continue
    }
    if (ch === '?') {
      index += 1
      out += `${sigil}${index}`
      modified = true
      i++
      continue
    }
    out += ch
    i++
  }
  return modified ? out : sql
}
