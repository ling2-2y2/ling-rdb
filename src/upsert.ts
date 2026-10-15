/**
 * 方言写语句收敛层（2026-09-23 波次 4.4 / 挂账⑤单点）：全树 MySQL 惯用
 * upsert 写法在此按目标方言渲染等价形态，调用方零方言分支。两个入口：
 *
 * ① **结构化 spec**（{@link upsertSql}/{@link insertIgnoreSql}）：调用方声明
 *    表/列/冲突键，按 `RdbDatabase.dialect` 渲染三族形态——mysql 维持
 *    `ON DUPLICATE KEY UPDATE`、postgresql/金仓走 `ON CONFLICT … DO UPDATE`、
 *    Oracle/达梦走 `MERGE INTO`（原 dsh-store/src/dialect.ts 收编上移，store
 *    经 re-export 保持 API 不变）。三种渲染的**绑参序恒等于插入列序**。
 *
 * ② **文本适配**（{@link adaptUpsertText}）：种子批/仓储持有的手写 SQL 文本
 *    原样保持 MySQL 形态（单源），执行前经本函数按方言翻译——mysql 探测
 *    不中即原样直通（行为零变化）；PG 族做两层翻译：**函数族**（IFNULL→
 *    COALESCE、INSTR→POSITION、DATE_ADD/DATE_SUB INTERVAL 形态）作用于
 *    全语句，**upsert 形态**（`ON DUPLICATE KEY UPDATE`→`ON CONFLICT (<键>)
 *    DO UPDATE SET`、`INSERT IGNORE INTO`→`ON CONFLICT (<键>) DO NOTHING`、
 *    `VALUES(col)`→`EXCLUDED.col`）作用于语句尾巴。冲突锚缺省内省目标表
 *    主键（PG 目录查询，进程级缓存）；锚在非主键唯一键上的语句（如
 *    mate_system_setting 的 `UNIQUE(setting_key)`，运行时 id 每次新发）必须
 *    显式传 `conflictKeys`，与 MySQL「任意唯一键冲突即更新」语义中对位锚
 *    的选择保持一致。
 *
 * 值槽约定：结构化入口的 `columns[].value` 只允许 `'?'`（绑参位）或 SQL
 * 字面量；文本适配不改写绑参/字面量本体（除 `VALUES(col)` 引用形），语句
 * 里出现用户输入仍由调用方走绑参——本模块产物是语句常量的构件，绝不拼接
 * 用户输入。
 * @module dsh-rdb/src/upsert
 */
import type { RdbDatabase } from './types.ts'
import type { RdbDialectName } from './types.ts'

// ────────────────────────── ① 结构化 spec ──────────────────────────

/** 插入列：`value` 为 `'?'`（绑参位，列序即参数序）或 SQL 字面量原样内联。 */
export interface UpsertColumn {
  readonly name: string
  readonly value: string
}

/**
 * 冲突更新列：`expr` 缺省 = 引用新行的同名列（mysql/Oracle 族
 * `new_row.<col>`、pg 族 `EXCLUDED.<col>`）；提供 `expr` = 引用目标表的
 * 裸表达式（如 `<table>.revision + 1`——三族方言都接受表限定引用）。
 */
export interface UpsertUpdate {
  readonly column: string
  readonly expr?: string
}

/** upsert 结构描述（表 / 插入列 / 冲突键 / 冲突更新列）。 */
export interface UpsertSpec {
  readonly table: string
  readonly columns: readonly UpsertColumn[]
  readonly conflictKeys: readonly string[]
  readonly updates: readonly UpsertUpdate[]
}

/** INSERT IGNORE 结构描述（表 / 插入列 / 冲突键——语义目标：跳过键冲突）。 */
export interface InsertIgnoreSpec {
  readonly table: string
  readonly columns: readonly UpsertColumn[]
  readonly conflictKeys: readonly string[]
}

