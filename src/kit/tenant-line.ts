/**
 * 租户行拦截——Ling `BasicTenantInnerInterceptor`/`BasicTenantHandler`
 * 在 Service-Definition 层的对应物。请求作用域（AsyncLocalStorage，
 * `BasicTenantHolder` 线程槽语义）承载业务注入的会话租户。**注入式为
 * 设计基线**：业务 SQL 零租户谓词，受控表（`TenantLineRule.tables` 受控
 * 清单）在深度 0 顶层出现而语句未写该表租户谓词时，执行期自动在 WHERE
 * 追加 `<前缀.>列 = ?` 并绑会话租户（括号深度感知——子查询/窗口/CTE 区
 * 域不误伤）；INSERT 自动补租户列（Ling processInsert 对应物）；存量
 * 手写谓词的语句只换值不重复注入（向后兼容）。超管旁路
 * （{@link TenantLineContext.adminBypass}，`BasicTenantInterceptor.doTenantFilter`
 * 对应物）天然不注入=跨分区读写；对存量手写谓词做中和（`列 = ?` →
 * `1 = 1`）。**fail loud 防线**：受控表出现在子查询/CTE 等无法保证过滤
 * 的区域时直接抛错，绝不静默跳过。方言无关：任何 `RdbDatabase` 形状
 * （含测试假外观）都能包；provider 无需参与。
 * @module @ling2/ling-rdb/hub/tenant-line
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { RdbConnection, RdbDatabase } from '../hub/types.ts'

/** 一条租户行规则（业务侧知识：列名 + 受控表清单）。 */
export interface TenantLineRule {
  /** 租户列名（如 `f_tenant_id`）。 */
  readonly column: string
  /** 受控表名集合——Ling `tenantTableList`/`EXCLUDE_TABLES` 对应物；
   * 清单外表上的谓词不改写（如无分区注册表）。 */
  readonly tables: ReadonlySet<string> | readonly string[]
}

/**
 * 超管旁路参数（`BasicTenantInterceptor.doTenantFilter` 对应物）：
 * `AuthUtil.isAdministrator() && enhance && ∉ adminTenantTables` 时，
 * SELECT/UPDATE/DELETE 的租户谓词被中和（跨分区读写）；`adminTables`
 * 成员表仍按普通改写（绑定值换超管会话租户）。
 */
export interface TenantLineAdminBypass {
  /** 超管仍需过滤的表（Ling `adminTenantTables`；dsh 默认空表）。 */
  readonly adminTables: ReadonlySet<string>
}

/** 一次调用注入的会话租户上下文。 */
export interface TenantLineContext {
  /** 会话租户（业务侧解析，如 enCode）。 */
  readonly tenantId: string
  /** 是否改写（业务侧门控，Ling `isColumnMode` 对应位）。 */
  readonly filter: boolean
  /** `@TenantIgnore` 对应物：嵌套豁免，外层自动恢复。 */
  readonly ignored?: boolean
  /**
   * 超管旁路（Ling `enhance` + `adminTenantTables`）；在场时优先于
   * {@link filter} 的普通改写。INSERT 永不中和（Ling `processInsert`
   * 纯透传：列位绑定照常换值——tenant_id 的写入也在本拦截层）。
   */
  readonly adminBypass?: TenantLineAdminBypass
  /**
   * 会话路由的目标数据库行（type-0 库隔离 / type-2 外链的从库行）；
   * undefined = 管理库（主库）。从库行由业务侧**裸返回**——Ling
   * `BasicTenantHandler.ignoreTable`：非主库数据源一律不过滤。
   */
  readonly database?: RdbDatabase
}

const storage = new AsyncLocalStorage<TenantLineContext>()

/**
 * 在租户行上下文内执行一段异步体（Ling 认证过滤器填线程槽的对应
 * 物）；上下文沿 await 链传播，结束后自动退场。
 * @param context - 业务注入的会话租户上下文。
 * @param fn - 执行体。
 * @returns fn 的结果。
 */
export function runWithTenantLine<T>(context: TenantLineContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn)
}

/**
 * 读当前租户行上下文；无作用域时为 undefined（不改写，语句自带绑定值）。
 * @returns 当前上下文，或 undefined。
 */
