/**
 * Statement-building kit for consumers of the `ctx.rdb` hub: column-list
 * scaffolding, fixed table templates (SELECT / INSERT / DELETE by id), and
 * a declarative paged-list builder. Everything is a pure function that
 * emits inline SQL text with `?` placeholders — the kit performs no IO,
 * owns no connection, and assumes no dialect beyond positional
 * placeholders, so emitted statements stay as auditable as hand-written
 * constants and keep flowing through {@link RdbDatabase.query} /
 * {@link RdbDatabase.execute} unchanged.
 *
 * Defaults bake in this plugin family's Ling-style table conventions —
 * id column `f_id`, partition column `f_tenant_id`, and the four-column
 * audit tail — every one overridable per call for tables that deviate.
 * @module @ling2/ling-rdb/hub/query
 */

/** Standard audit tail shared by the family's Ling-style tables. */
export const RDB_AUDIT_COLUMNS: readonly string[] = [
  'f_creator_time',
  'f_creator_user_id',
  'f_last_modify_time',
  'f_last_modify_user_id',
]

/** Default id column of {@link RdbTableColumnsSpec} and friends. */
export const RDB_ID_COLUMN = 'f_id'

/** Default tenant partition column of {@link RdbTableColumnsSpec} and friends. */
export const RDB_TENANT_COLUMN = 'f_tenant_id'

/** A built statement plus its positional parameter values. */
export interface RdbBuiltSql {
  /** Statement text with `?` placeholders; values are never interpolated. */
  readonly sql: string
  /** Positional parameters matching the placeholders, left to right. */
  readonly params: readonly unknown[]
}

/** Render `?` placeholders joined by `, ` for a column-count position list. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

// ---------------------------------------------------------------------------
// Column-list scaffolding.

/** Column-list assembly spec of one Ling-style table. */
export interface RdbTableColumnsSpec {
  /** Data columns in projection order (e.g. `Object.values` of a domain COLUMN_MAP). */
  readonly data: readonly string[]
  /**
   * Audit columns appended after the data columns; default
   * {@link RDB_AUDIT_COLUMNS}, `[]` omits the tail entirely.
   */
  readonly audit?: readonly string[]
  /** Extra columns between audit and partition (e.g. `f_delete_mark`). */
  readonly extra?: readonly string[]
  /** Id column placed first; default {@link RDB_ID_COLUMN}, `null` omits. */
  readonly idColumn?: string | null
  /** Partition column placed last; default {@link RDB_TENANT_COLUMN}, `null` omits. */
  readonly tenantColumn?: string | null
}

/**
 * Assemble one table's full column list in the family's canonical order:
 * id, data, audit tail, extras, partition. The output is the single
 * source for SELECT projections and INSERT column lists.
 * @param spec - Column assembly spec.
 * @returns the column names in projection order.
 */
export function rdbTableColumns(spec: RdbTableColumnsSpec): readonly string[] {
  return [
    ...(spec.idColumn === null ? [] : [spec.idColumn ?? RDB_ID_COLUMN]),
    ...spec.data,
    ...(spec.audit ?? RDB_AUDIT_COLUMNS),
    ...(spec.extra ?? []),
    ...(spec.tenantColumn === null ? [] : [spec.tenantColumn ?? RDB_TENANT_COLUMN]),
  ]
}

// ---------------------------------------------------------------------------
// Fixed table statement templates.

/** Template assembly spec of one table. */
export interface RdbTableStatementsSpec {
  /** Table name, interpolated into DML as a fixed identifier. */
  readonly table: string
  /** SELECT projection columns. */
  readonly columns: readonly string[]
  /**
   * INSERT column list; default {@link RdbTableStatementsSpec.columns}.
   * Pass a different list when the insert omits select columns (e.g. a
   * creator-only audit tail).
   */
  readonly insertColumns?: readonly string[]
  /** Id column of the WHERE predicates; default {@link RDB_ID_COLUMN}. */
  readonly idColumn?: string
  /** Partition column appended to the WHERE predicates; default
   * {@link RDB_TENANT_COLUMN}, `null` marks an unpartitioned table. */
  readonly tenantColumn?: string | null
}

/** The four fixed statements one Ling-style table needs. */
export interface RdbTableStatements {
  /** `SELECT <columns> FROM <table>`. */
  readonly select: string
  /** `… WHERE <id> = ? [AND <tenant> = ?]`. */
  readonly selectById: string
  /** `INSERT INTO <table> (<columns>) VALUES (…)`. */
  readonly insert: string
  /** `DELETE FROM <table> WHERE <id> = ? [AND <tenant> = ?]`. */
  readonly deleteById: string
}

/**
 * Render the fixed statement templates of one table from its column
 * lists. Output is byte-identical to the hand-written constants the
 * domains carried before this kit.
 * @param spec - Template assembly spec.
 * @returns the four statement texts.
 */
export function rdbTableStatements(spec: RdbTableStatementsSpec): RdbTableStatements {
  const idColumn = spec.idColumn ?? RDB_ID_COLUMN
  const tenantColumn = spec.tenantColumn === null ? null : spec.tenantColumn ?? RDB_TENANT_COLUMN
  const partition = tenantColumn === null ? '' : ` AND ${tenantColumn} = ?`
  const insertColumns = spec.insertColumns ?? spec.columns
  return {
    select: `SELECT ${spec.columns.join(', ')} FROM ${spec.table}`,
    selectById: `SELECT ${spec.columns.join(', ')} FROM ${spec.table} WHERE ${idColumn} = ?${partition}`,
    insert: `INSERT INTO ${spec.table} (${insertColumns.join(', ')}) VALUES (${placeholders(insertColumns.length)})`,
    deleteById: `DELETE FROM ${spec.table} WHERE ${idColumn} = ?${partition}`,
  }
}

