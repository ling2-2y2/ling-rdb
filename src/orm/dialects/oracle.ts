/**
 * Oracle / 达梦（DM）方言族：Oracle 12c+ 与 DM8 共用 `OFFSET n ROWS
 * FETCH NEXT m ROWS ONLY` 分页形态，达梦默认 Oracle 兼容方向。
 *
 * 两个机制位：
 * 1. **编译器**（OracleFamilyQueryCompiler）：占位符出口统一 `?`（编号
 *    `:n` 翻译归 provider）；标识符不引用——Ling 在 Oracle/达梦上的表
 *    由未引用 DDL 建成（服务端折叠为大写存储），未引用形态与 Ling 手写
 *    SQL（`getKey(table, dbType)` 的大写列名约定）行为一致。
 * 2. **查询节点插件**（OracleFamilyPlugin）：Kysely 基类编译顺序是
 *    `LIMIT … OFFSET …`，而 Oracle 族要求 OFFSET 先于 FETCH——插件在
 *    节点层把 `limit` 改写为 `fetch`（基类天然按 offset→fetch 顺序发
 *    射），不触碰编译器内部。
 * @module @ling2/ling-rdb/orm/dialects/oracle
 */
import { DefaultQueryCompiler, DialectAdapterBase } from 'kysely'
// kysely 0.29 起插件接口更名 KyselyPlugin（旧名 Plugin 不再导出）
import type { DatabaseIntrospector, Dialect, Kysely, KyselyPlugin } from 'kysely'
import type { RootOperationNode, SelectQueryNode } from 'kysely'
import { RdbKyselyDriver } from '../driver.ts'
import { unsupportedIntrospector } from './stub.ts'
import type { RdbDatabase } from '../../hub/types.ts'

/** Oracle/达梦族编译器：`?` 占位符 + 未引用标识符；分页由节点插件改写为 fetch。 */
export class OracleFamilyQueryCompiler extends DefaultQueryCompiler {
  override getCurrentParameterPlaceholder(): string {
    return '?'
  }

  override getLeftIdentifierWrapper(): string {
    return ''
  }

  override getRightIdentifierWrapper(): string {
    return ''
  }

  override visitOffset(node: { readonly offset: unknown }): void {
    // 基类形态 `offset <n>` 追加 `rows`，与后续 fetch 子句拼成 Oracle 族分页
    super.visitOffset(node as never)
    this.append(' rows')
  }
}

/**
 * 具象化适配器——基类 DialectAdapterBase 在类型层 abstract（运行时是普通
 * 类），空子类实例走全部默认实现，行为与直连基类一致。迁移锁两桩在本
 * ORM 不可达：建表/迁移走 ling-rdb migrateRdb 链，kysely migration 组件
 * 从未装配。
 */
class OracleFamilyAdapter extends DialectAdapterBase {
  acquireMigrationLock(): Promise<void> {
    return Promise.reject(new Error('ling-rdb/orm: kysely 迁移锁未支持——建表/迁移走 ling-rdb migrateRdb 链'))
  }

  releaseMigrationLock(): Promise<void> {
    return Promise.reject(new Error('ling-rdb/orm: kysely 迁移锁未支持——建表/迁移走 ling-rdb migrateRdb 链'))
  }
}

/**
 * 把 `limit` 查询节点改写为 `fetch`（modifier: only）——修正基类
 * limit→offset 的发射顺序为 Oracle 族要求的 offset→fetch。
 */
export class OracleFamilyPlugin implements KyselyPlugin {
  transformQuery(args: { readonly node: RootOperationNode; readonly queryId: unknown }): RootOperationNode {
    const { node } = args
    if (node.kind !== 'SelectQueryNode') return node
    const select = node as SelectQueryNode
    if (select.limit === undefined || select.fetch !== undefined) return node
    const limitValue = (select.limit as { readonly limit: unknown }).limit
    return {
      ...select,
      limit: undefined,
      fetch: { kind: 'FetchNode', rowCount: limitValue, modifier: 'only' },
    } as SelectQueryNode
  }

  transformResult<TR>(args: { readonly result: unknown; readonly queryId: unknown }): Promise<TR> {
    return Promise.resolve(args.result as TR)
  }
}

/**
 * 组装跑在 RdbDatabase 上的 Oracle 族方言。
 * @param database - 目标数据库外观（dialect 为 'oracle' 或 'dm'）。
 * @param family - 方言名（错误消息用）。
 * @returns Kysely Dialect。
 */
export function oracleFamilyRdbDialect(database: RdbDatabase, family: 'oracle' | 'dm'): Dialect {
  return {
    createDriver: () => new RdbKyselyDriver(database),
    createQueryCompiler: () => new OracleFamilyQueryCompiler(),
    createAdapter: () => new OracleFamilyAdapter(),
    createIntrospector: (_db: Kysely<any>): DatabaseIntrospector => unsupportedIntrospector(family),
  }
}