/** 方言分派：mysql / postgresql·kingbase / oracle·dm 三族，其余 fail loud。 */
function assertSupportedDialect(dialect: RdbDialectName): void {
  if (dialect !== 'mysql' && dialect !== 'postgresql' && dialect !== 'kingbase' && dialect !== 'oracle' && dialect !== 'dm') {
    throw new Error(
      `dsh-rdb/upsert: 不支持的方言 '${dialect}'——支持清单：mysql / postgresql / kingbase / oracle / dm`
      + '（sqlite 无 upsert 等价形态）',
    )
  }
}

/** 更新列对齐宽度（保持既有手排 SQL 的可读形态）。 */
function updateWidth(updates: readonly UpsertUpdate[]): number {
  return Math.max(...updates.map(update => update.column.length))
}

/**
 * 渲染 upsert 语句（方言分支单点）。
 * @param dialect - 目标库方言（取自 `RdbDatabase.dialect`）。
 * @param spec - upsert 结构描述。
 * @returns 语句文本；绑参（`?`）序恒等于插入列序。
 */
export function upsertSql(dialect: RdbDialectName, spec: UpsertSpec): string {
  assertSupportedDialect(dialect)
  const cols = spec.columns.map(column => column.name).join(', ')
  const vals = spec.columns.map(column => column.value).join(', ')
  const width = updateWidth(spec.updates)
  switch (dialect) {
    case 'mysql':
      return `INSERT INTO ${spec.table} (${cols})
VALUES (${vals})
  AS new_row
ON DUPLICATE KEY UPDATE
  ${spec.updates.map(update => `${update.column.padEnd(width)} = ${update.expr ?? `new_row.${update.column}`}`).join(',\n  ')}`
    case 'kingbase':
    case 'postgresql':
      return `INSERT INTO ${spec.table} (${cols})
VALUES (${vals})
ON CONFLICT (${spec.conflictKeys.join(', ')}) DO UPDATE SET
  ${spec.updates.map(update => `${update.column} = ${update.expr ?? `EXCLUDED.${update.column}`}`).join(',\n  ')}`
    default: {
      // oracle / dm：参数集中在 USING 源行（列序 = 参数序），INSERT/UPDATE
      // 只引用别名，不重复绑参。
      const source = spec.columns.map(column => `${column.value} AS ${column.name}`).join(', ')
      const on = spec.conflictKeys.map(key => `${spec.table}.${key} = new_row.${key}`).join(' AND ')
      const insertCols = cols
      const insertVals = spec.columns.map(column => `new_row.${column.name}`).join(', ')
      return `MERGE INTO ${spec.table}
USING (SELECT ${source} FROM dual) new_row
ON (${on})
WHEN MATCHED THEN UPDATE SET
  ${spec.updates.map(update => `${update.column} = ${update.expr ?? `new_row.${update.column}`}`).join(',\n  ')}
WHEN NOT MATCHED THEN INSERT (${insertCols})
  VALUES (${insertVals})`
    }
  }
}

/**
 * 渲染 INSERT IGNORE 等价语句（方言分支单点）。语义对齐：mysql 的
 * `INSERT IGNORE` 会吞掉多种警告，其余两族只跳过唯一键冲突——调用方应
 * 保证冲突源只有唯一键（store 单例行的先例），两侧行为才一致。
 * @param dialect - 目标库方言（取自 `RdbDatabase.dialect`）。
 * @param spec - 结构描述。
 * @returns 语句文本；绑参（`?`）序恒等于插入列序。
 */
export function insertIgnoreSql(dialect: RdbDialectName, spec: InsertIgnoreSpec): string {
  assertSupportedDialect(dialect)
  const cols = spec.columns.map(column => column.name).join(', ')
  const vals = spec.columns.map(column => column.value).join(', ')
  switch (dialect) {
    case 'mysql':
      return `INSERT IGNORE INTO ${spec.table} (${cols}) VALUES (${vals})`
    case 'kingbase':
    case 'postgresql':
      return `INSERT INTO ${spec.table} (${cols}) VALUES (${vals})
ON CONFLICT (${spec.conflictKeys.join(', ')}) DO NOTHING`
    default: {
      // oracle / dm：只有 NOT MATCHED 分支 = 只在无冲突时插入。
      const source = spec.columns.map(column => `${column.value} AS ${column.name}`).join(', ')
      const on = spec.conflictKeys.map(key => `${spec.table}.${key} = new_row.${key}`).join(' AND ')
      const insertVals = spec.columns.map(column => `new_row.${column.name}`).join(', ')
      return `MERGE INTO ${spec.table}
USING (SELECT ${source} FROM dual) new_row
ON (${on})
WHEN NOT MATCHED THEN INSERT (${cols})
  VALUES (${insertVals})`
    }
  }
}