export function currentTenantLine(): TenantLineContext | undefined {
  return storage.getStore()
}

/**
 * `@TenantIgnore` 对应物：嵌套豁免租户行改写，外层上下文在体结束后
 * 自动恢复。作用域外调用等价于一个空上下文＋豁免位。
 * @param fn - 豁免执行的异步体。
 * @returns fn 的结果。
 */
export function ignoreTenantLine<T>(fn: () => Promise<T>): Promise<T> {
  const outer = currentTenantLine()
  const context: TenantLineContext = outer === undefined
    ? { tenantId: '', filter: false, ignored: true }
    : { ...outer, ignored: true }
  return storage.run(context, fn)
}

/** FROM/JOIN 之后不可能是表别名的保留字。 */
const CLAUSE_KEYWORDS = new Set([
  'ON', 'WHERE', 'LEFT', 'RIGHT', 'INNER', 'CROSS', 'JOIN', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'SET', 'VALUES', 'SELECT',
])

/**
 * 把单引号字面量抹为同长的占位字符（保字符位置不变），使后续正则
 * 不会命中引号内文本；`''` 转义按 MySQL 语义跳过。**码元迭代**：
 * 掩码索引必须与原串 UTF-16 索引一一对应（中和改写按原串索引切片，
 * 码点迭代会让代理对错位）。
 */
function maskQuoted(sql: string): string {
  const chars = new Array<string>(sql.length)
  let inQuote = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    if (!inQuote) {
      chars[i] = ch
      if (ch === "'") inQuote = true
      continue
    }
    if (ch === "'") {
      if (sql[i + 1] === "'") { chars[i] = '\x01'; chars[i + 1] = '\x01'; i++ } else { chars[i] = ch; inQuote = false }
      continue
    }
    chars[i] = '\x01'
  }
  return chars.join('')
}

/** 收集引号外全部 `?` 的字符位置（升序）。 */
function questionPositions(masked: string): number[] {
  const positions: number[] = []
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '?') positions.push(i)
  }
  return positions
}

/** ordinal = 位于某字符位置之前（不含）的 `?` 个数。 */
function ordinalBefore(positions: readonly number[], at: number): number {
  let count = 0
  for (const p of positions) {
    if (p >= at) break
    count++
  }
  return count
}

/** 解析 SELECT 的 FROM/JOIN 表与别名（外层第一个 FROM；本语句家族无子查询谓词形态）。 */
function parseSelectSources(masked: string): { primary: string; aliases: Map<string, string> } {
  const aliases = new Map<string, string>()
  const from = /\bFROM\s+(\w+)(?:\s+([\w]+))?/.exec(masked)
  let primary = ''
  if (from !== null) {
    primary = from[1]!
    const maybeAlias = from[2]
    if (maybeAlias !== undefined && !CLAUSE_KEYWORDS.has(maybeAlias.toUpperCase())) {
      aliases.set(maybeAlias, primary)
    }
  }
  for (const join of masked.matchAll(/\bJOIN\s+(\w+)(?:\s+(?!ON\b)(\w+))?\s+ON\b/g)) {
    const table = join[1]!
    const alias = join[2]
    if (alias !== undefined) aliases.set(alias, table)
  }
  return { primary, aliases }
}

/** 一条语句的目标解析（改写与中和两路共用）。 */
interface StatementTarget {
  /** INSERT … VALUES 的列清单（表外语句为 undefined）。 */
  readonly insertColumns?: readonly string[]
  /** 主表（UPDATE/DELETE 目标或 SELECT 首 FROM 表）。 */
  readonly primary: string
  /** 别名 → 表（SELECT JOIN 形态；其余语句 undefined）。 */
  readonly aliases: Map<string, string> | undefined
}

/**
 * 解析语句形态与目标表：INSERT…VALUES 列清单 / UPDATE·DELETE 主表 /
 * SELECT 首 FROM + JOIN 别名。只覆盖本仓库语句家族的形态。
 */
