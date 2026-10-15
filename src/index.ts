/**
 * Relational database hub (`ctx.rdb`): a named database registry. Providers
 * (e.g. dsh-rdb-mysql) mount one {@link RdbDatabase} per row under a
 * registry name; consumers resolve by that name and code against the
 * transport contracts in `types.ts`. The hub performs no IO itself.
 * @module dsh-rdb
 */

import { Context, Service } from '@ling2/ling-cordis'
import { RdbDatabaseRegistry } from './registry.ts'

export { RdbDatabaseRegistry } from './registry.ts'
export { RdbError } from './error.ts'
export type { RdbErrorCode } from './error.ts'
export { migrateRdb, MIGRATION_TABLE_NAME_RE } from './migrate.ts'
export type { RdbMigration, RdbMigrations } from './migrate.ts'
export { numberedPlaceholders } from './placeholders.ts'
export type { PlaceholderStyle } from './placeholders.ts'
// 方言写语句收敛层（挂账⑤单点：结构化 upsert 三态渲染 + 手写 SQL 文本适配）
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
// mbp 语义层（方案 C：描述符 → BaseMapper → 强制填充 → 行映射 → Wrapper）
export {
  BaseMapper,
  MbpFillHolder,
  defineTable,
  columnOf,
  decodeRowWith,
  encodeValue,
  mbpWrapper,
  MbpWrapper,
  patchFromInput,
  randomUuidGenerator,
  runWithMbpFill,
  currentMbpFill,
  toSqlDateTime,
  toIsoDateTime,
} from './mbp/index.ts'
export type {
  IdentifierGenerator,
  MbpColumnType,
  MbpColumnSpec,
  MbpExecutor,
  MbpFillSource,
  MbpFillValues,
  MbpMapperOptions,
  MbpPage,
  MbpPageQuery,
  MbpRow,
  MbpTableDescriptor,
  MbpTableSpec,
} from './mbp/index.ts'
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
export type {
  RdbConnection,
  RdbDatabase,
  RdbDialectName,
  RdbWriteResult,
} from './types.ts'

/**
 * Derive the Cordis lifecycle service that one named database provider row
 * supplies. Consumers inject these keys so activation cannot race provider
 * registration even though callers continue resolving databases through the
 * hub registry.
 * @param name - Database registry name, e.g. `sessions`.
 * @returns the corresponding lifecycle-only service key.
 */
export function rdbDatabaseServiceKey(name: string): string {
  return `rdb.database.${name}`
}

declare module '@ling2/ling-cordis' {
  interface Context {
    rdb: Rdb
  }
}

/**
 * The relational database hub service. Provider rows register databases
 * under `database`; consumers resolve with `ctx.rdb.database.get(name)`.
 */
export class Rdb extends Service {
  /** Named database table; multiple databases stay mounted side by side. */
  readonly database: RdbDatabaseRegistry = new RdbDatabaseRegistry()

  constructor(ctx: Context) {
    super(ctx, 'rdb')
  }
}

// Service packages default-export their service class and nothing else
// plugin-shaped: mixing a default export with a function-plugin `apply`
// makes the Loader drop the plugin namespace.
export default Rdb