// ---------------------------------------------------------------------------
// IN-list fragments.

/**
 * Render `column IN (?, …)` with one placeholder per value; an empty
 * list renders the never-matching `1 = 0` so callers need no empty guard.
 * @param column - Fixed column name.
 * @param values - Parameter values; their count sets the placeholder count.
 * @returns the predicate fragment.
 */
export function inFragment(column: string, values: readonly unknown[]): string {
  if (values.length === 0) return '1 = 0'
  return `${column} IN (${placeholders(values.length)})`
}

// ---------------------------------------------------------------------------
// Declarative paged-list builder.

/** One condition of a list query, in emission order. */
export type RdbListCondition =
  | {
    readonly kind: 'eq'
    /** Fixed column name of the equality predicate. */
    readonly column: string
    /** Bound value; `undefined` skips the condition entirely. */
    readonly value: unknown
  }
  | {
    readonly kind: 'keyword'
    /** Columns matched by the keyword, wrapped in one `(a LIKE ? OR …)` group. */
    readonly columns: readonly string[]
    /** Keyword value; `undefined` or `''` skips the condition unless `keepEmpty`. */
    readonly value: string | undefined
    /**
     * Emit the clause even for an empty keyword (`%%` matches everything) —
     * Ling's join-list quirk of testing only `!== undefined`.
     */
    readonly keepEmpty?: boolean
  }
  | {
    readonly kind: 'raw'
    /** Verbatim predicate fragment; identifiers must be fixed, values bound via `params`. */
    readonly sql: string
    readonly params?: readonly unknown[]
  }
  | {
    readonly kind: 'tenant'
    /** Partition value bound against the spec's tenant column. */
    readonly value: string
  }

/** Declarative spec of one paged list query. */
export interface RdbListSpec {
  /**
   * Table name, or full FROM-clause text for aliased/join queries (e.g.
   * `base_module m LEFT JOIN base_system s ON …`).
   */
  readonly table: string
  /** Row projection columns. */
  readonly columns: readonly string[]
  /** Conditions in emission order, joined by `AND`; inactive ones drop out. */
  readonly conditions: readonly RdbListCondition[]
  /** Partition column of the `tenant` condition; default {@link RDB_TENANT_COLUMN}, `null` forbids it. */
  readonly tenantColumn?: string | null
  /** ORDER BY terms of the rows query. */
  readonly order: readonly string[]
  /** Terms appended to the order while a keyword condition is active. */
  readonly keywordOrder?: readonly string[]
  /**
   * Paging window of the rows query; `LIMIT ? OFFSET ?` is emitted only
   * when `pageSize` is present, `offset` defaults to 0.
   */
  readonly paging?: { readonly pageSize?: number; readonly offset?: number }
}

/** A list query plus its COUNT twin sharing the same WHERE clause. */
export interface RdbListQuery extends RdbBuiltSql {
  /**
   * COUNT twin: same WHERE and parameters, `COUNT(*) AS n` projection,
   * no ORDER BY and no LIMIT — the paging parameters never leak into it.
   */
  readonly countSql: string
  /** Placeholder values of {@link RdbListQuery.countSql}. */
  readonly countParams: readonly unknown[]
}

/**
 * Build one paged list query from a declarative spec. The rows query
 * carries the ORDER BY (plus the keyword tie-breaker terms while a
 * keyword is active) and `LIMIT ? OFFSET ?` when a page size is set; the
 * count twin shares the WHERE clause without order or paging. With no
 * active condition the WHERE clause is omitted entirely.
 * @param spec - Declarative list spec.
 * @returns the rows query and its COUNT twin.
 */
export function buildRdbListQuery(spec: RdbListSpec): RdbListQuery {
  const where: string[] = []
  const params: unknown[] = []
  let keywordActive = false
  for (const condition of spec.conditions) {
    switch (condition.kind) {
      case 'eq': {
        if (condition.value === undefined) break
        where.push(`${condition.column} = ?`)
        params.push(condition.value)
        break
      }
      case 'keyword': {
        const { value } = condition
        if (value === undefined || (value === '' && condition.keepEmpty !== true)) break
        where.push(`(${condition.columns.map(column => `${column} LIKE ?`).join(' OR ')})`)
        const like = `%${value}%`
        params.push(...condition.columns.map(() => like))
        keywordActive = true
        break
      }
      case 'raw': {
        where.push(condition.sql)
        params.push(...condition.params ?? [])
        break
      }
      case 'tenant': {
        const tenantColumn = spec.tenantColumn === undefined ? RDB_TENANT_COLUMN : spec.tenantColumn
        if (tenantColumn === null) {
          throw new Error(`rdb list on '${spec.table}': tenant condition needs a tenant column`)
        }
        where.push(`${tenantColumn} = ?`)
        params.push(condition.value)
        break
      }
      default: {
        // Discriminated union is closed; the default arm is unreachable.
        const never: never = condition
        throw new Error(`unknown rdb list condition: ${String(never)}`)
      }
    }
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  const orderTerms = keywordActive && spec.keywordOrder !== undefined
    ? [...spec.order, ...spec.keywordOrder]
    : spec.order
  const orderSql = orderTerms.length > 0 ? ` ORDER BY ${orderTerms.join(', ')}` : ''
  const countParams: unknown[] = [...params]
  let sql = `SELECT ${spec.columns.join(', ')} FROM ${spec.table}${whereSql}${orderSql}`
  if (spec.paging?.pageSize !== undefined) {
    sql += ' LIMIT ? OFFSET ?'
    params.push(spec.paging.pageSize, spec.paging.offset ?? 0)
  }
  return {
    sql,
    params,
    countSql: `SELECT COUNT(*) AS n FROM ${spec.table}${whereSql}`,
    countParams,
  }
}