// ────────────────────────── ② 文本适配 ──────────────────────────

/** MySQL 专有 upsert 写法探测（cheap probe：一次正则，不中即直通）。 */
export function hasMysqlUpsertText(sql: string): boolean {
  return /ON\s+DUPLICATE\s+KEY|INSERT\s+IGNORE\s+INTO|REPLACE\s+INTO/i.test(sql)
}

/** MySQL 专有函数族探测（与 translateMysqlFunctionsToPg 的覆盖面一一对应）。 */
export function hasMysqlFunctionText(sql: string): boolean {
  return /\b(IFNULL|INSTR|DATE_ADD|DATE_SUB|UUID)\s*\(/i.test(sql)
}

/**
 * MySQL 多表 `UPDATE … JOIN(…) ON … SET …` → PG `UPDATE … SET … FROM(…)
 * WHERE …`（纯函数，导出供回归钉）。要点：SET 从 ON 之后搬到 FROM 之前、
 * JOIN 子查询整体下沉为 FROM 源、SET 左值剥目标表别名限定（PG 只认裸列名）、
 * ON 条件并入 WHERE。
 */
export function translateMysqlUpdateJoinToPg(text: string): string {
  const head = /UPDATE\s+([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*)\s+JOIN\s*\(/i.exec(text)
  if (head === null) return text
  const parenAt = head.index + head[0].length - 1
  let depth = 0
  let i = parenAt
  for (; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === "'") {
      for (i += 1; i < text.length; i += 1) {
        if (text[i] === "'" && text[i + 1] !== "'") break
        if (text[i] === "'") i += 1
      }
    } else if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (depth === 0 && ch === ')') break
  }
  if (depth !== 0) throw new Error('dsh-rdb/upsert: UPDATE JOIN 子查询括号不配平')
  const subquery = text.slice(parenAt, i + 1)
  const rest = text.slice(i + 1)
  const tail = /\s*(\w+)\s+ON\s+([\s\S]+?)\s+SET\s+([\s\S]+)$/i.exec(rest)
  if (tail === null) throw new Error(`dsh-rdb/upsert: UPDATE JOIN 尾部须为 "ON <条件> SET <赋值>" 形态：${rest.slice(0, 120)}`)
  const joinAlias = tail[1]!
  // 剥掉语句尾分号再重组（否则分号截断 SET 与 FROM），末尾统一补回
  const hadSemicolon = /;\s*$/.test(tail[3]!)
  const setBody = tail[3]!.replace(/;\s*$/, '').trim()
    .replace(new RegExp(`\\b${head[2]}\\.([A-Za-z_][\\w]*)\\s*=`, 'g'), '$1 =')
  return `UPDATE ${head[1]} ${head[2]}\nSET ${setBody}\nFROM ${subquery} ${joinAlias}\nWHERE ${tail[2]!.trim()}${hadSemicolon ? ';' : ''}`
}

/** 布尔字面量探测（MySQL 无布尔类型——TRUE/FALSE 恒为 TINYINT 0/1 别名）。 */
export function hasMysqlBoolLiteral(sql: string): boolean {
  return /\b(TRUE|FALSE)\b/i.test(sql)
}

/** `FROM DUAL` 探测（MySQL 下 SELECT 带 WHERE 必须挂 DUAL；PG 无此表）。 */
export function hasMysqlFromDual(sql: string): boolean {
  return /FROM\s+DUAL\b/i.test(sql)
}

/**
 * 字符串字面量内的 `\'` 反斜杠转义归一为 `''`（MySQL 两种转义都收，PG
 * 标准字符串只认 `''`——`standard_conforming_strings=on` 下 `\'` 会让撇号
 * 提前终止字符串）。反斜杠其余用法（`\\`、`\n` 字面）不触碰。
 */
export function normalizeMysqlEscapedQuotesToPg(text: string): string {
  let out = ''
  let inSingle = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (!inSingle) {
      if (ch === "'") inSingle = true
      out += ch
      i += 1
      continue
    }
    // 单引号串内
    if (ch === '\\' && text[i + 1] === "'") {
      out += "''"
      i += 2
      continue
    }
    if (ch === "'") inSingle = false
    out += ch
    i += 1
  }
  return out
}

/**
 * 剥 `FROM DUAL`（注释与字符串内不误翻）：PG 的 SELECT 无需 FROM 表即可带
 * WHERE——`INSERT … SELECT … FROM DUAL WHERE NOT EXISTS(…)`（MySQL skip-if-
 * exists 播种惯用法）剥后即为合法 PG 等价形态。
 */
export function stripMysqlFromDualToPg(text: string): string {
  const mask = outsideString(text)
  return text.replace(/FROM\s+DUAL\b/gi, (m, offset: number) => (mask[offset] === false ? m : ''))
}

/**
 * 布尔字面量归一：TRUE→1、FALSE→0（注释与字符串字面量内不误翻）。
 * MySQL 家族表的布尔位是 TINYINT(1)（PG 侧经生成器映射 SMALLINT），
 * MySQL 中 TRUE/FALSE 本就是 0/1 别名——改写对 MySQL 行为零变化、对 PG
 * 消除 `smallint = boolean` 类型错（PG 真库终验实证雷）。
 */
export function translateMysqlBoolLiteralsToPg(text: string): string {
  const mask = outsideString(text)
  let out = ''
  let i = 0
  for (;;) {
    const m = /\b(TRUE|FALSE)\b/i.exec(text.slice(i))
    if (m === null) break
    const at = i + m.index
    if (!mask[at]) {
      // 注释/字符串内的命中原样带上（跳过=照抄本段）
      out += text.slice(i, at + m[0].length)
    } else {
      out += text.slice(i, at) + (m[1].toUpperCase() === 'TRUE' ? '1' : '0')
    }
    i = at + m[0].length
  }
  return out + text.slice(i)
}

/** 从 INSERT 语句头提取目标表名（支持可选反引号；本树表名均无 schema 限定）。 */
export function extractUpsertTable(sql: string): string {
  const match = /INSERT\s+(?:IGNORE\s+)?INTO\s+`?([A-Za-z_][A-Za-z0-9_]*)`?/i.exec(sql)
  if (match === null) {
    throw new Error(`dsh-rdb/upsert: 无法从语句提取目标表名——语句头形如 INSERT [IGNORE] INTO <表>：${sql.slice(0, 120)}`)
  }
  return match[1]!
}

/** 括号/引号深度感知的顶层逗号切分（`''` 转义、反引号、双引号均不越界）。 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inSingle) {
      if (ch === "'") {
        // SQL 单引号串内 '' 为转义引号，两个一起消费
        if (text[i + 1] === "'") i += 1
        else inSingle = false
      }
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      continue
    }
    if (inBacktick) {
      if (ch === '`') inBacktick = false
      continue
    }
    if (ch === "'") inSingle = true
    else if (ch === '"') inDouble = true
    else if (ch === '`') inBacktick = true
    else if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** 更新尾巴里 `VALUES(col)` 引用改写为 `EXCLUDED.col`（PG 族新行引用）。 */
function rewriteValuesRefs(tail: string): string {
  return tail.replace(/\bVALUES\s*\(\s*`?([A-Za-z_][A-Za-z0-9_]*)`?\s*\)/gi, (_m, col: string) => `EXCLUDED.${col}`)
}

/** DO UPDATE SET 表达式里的保留字（不参与表名限定）。 */
const NON_QUALIFIABLE = new Set([
  'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'LOCALTIME', 'LOCALTIMESTAMP',
  'NULL', 'TRUE', 'FALSE', 'DEFAULT', 'EXCLUDED',
])

/**
 * 赋值右值的裸列引用补表名限定（`n = n + 1` → `n = <表>.n + 1`）：MySQL
 * ON DUPLICATE 的右值裸列指既有行，PG DO UPDATE SET 里目标表与 excluded
 * 伪关系都暴露同名列——裸引用一律报歧义（42702，PG 真库实证），必须
 * 表名限定才指向既有行。函数调用名（后随 `(`）、点限定、字符串字面量、
 * 保留字不动。
 */
function qualifyBareRefs(rhs: string, table: string): string {
  const mask = outsideString(rhs)
  let out = ''
  let i = 0
  while (i < rhs.length) {
    if (!mask[i]) {
      out += rhs[i]
      i += 1
      continue
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rhs.slice(i))
    if (m === null) {
      out += rhs[i]
      i += 1
      continue
    }
    const ident = m[0]
    const after = i + ident.length
    if (rhs[after] === '(' || /\.\s*$/.test(rhs.slice(0, i)) || NON_QUALIFIABLE.has(ident.toUpperCase())) {
      out += ident
    } else {
      out += `${table}.${ident}`
    }
    i = after
  }
  return out
}

/** 顶层（括号/引号外）首个 `=` 的下标；无则 -1。 */
function topLevelEqualsIndex(text: string): number {
  let depth = 0
  let inSingle = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") i += 1
        else inSingle = false
      }
      continue
    }
    if (ch === "'") inSingle = true
    else if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === '=' && depth === 0) return i
  }
  return -1
}