function statementTarget(masked: string): StatementTarget {
  const dbgInsert = /^INSERT INTO (\w+) \(([^)]*)\)( VALUES| SELECT)?/.exec(masked)
  const insert = /^INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)\s*(VALUES|SELECT)\b/i.exec(masked)
  if (insert !== null && insert[3] !== undefined && insert[3].toUpperCase() === 'VALUES') {
    return { insertColumns: insert[2]!.split(',').map(name => name.trim()), primary: insert[1]!, aliases: undefined }
  }
  // INSERT…SELECT falls through to the predicate scan: placeholder order
  // follows the SELECT text, not the column list, so column-slot mapping
  // does not apply (the family's copy statements run under ignoreTenantLine).
  const update = /\bUPDATE\s+(\w+)\s+SET\b/.exec(masked)
  if (update !== null) return { primary: update[1]!, aliases: undefined }
  const del = /\bDELETE\s+FROM\s+(\w+)\b/.exec(masked)
  if (del !== null) return { primary: del[1]!, aliases: undefined }
  const sources = parseSelectSources(masked)
  return { primary: sources.primary, aliases: sources.aliases }
}

/**
 * 计算一条语句应改写的参数序号集合（含每个序号的目标验证）。
 * 只覆盖本仓库语句家族的形态：`<别名.>列 = ?` 谓词（WHERE/ON）与
 * INSERT 列清单中的列位；`列 = 列` 比较（无占位符）天然不动。
 */
function tenantLineOrdinals(sql: string, column: string, tables: Set<string>): number[] {
  const masked = maskQuoted(sql)
  const positions = questionPositions(masked)
  if (positions.length === 0) return []
  const target = statementTarget(masked)
  const ordinals: number[] = []

  if (target.insertColumns !== undefined) {
      if (!tables.has(target.primary)) return []
    const slot = target.insertColumns.indexOf(column)
    if (slot >= 0 && slot < positions.length) ordinals.push(slot)
    return ordinals
  }

  const predicate = new RegExp(`(?:\\w+\\.)?${column}\\s*=\\s*\\?`, 'g')
  for (const match of masked.matchAll(predicate)) {
    const at = match.index + match[0].length - 1
    const ref = /^(\w+)\./.exec(match[0])
    let table: string | undefined
    if (ref !== null) {
      table = target.aliases?.get(ref[1]!)
    } else {
      table = target.primary === '' ? undefined : target.primary
    }
    if (table === undefined || !tables.has(table)) continue
    const ordinal = ordinalBefore(positions, at)
    if (ordinal < positions.length) ordinals.push(ordinal)
  }
  return ordinals
}

/**
 * 一条语句的主目标表名（INSERT/UPDATE/DELETE 目标或 SELECT 首 FROM 表）；
 * 解析不出时 undefined。业务侧做**按表选库**（master-only 白名单派发）
 * 时的判定源——与改写/中和共用同一解析器，判定口径一致。
 * @param sql - 语句文本。
 * @returns the primary table name, or undefined.
 */
export function primaryStatementTable(sql: string): string | undefined {
  const target = statementTarget(maskQuoted(sql))
  return target.primary === '' ? undefined : target.primary
}

/**
 * 改写一条语句的租户绑定值：受控表上的租户谓词/列位替换为会话租户，
 * 其余参数原样。无命中时原引用返回（调用方可复用 params 数组）。
 * @param sql - 语句文本（`?` 占位符）。
 * @param params - 位置参数；undefined 时原样返回。
 * @param rule - 列名与受控表清单。
 * @param tenantId - 会话租户。
 * @returns 改写后的参数组（新数组）或原引用。
 */
export function rewriteTenantLineParams(
  sql: string,
  params: readonly unknown[] | undefined,
  rule: TenantLineRule,
  tenantId: string,
): readonly unknown[] | undefined {
  if (params === undefined || params.length === 0) return params
  const tables = rule.tables instanceof Set ? rule.tables : new Set(rule.tables)
  const ordinals = tenantLineOrdinals(sql, rule.column, tables)
  if (ordinals.length === 0) return params
  const next = [...params]
  for (const ordinal of ordinals) next[ordinal] = tenantId
  return next
}

