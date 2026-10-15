/**
 * 金仓 KingbaseES / PostgreSQL 方言：wire 协议与 PG 兼容，适配器复用
 * PostgresAdapter；编译器子类只改两处——占位符出口统一为 `?`（编号
 * `$n` 翻译归 provider，kit/placeholders），标识符不引用（Ling
 * 表名列名全小写下划线/含 `base_Role_relation` 混大小写，未引用形态由
 * 服务端折叠到存储形态，与 Ling 手写 SQL 行为一致）。
 * @module @ling2/ling-rdb/orm/dialects/kingbase
 */
import { DefaultQueryCompiler, PostgresAdapter } from 'kysely'
import type { DatabaseIntrospector, Dialect, Kysely } from 'kysely'
import type { OnDuplicateKeyNode } from 'kysely'
import { RdbKyselyDriver } from '../driver.ts'
import { unsupportedIntrospector } from './stub.ts'
import type { RdbDatabase } from '../../hub/types.ts'

/**
 * 金仓/PG 族编译器：`?` 占位符 + 未引用标识符 + `LIMIT n OFFSET m`
 * （PG/KES 原生支持该形态）。
 */
export class KingbaseQueryCompiler extends DefaultQueryCompiler {
  override getCurrentParameterPlaceholder(): string {
    return '?'
  }

  override getLeftIdentifierWrapper(): string {
    return ''
  }

  override getRightIdentifierWrapper(): string {
    return ''
  }

  /**
   * MySQL 专有 upsert 节点 fail loud（Kysely 基类编译恒为
   * `on duplicate key update`——PG 上必炸的静默雷，波次 4.4 钉）：改用
   * onConflict 原生节点（冲突锚显式）或 rdb 结构化 upsertSql / 文本
   * adaptUpsertText 收敛层。
   */
  override visitOnDuplicateKey(_node: OnDuplicateKeyNode): void {
    throw new Error(
      'ling-rdb/orm: onDuplicateKeyUpdate() 是 MySQL 专有语法（PG/KES 无此形态）——'
      + '请改用 onConflict(...) 原生节点（冲突锚显式声明），'
      + '或走 ling-rdb 的结构化 upsertSql / 文本 adaptUpsertText 收敛层',
    )
  }
}

/**
 * 组装跑在 RdbDatabase 上的金仓/PG 方言。
 * @param database - 目标数据库外观（dialect 为 'kingbase' 或 'postgresql'）。
 * @returns Kysely Dialect。
 */
export function kingbaseRdbDialect(database: RdbDatabase): Dialect {
  return {
    createDriver: () => new RdbKyselyDriver(database),
    createQueryCompiler: () => new KingbaseQueryCompiler(),
    createAdapter: () => new PostgresAdapter(),
    createIntrospector: (_db: Kysely<any>): DatabaseIntrospector => unsupportedIntrospector('kingbase/postgresql'),
  }
}