/**
 * 在 text 中定位 name( 调用并返回实参边界（括号配平、引号感知）。
 * @returns 实参整体文本与右括号后偏移；未命中返回 null。
 */
function findCall(text: string, start: number, name: string): { args: string; end: number } | null {
  const call = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
  call.lastIndex = start
  for (let m = call.exec(text); m !== null; m = call.exec(text)) {
    if (m[1]!.toUpperCase() !== name) continue
    let depth = 1
    let i = m.index + m[0].length
    const argStart = i
    for (; i < text.length && depth > 0; i += 1) {
      const ch = text[i]
      if (ch === '\'') {
        for (i += 1; i < text.length; i += 1) {
          if (text[i] === '\'' && text[i + 1] !== '\'') break
          if (text[i] === '\'') i += 1
        }
      } else if (ch === '(') depth += 1
      else if (ch === ')') depth -= 1
    }
    if (depth !== 0) throw new Error(`dsh-rdb/upsert: ${name}(...) 括号不配平：${text.slice(m.index, m.index + 120)}`)
    return { args: text.slice(argStart, i - 1), end: i }
  }
  return null
}

/** 顶层逗号切分（复用赋值切分器）。 */
const splitArgs = (args: string): string[] => splitTopLevel(args).map(part => part.trim())

/**
 * MySQL 专有函数族 → PG 等价翻译（纯函数，导出供回归钉）。覆盖手写 SQL
 * 实测在用的家族：IFNULL→COALESCE、INSTR(a,b)→POSITION(b IN a)、
 * DATE_ADD/DATE_SUB 的 INTERVAL 形态→`± INTERVAL 'n UNIT'`。实参递归翻译
 * （嵌套调用成立）；未识别形态原样保留（由门禁在提交期拦新增）。
 */