/** 执行期拦截结果：文本与参数组同改（未命中时均为原引用）。 */
export interface TenantLineRewrite {
  /** 语句文本（未改写时为原引用）。 */
  readonly sql: string
  /** 参数组（未改写时为原引用）。 */
  readonly params: readonly unknown[] | undefined
}

const VERB_RE = /^\s*(SELECT|UPDATE|DELETE|INSERT|WITH|EXPLAIN|CREATE|SHOW|SET|BEGIN|COMMIT|ROLLBACK|USE|TRUNCATE|DESC|DESCRIBE|REPLACE|ALTER|DROP)\b/i

/** 括号深度感知：返回每字符所处深度（0=顶层；引号内容已被掩码抹平）。 */
function depthScan(masked: string): number[] {
  const depth = new Array<number>(masked.length).fill(0)
  let d = 0
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]!
    depth[i] = d
    if (ch === '(') d++
    else if (ch === ')') d--
  }
  return depth
}

/** 深度 0 的整词匹配位置（自 from 起）；无则 -1。 */
function topWord(masked: string, depth: readonly number[], word: string, from = 0): number {
  const re = new RegExp(`\\b${word}\\b`, 'gi')
  for (const m of masked.substring(from).matchAll(re)) {
    const at = from + (m.index ?? 0)
    if (depth[at] === 0) return at
  }
  return -1
}

/** 顶层子句边界关键词（深度 0 判定用）。 */
const TOP_STOP = /\b(ORDER|GROUP|HAVING|LIMIT|FETCH|OFFSET|UNION|EXCEPT|INTERSECT|WINDOW)\b/gi

/** 深度 0 子句边界（ORDER/GROUP/HAVING/LIMIT 等）中第一个 ≥ from 的位置。 */
function topClauseEnd(masked: string, depth: readonly number[], from: number): number {
  for (const stop of masked.matchAll(TOP_STOP)) {
    if ((stop.index ?? 0) < from) continue
    if (depth[stop.index ?? 0] !== 0) continue
    return stop.index ?? masked.length
  }
  return masked.length
}

function tablesOf(rule: TenantLineRule): Set<string> {
  return rule.tables instanceof Set ? rule.tables : new Set<string>(rule.tables)
}

/**
 * 注入式租户过滤（设计基线：业务 SQL 零租户谓词）。深度 0 顶层出现的受控
 * 表（主表与 JOIN 别名）若无已手写租户谓词，则在 WHERE 尾（无 WHERE 则
 * 构造 WHERE，插在顶层 GROUP/ORDER/LIMIT 等之前）自动追加
 * `<前缀.>列 = ?` 并把会话租户追加到参数组尾部。已手写谓词的表不重复
 * 注入（换值路径负责）；非受控表永不注入。多表 JOIN 时主表无别名也用
 * 表名限定（避免与 JOIN 表同名列歧义）。**fail loud 防线**：受控表出现在
 * 本注入器无法保证过滤的位置（子查询/CTE/派生表等深度 >0 区域）时直接
 * 抛错——绝不静默跳过造成租户泄漏；业务出口=改写为顶层 JOIN/WHERE 形态，
 * 或在 `ignoreTenantLine` 内显式携带租户值。非行访问语句（EXPLAIN/CREATE
 * 等）不经本函数原样透传；INSERT 走 `injectInsertTenantColumn`。
 * @param sql - 语句文本（`?` 占位符）。
 * @param params - 位置参数。
 * @param rule - 列名与受控表清单。
 * @param tenantId - 会话租户。
 * @returns 注入后的文本与参数组（无缺失谓词时均为原引用）。
 */
