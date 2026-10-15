/**
 * dts 冒烟——外部消费者视角钉发布类型面。双管线主靶：tsc 直出的 d.ts 模块
 * 树必须完整（相对路径自洽），且 `declare module '@ling2/ling-cordis'` 的
 * `Context.rdb` 增强随包可见。
 */
import Rdb, {
  BaseMapper,
  RDB_AUDIT_COLUMNS,
  RdbDatabaseRegistry,
  RdbError,
  adaptUpsertText,
  buildRdbListQuery,
  defineTable,
  migrateRdb,
  numberedPlaceholders,
  rdbDatabaseServiceKey,
  toSqlDateTime,
  upsertSql,
  type MbpTableDescriptor,
  type RdbDatabase,
  type RdbErrorCode,
  type RdbMigration,
} from '@ling2/ling-rdb'
import type { Context } from '@ling2/ling-cordis'

// ① 值面符号齐全
const _values: unknown[] = [
  RdbDatabaseRegistry,
  RdbError,
  migrateRdb,
  numberedPlaceholders,
  adaptUpsertText,
  upsertSql,
  buildRdbListQuery,
  RDB_AUDIT_COLUMNS,
  BaseMapper,
  defineTable,
  toSqlDateTime,
  rdbDatabaseServiceKey,
]

// ② 类型面出口
const _iface = (
  _code: RdbErrorCode,
  _db: RdbDatabase,
  _mig: RdbMigration,
  _spec: MbpTableDescriptor,
): void => {}

// ③ default 导出（service 类）
const _default: unknown = Rdb

// ④ 模块增强可见性：ctx.rdb 随包 d.ts 出现在 Context 上
declare const ctx: Context
const _hub: Rdb = ctx.rdb
const _registry: RdbDatabaseRegistry = _hub.database

void _values
void _iface
void _default
void _hub
void _registry