export function translateMysqlFunctionsToPg(text: string): string {
  let out = text
  // 逐次替换首个命中（实参递归翻译，嵌套在替换内收敛）；兄弟出现靠循环，
  // 每次替换稳定消去一个函数名，必然进展。
  for (;;) {
    const replaced = replaceFirstFamily(out)
    if (replaced === null) return out
    out = replaced
  }
}

/** 字符位掩码：true=该字符在字符串/模板串之外（注释与字符串内的同名调用不误翻）。 */
function outsideString(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(true)
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'") {
      mask[i] = false
      i += 1
      while (i < text.length) {
        mask[i] = false
        if (text[i] === "'") {
          if (text[i + 1] === "'") { mask[i + 1] = false; i += 2; continue }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '"' || ch === '`') {
      const quote = ch
      mask[i] = false
      i += 1
      while (i < text.length) {
        mask[i] = false
        if (text[i] === '\\') {
          if (i + 1 < text.length) mask[i + 1] = false
          i += 2
          continue
        }
        if (text[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') {
        mask[i] = false
        i += 1
      }
      continue
    }
    i += 1
  }
  return mask
}

/** 单次替换文本中第一个命中的家族函数（内部实现，见 translateMysqlFunctionsToPg）。 */
function replaceFirstFamily(text: string): string | null {
  const mask = outsideString(text)
  for (const name of ['IFNULL', 'INSTR', 'DATE_ADD', 'DATE_SUB', 'UUID'] as const) {
    const re = name === 'UUID' ? /\bUUID\s*\(\s*\)/gi : new RegExp(`${name}\\s*\\(`, 'gi')
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (!mask[m.index]) continue
      if (name === 'UUID') {
        // MySQL UUID() → PG 内建 gen_random_uuid()（PG13+）
        return text.slice(0, m.index) + 'gen_random_uuid()' + text.slice(m.index + m[0].length)
      }
      const hit = findCall(text, m.index, name)
      if (hit === null) continue
      const args = splitArgs(hit.args).map(arg => translateMysqlFunctionsToPg(arg))
      let replacement: string
      if (name === 'IFNULL') {
        replacement = `COALESCE(${args.join(', ')})`
      } else if (name === 'INSTR') {
        if (args.length !== 2) throw new Error(`dsh-rdb/upsert: INSTR 需要 2 个实参：${text.slice(m.index, m.index + 120)}`)
        replacement = `POSITION(${args[1]} IN ${args[0]})`
      } else {
        // DATE_ADD / DATE_SUB：MySQL 形态 (expr, INTERVAL v UNIT) → PG (expr ± INTERVAL 'v UNIT')
        if (args.length !== 2) throw new Error(`dsh-rdb/upsert: ${name} 需要 2 个实参：${text.slice(m.index, m.index + 120)}`)
        const interval = /^INTERVAL\s+(.+)$/is.exec(args[1]!)
        if (interval === null) throw new Error(`dsh-rdb/upsert: ${name} 第二实参须为 INTERVAL v UNIT 形态：${args[1]!.slice(0, 80)}`)
        const op = name === 'DATE_ADD' ? '+' : '-'
        replacement = `(${args[0]} ${op} INTERVAL '${interval[1]!.trim()}')`
      }
      return text.slice(0, m.index) + replacement + text.slice(hit.end)
    }
  }
  return null
}

/**
 * 渲染 PG 族 ON CONFLICT 等价文本（纯函数，导出供回归钉）。
 * @param sql - MySQL 形态语句（`ON DUPLICATE KEY UPDATE` 或 `INSERT IGNORE INTO`）。
 * @param conflictKeys - 冲突锚列（主键或语句意图锚定的唯一键）。
 * @returns PG 形态语句。
 */
export function renderPgUpsertText(sql: string, conflictKeys: readonly string[]): string {
  const dupMatch = /ON\s+DUPLICATE\s+KEY\s+UPDATE/i.exec(sql)
  if (dupMatch !== null) {
    const table = extractUpsertTable(sql)
    const head = sql.slice(0, dupMatch.index).trimEnd()
    const tail = sql.slice(dupMatch.index + dupMatch[0].length)
    const assignments = splitTopLevel(tail)
      .map(part => {
        const body = rewriteValuesRefs(part.trim())
        const eq = topLevelEqualsIndex(body)
        if (eq < 0) return body
        return `${body.slice(0, eq)}=${qualifyBareRefs(body.slice(eq + 1), table)}`
      })
      .filter(part => part !== '')
      .join(', ')
    return `${head}\nON CONFLICT (${conflictKeys.join(', ')}) DO UPDATE SET ${assignments}`
  }
  const ignoreMatch = /INSERT\s+IGNORE\s+INTO/i.exec(sql)
  if (ignoreMatch !== null) {
    const head = sql.slice(0, ignoreMatch.index)
      + sql.slice(ignoreMatch.index, ignoreMatch.index + ignoreMatch[0].length).replace(/INSERT\s+IGNORE\s+INTO/i, 'INSERT INTO')
      + sql.slice(ignoreMatch.index + ignoreMatch[0].length)
    return `${head.trimEnd()}\nON CONFLICT (${conflictKeys.join(', ')}) DO NOTHING`
  }
  throw new Error(`dsh-rdb/upsert: 语句不含可翻译的 MySQL upsert 写法：${sql.slice(0, 120)}`)
}

/** 主键内省缓存（进程级；键 = `<库名>.<表名>`——schema 迁移后进程内稳定）。 */
const primaryKeyCache = new Map<string, readonly string[]>()

/**
 * 内省目标表主键列（PG 目录查询；mysql 无需——文本直通不走到这）。
 * @param db - 目标库外观（提供目录查询面）。
 * @param table - 表名（当前库 search_path 内）。
 * @returns 主键列（复合键按列序）；表无主键 fail loud。
 */
export async function pgPrimaryKeyColumns(db: RdbDatabase, table: string): Promise<readonly string[]> {
  const cacheKey = `${db.name}.${table}`
  const cached = primaryKeyCache.get(cacheKey)
  if (cached !== undefined) return cached
  const rows = await db.query<{ col: string }>(
    'SELECT a.attname AS col FROM pg_index i'
    + ' JOIN pg_class c ON c.oid = i.indrelid'
    + ' JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)'
    + ' WHERE c.relname = ? AND i.indisprimary'
    + ' ORDER BY a.attnum',
    [table],
  )
  const columns = rows.map(row => row.col)
  if (columns.length === 0) {
    throw new Error(
      `dsh-rdb/upsert: 表 '${table}'（库 '${db.name}'）无主键——ON DUPLICATE 语义无法内省冲突锚，`
      + '请在调用方显式传 conflictKeys 或改用结构化 upsertSql 入口',
    )
  }
  primaryKeyCache.set(cacheKey, columns)
  return columns
}

/**
 * 手写 SQL 文本的方言适配（执行前单点翻译）。mysql 原样直通；语句不含
 * MySQL 专有 upsert 写法时同样原样直通（CREATE/SELECT/普通 INSERT 零改动）。
 * @param db - 目标库外观（提供方言名与 PG 主键内省）。
 * @param sql - MySQL 形态语句文本。
 * @param conflictKeys - 显式冲突锚；缺省 = 内省目标表主键。锚在非主键唯一
 *   键上的语句**必须**显式声明（MySQL 任意唯一键语义的 PG 对位只认单一锚）。
 * @returns 目标方言等价语句。
 */
export async function adaptUpsertText(db: RdbDatabase, sql: string, conflictKeys?: readonly string[]): Promise<string> {
  if (db.dialect === 'mysql') return sql
  if (!hasMysqlUpsertText(sql) && !hasMysqlFunctionText(sql) && !hasMysqlBoolLiteral(sql)
    && !hasMysqlFromDual(sql) && !/\\'/i.test(sql)) return sql
  if (/REPLACE\s+INTO/i.test(sql)) {
    throw new Error('dsh-rdb/upsert: REPLACE INTO 语义（删旧插新）无文本级等价翻译，请改写为显式 DELETE+INSERT 或结构化入口')
  }
  if (db.dialect !== 'postgresql' && db.dialect !== 'kingbase') {
    throw new Error(
      `dsh-rdb/upsert: 方言 '${db.dialect}' 暂无文本适配（当前支持 mysql 直通 / postgresql / kingbase）——`
      + 'Oracle/达梦请改用结构化 upsertSql（MERGE 渲染）',
    )
  }
  // 翻译链（各步互不依赖、顺序无关碰撞）：①`\'`→`''`（先行——后续各步
  // 的字符串掩码按归一后文本计算）②函数族 ③布尔字面量 ④FROM DUAL 剥除
  // ⑤UPDATE JOIN 改写；upsert 尾巴手术最后执行。
  const translated = translateMysqlUpdateJoinToPg(
    stripMysqlFromDualToPg(
      translateMysqlFunctionsToPg(
        translateMysqlBoolLiteralsToPg(
          normalizeMysqlEscapedQuotesToPg(sql),
        ),
      ),
    ),
  )
  if (!hasMysqlUpsertText(translated)) return translated
  const table = extractUpsertTable(translated)
  const keys = conflictKeys ?? await pgPrimaryKeyColumns(db, table)
  return renderPgUpsertText(translated, keys)
}