export function injectTenantLinePredicates(
  sql: string,
  params: readonly unknown[] | undefined,
  rule: TenantLineRule,
  tenantId: string,
): TenantLineRewrite {
  const masked = maskQuoted(sql)
  const verb = VERB_RE.exec(masked)?.[1]?.toUpperCase()
  if (verb === 'INSERT') return { sql, params }
  const scanVerbs = verb === 'SELECT' || verb === 'UPDATE' || verb === 'DELETE' || verb === 'WITH'
  if (!scanVerbs) return { sql, params }
  const depth = depthScan(masked)
  const tables = tablesOf(rule)
  // fail loud 防线（先于形态解析）：WITH/EXPLAIN 等语句涉受控表于深度>0 → 抛错
  if (verb === 'WITH') {
    for (const table of tables) {
      const re = new RegExp(`\\b${table}\\b`, 'i')
      if (re.test(masked)) {
        throw new Error(
          `tenant-line: CTE 语句涉及受控表 '${table}'，无法保证内层 SELECT 的租户过滤`
          + '——请改写为顶层 JOIN/WHERE 形态，或在 ignoreTenantLine 内显式携带租户值',
        )
      }
    }
  }

  // 顶层 FROM 主表（含别名）与 JOIN 别名表
  const fromAt = topWord(masked, depth, verb === 'UPDATE' ? 'UPDATE' : 'FROM')
  const aliases = new Map<string, string>()
  let primary = ''
  let primaryAlias: string | undefined
  if (verb === 'UPDATE') {
    const m = /\bUPDATE\s+(\w+)\s+SET\b/i.exec(masked)
    if (m !== null) primary = m[1]!
  } else {
    const fromRe = /\bFROM\s+(\w+)(?:\s+(?!ON\b|WHERE\b|GROUP\b|ORDER\b|LIMIT\b|HAVING\b|LEFT\b|RIGHT\b|INNER\b|JOIN\b)(\w+))?/gi
    for (const m of masked.matchAll(fromRe)) {
      if (depth[m.index ?? 0] !== 0) continue
      primary = m[1]!
      if (m[2] !== undefined) primaryAlias = m[2]!
      break
    }
    const joinRe = /\bJOIN\s+(\w+)(?:\s+(?!ON\b)(\w+))?\s+ON\b/gi
    for (const j of masked.matchAll(joinRe)) {
      if (depth[j.index ?? 0] !== 0) continue
      if (j[2] !== undefined) aliases.set(j[2]!.toLowerCase(), j[1]!)
    }
  }
  const lowerPrimary = primary.toLowerCase()
  const lowerPrimaryAlias = primaryAlias?.toLowerCase()

  // 已手写谓词的受控表（仅深度 0 谓词参与判定；表级命中=整表不注入）
  const writtenTables = new Set<string>()
  const predRe = new RegExp(`(?:\\w+\\.)?${rule.column}\\s*=\\s*\\?`, 'gi')
  for (const m of masked.matchAll(predRe)) {
    if (depth[m.index ?? 0] !== 0) continue
    const ref = /^(\w+)\./i.exec(m[0])
    const table = ref !== null
      ? lowerPrimaryAlias !== undefined && ref[1]!.toLowerCase() === lowerPrimaryAlias
        ? lowerPrimary
        : aliases.get(ref[1]!.toLowerCase())
      : lowerPrimary
    if (table !== undefined && tables.has(table)) writtenTables.add(table)
  }

  // 注入对（前缀, 表）：主表 + 各受控 JOIN 别名；已写表跳过
  const pairs: Array<{ prefix: string; table: string }> = []
  if (lowerPrimary !== '' && tables.has(lowerPrimary) && !writtenTables.has(lowerPrimary)) {
    const prefix = primaryAlias !== undefined ? `${primaryAlias}.` : aliases.size > 0 ? `${primary}.` : ''
    pairs.push({ prefix, table: lowerPrimary })
  }
  for (const [alias, table] of aliases) {
    if (!tables.has(table) || writtenTables.has(table) || alias === lowerPrimaryAlias) continue
    pairs.push({ prefix: `${alias}.`, table })
  }

  // fail loud 防线一：受控表在深度 >0 区域（子查询/CTE/派生表）被提及
  for (const table of tables) {
    const re = new RegExp(`\\b${table}\\b`, 'gi')
    for (const m of masked.matchAll(re)) {
      if (depth[m.index ?? 0] > 0) {
        throw new Error(
          `tenant-line: 语句在子查询/CTE/派生表区域涉及受控表 '${table}'，无法保证租户过滤`
          + '——请改写为顶层 JOIN/WHERE 形态，或在 ignoreTenantLine 内显式携带租户值',
        )
      }
    }
  }
  // fail loud 防线二：受控表被顶层提及却未获注入（不可解析位置）
  const covered = new Set<string>([...writtenTables, ...pairs.map(p => p.table)])
  for (const table of tables) {
    if (!covered.has(table) && new RegExp(`\\b${table}\\b`, 'i').test(masked)) {
      throw new Error(
        `tenant-line: 语句顶层涉及受控表 '${table}' 但解析失败，无法注入租户谓词`
        + '——请在 ignoreTenantLine 内显式携带租户值',
      )
    }
  }
  if (pairs.length === 0) return { sql, params }

  // 插入点：有顶层 WHERE → 其子句尾；无 → 顶层子句边界（FROM/SET 之后）
  const topWhere = topWord(masked, depth, 'WHERE', Math.max(fromAt, 0))
  const insertAt = topWhere >= 0 ? topClauseEnd(masked, depth, topWhere) : topClauseEnd(masked, depth, Math.max(fromAt, 0))
  const left = sql.slice(0, insertAt)
  const right = sql.slice(insertAt)
  const sepL = left.endsWith(' ') || left.endsWith('(') ? '' : ' '
  const sepR = right === '' || /^[ )]/.test(right) ? '' : ' '
  const body = (topWhere >= 0 ? 'AND ' : 'WHERE ') + pairs.map(p => `${p.prefix}${rule.column} = ?`).join(' AND ')
  return {
    sql: left + sepL + body + sepR + right,
    params: [...(params ?? []), ...pairs.map(() => tenantId)],
  }
}

