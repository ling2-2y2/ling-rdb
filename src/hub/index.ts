/**
 * Hub domain: named database registry, transport contracts, migration
 * runner, error type. `rdbDatabaseServiceKey` gives provider rows their
 * lifecycle service keys (consumers fence activation with it).
 * @module @ling2/ling-rdb/hub
 */

export { RdbDatabaseRegistry, rdbDatabaseServiceKey } from './registry.ts'
export { RdbError } from './error.ts'
export type { RdbErrorCode } from './error.ts'
export { migrateRdb, MIGRATION_TABLE_NAME_RE } from './migrate.ts'
export type { RdbMigration, RdbMigrations } from './migrate.ts'
export type {
  RdbConnection,
  RdbDatabase,
  RdbDialectName,
  RdbWriteResult,
} from './types.ts'
