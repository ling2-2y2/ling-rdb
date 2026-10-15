/**
 * Kit domain: dependency-free statement-building and text-adaptation
 * utilities shared by every dialect provider (numbered placeholders,
 * structured upsert rendering, list-query kit, tenant predicate, JSON
 * column codec).
 * @module @ling2/ling-rdb/kit
 */

export { numberedPlaceholders } from './placeholders.ts'
export type { PlaceholderStyle } from './placeholders.ts'
export {
  adaptUpsertText,
  extractUpsertTable,
  hasMysqlUpsertText,
  insertIgnoreSql,
  pgPrimaryKeyColumns,
  renderPgUpsertText,
  upsertSql,
} from './upsert.ts'
export type {
  InsertIgnoreSpec,
  UpsertColumn,
  UpsertSpec,
  UpsertUpdate,
} from './upsert.ts'
export {
  RDB_AUDIT_COLUMNS,
  RDB_ID_COLUMN,
  RDB_TENANT_COLUMN,
  buildRdbListQuery,
  inFragment,
  rdbTableColumns,
  rdbTableStatements,
} from './query.ts'
export type {
  RdbBuiltSql,
  RdbListCondition,
  RdbListQuery,
  RdbListSpec,
  RdbTableColumnsSpec,
  RdbTableStatements,
  RdbTableStatementsSpec,
} from './query.ts'
export * from './tenant-line.ts'
export * from './json-text.ts'