/**
 * INSERT 的租户写入（Ling processInsert 对应物）：列清单含租户列 → 列位
 * 换值（既有路径）；不含 → 自动追加租户列、每个 VALUES 组尾追加占位符并
 * 按组绑定会话租户。INSERT…SELECT / 不可解析形态涉及受控表 → fail loud；
 * 非受控表原样透传。
 * @param sql - 语句文本。
 * @param params - 位置参数。
 * @param rule - 列名与受控表清单。
 * @param tenantId - 会话租户。
 * @returns 改写后的文本与参数组（无需动作时均为原引用）。
 */
export function injectInsertTenantColumn(
  sql: string,
  params: readonly unknown[] | undefined,
  rule: TenantLineRule,
  tenantId: string,
): TenantLineRewrite {
  const masked = maskQuoted(sql)
  const head = /^\s*INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)\s*(VALUES|SELECT)\b/i.exec(masked)
  const table = head?.[1]?.toLowerCase() ?? ''
  if (table === '' || !tablesOf(rule).has(table)) return { sql, params }
  if (head![3]!.toUpperCase() !== 'VALUES') {
    throw new Error(
      `tenant-line: INSERT…SELECT 涉及受控表 '${table}' 无法安全注入租户`
      + '——请拆分为显式语句或在 ignoreTenantLine 内携带租户值',
    )
  }
  const lowerColumn = rule.column.toLowerCase()
  const columns = head![2]!.split(',').map(name => name.trim().replace(/^`|`$/g, '').toLowerCase())
  if (columns.includes(lowerColumn)) {
    return { sql, params: rewriteTenantLineParams(sql, params, rule, tenantId) }
  }

  // 自动补列：列清单闭合处追加列名；每个顶层 VALUES 组闭合处追加 `, ?`；
  // 参数按组重建（组内既有 ? 依序 + 组尾追绑会话租户）。
  const depth = depthScan(masked)
  const valuesAt = /VALUES/i.exec(masked)!.index
  const columnsClose = masked.indexOf(')', head!.index ?? 0)
  const groups: Array<{ end: number; questions: number }> = []
  // 组序列：VALUES 后连续的 `(..),(..)..`（组间只允许逗号与空白）；遇其它
  // 词（如 ON DUPLICATE KEY 的 VALUES(stock)）即停，避免误补。
  let scanFrom = valuesAt + 6 // 跳过 VALUES 关键词自身
  for (;;) {
    let start = -1
    for (let i = scanFrom; i < masked.length; i++) {
      if (masked[i] === '(' && depth[i] === 0) { start = i; break }
      if (/[A-Za-z_]/i.test(masked[i]!)) { start = -2; break }
    }
    if (start < 0) break
    let questions = 0
    let j = start + 1
    while (j < masked.length && !(masked[j] === ')' && depth[j] === 1)) {
      if (masked[j] === '?') questions++
      j++
    }
    groups.push({ end: j, questions })
    let k = j + 1
    while (k < masked.length && /\s/.test(masked[k]!)) k++
    if (masked[k] !== ',') break
    k++
    while (k < masked.length && /\s/.test(masked[k]!)) k++
    scanFrom = k
  }
  const splices: Array<{ at: number; text: string }> = [{ at: columnsClose, text: `, ${rule.column}` }]
  for (const group of groups) splices.push({ at: group.end, text: ', ?' })
  splices.sort((a, b) => a.at - b.at)
  let out = ''
  let cursor = 0
  for (const splice of splices) {
    out += sql.slice(cursor, splice.at) + splice.text
    cursor = splice.at
  }
  out += sql.slice(cursor)

  const next: unknown[] = []
  let offset = 0
  for (const group of groups) {
    for (let k = 0; k < group.questions; k++) next.push(params?.[offset + k])
    next.push(tenantId)
    offset += group.questions
  }
  return { sql: out, params: next }
}

/**
 * 超管旁路中和（`BasicTenantInterceptor.doTenantFilter` 对应物）：把
 * 受控表上、∉ adminTables 的租户谓词文本替换为 `1 = 1` 并剔除对应参数
 * （跨分区读写）；adminTables 成员表的谓词保留、绑定值换超管会话租户。
 * **INSERT 永不中和**（Ling `processInsert` 纯透传）——本函数对其原样
 * 返回，INSERT 的 tenant 列写入由调用方走列位换值路径。非目标表上的
 * 谓词不参与任何改动，其参数序号天然不动。
 * @param sql - 语句文本（`?` 占位符）。
 * @param params - 位置参数。
 * @param rule - 列名与受控表清单。
 * @param admin - adminTables 集合与超管会话租户。
 * @returns 改写后的文本与参数组（未命中时均为原引用）。
 */
export function neutralizeTenantLine(
  sql: string,
  params: readonly unknown[] | undefined,
  rule: TenantLineRule,
  admin: { readonly adminTables: ReadonlySet<string>; readonly tenantId: string },
): TenantLineRewrite {
  const masked = maskQuoted(sql)
  const positions = questionPositions(masked)
  if (positions.length === 0) return { sql, params }
  const target = statementTarget(masked)
  if (target.insertColumns !== undefined) return { sql, params }
  const tables = rule.tables instanceof Set ? rule.tables : new Set(rule.tables)
  const cuts: Array<{ start: number; end: number; ordinal: number }> = []
  const swap = new Set<number>()
  const predicate = new RegExp(`(?:\\w+\\.)?${rule.column}\\s*=\\s*\\?`, 'g')
  for (const match of masked.matchAll(predicate)) {
    const at = match.index + match[0].length - 1
    const ref = /^(\w+)\./.exec(match[0])
    const table = ref !== null
      ? target.aliases?.get(ref[1]!)
      : target.primary === '' ? undefined : target.primary
    if (table === undefined || !tables.has(table)) continue
    const ordinal = ordinalBefore(positions, at)
    if (ordinal >= positions.length || ordinal >= (params?.length ?? 0)) continue
    if (admin.adminTables.has(table)) swap.add(ordinal)
    else cuts.push({ start: match.index, end: match.index + match[0].length, ordinal })
  }
  if (cuts.length === 0 && swap.size === 0) return { sql, params }
  // 文本重建：命中段替换为 `1 = 1`（掩码与原串等长，match.index 即原串索引；
  // 各 cut 按升序切片，替换长度不影响后续索引）。
  let out = ''
  let cursor = 0
  for (const cut of cuts) {
    out += sql.slice(cursor, cut.start) + '1 = 1'
    cursor = cut.end
  }
  out += sql.slice(cursor)
  // 参数重建（单趟）：cut 序号剔除、adminTables 命中换会话租户、其余原位。
  const cutOrdinals = new Set(cuts.map(cut => cut.ordinal))
  const next: unknown[] = []
  for (let i = 0; i < (params?.length ?? 0); i++) {
    if (cutOrdinals.has(i)) continue
    next.push(swap.has(i) ? admin.tenantId : params![i])
  }
  return { sql: out, params: next }
}

/**
 * 连接级拦截（= Ling `BasicTenantHandler.ignoreTable` 决策链对应物）：
 * 无上下文/豁免 → 不动；超管旁路 → INSERT 列位换值 / 其余形态中和；
 * 普通过滤 → 绑定值换值；其余（非主库语义等价位）→ 不动。
 */
function interceptFor(rule: TenantLineRule): (sql: string, params?: readonly unknown[]) => TenantLineRewrite {
  return (sql: string, params?: readonly unknown[]) => {
    const context = currentTenantLine()
    if (context === undefined || context.ignored === true) return { sql, params }
    if (context.adminBypass !== undefined) {
      // INSERT 永不中和（Ling processInsert 纯透传）：tenant 列写入走
      // 列位换值，adminTables 与否同换（超管落自己会话租户）。
      if (statementTarget(maskQuoted(sql)).insertColumns !== undefined) {
        return { sql, params: rewriteTenantLineParams(sql, params, rule, context.tenantId) }
      }
      return neutralizeTenantLine(sql, params, rule, {
        adminTables: context.adminBypass.adminTables,
        tenantId: context.tenantId,
      })
    }
    if (!context.filter) return { sql, params }
    if (/^\s*INSERT\b/i.test(sql)) return injectInsertTenantColumn(sql, params, rule, context.tenantId)
    // 换值（存量手写谓词）在前、缺失注入（设计基线：业务零租户谓词）在后
    const rewritten = rewriteTenantLineParams(sql, params, rule, context.tenantId)
    return injectTenantLinePredicates(sql, rewritten, rule, context.tenantId)
  }
}

/**
 * 给一个数据库外观装上租户行拦截：`query`/`execute`（含事务与
 * `withConnection` 内的连接）在上下文生效时注入缺失的租户谓词并对存量
 * 手写谓词换值（超管旁路语境下中和谓词文本）；其余成员透传。原外观保持
 * 可用（迁移/管理语句可继续用未包装的引用）。
 * @param database - 任意 `RdbDatabase` 形状的外观。
 * @param rules - 规则或规则数组（**租户列非标准表独立配置**：每条规则
 *   自持列名+受控表清单，如标准表一条 `{ column: 'f_tenant_id', tables:
 *   [...] }`、特殊表另一条 `{ column: 'tenant_code', tables: [...] }`；
 *   拦截按规则链依次生效，互不干扰）。
 * @returns 包装后的外观（接口形状，不保留提供方扩展方法）。
 */
export function wrapTenantLineDatabase(database: RdbDatabase, rules: TenantLineRule | readonly TenantLineRule[]): RdbDatabase {
  const list = Array.isArray(rules) ? rules : [rules]
  const interceptors = list.map(rule => interceptFor(rule))
  const intercept = (sql: string, params?: readonly unknown[]): TenantLineRewrite =>
    interceptors.reduce((acc, fn) => fn(acc.sql, acc.params), { sql, params } as TenantLineRewrite)
  const wrapConnection = (conn: RdbConnection): RdbConnection => ({
    query: (sql, params) => { const r = intercept(sql, params); return conn.query(r.sql, r.params) },
    execute: (sql, params) => { const r = intercept(sql, params); return conn.execute(r.sql, r.params) },
    beginTransaction: () => conn.beginTransaction(),
    commit: () => conn.commit(),
    rollback: () => conn.rollback(),
  })
  return {
    name: database.name,
    dialect: database.dialect,
    identity: database.identity,
    query: (sql, params) => { const r = intercept(sql, params); return database.query(r.sql, r.params) },
    execute: (sql, params) => { const r = intercept(sql, params); return database.execute(r.sql, r.params) },
    withConnection: work => database.withConnection(conn => work(wrapConnection(conn))),
    transaction: work => database.transaction(conn => work(wrapConnection(conn))),
    close: () => database.close(),
  }
}
