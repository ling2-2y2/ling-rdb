/**
 * hub 与方言 kit 基础件 —— README「Registry / dialect kit / tenant value
 * rewrite」几章的可跑孪生件。一批纯函数与轻量语义快速过目：
 * 注册表、占位符翻译、结构化 upsert、声明式列表查询、租户值改写。
 *
 * 跑起来（无需真实数据库）：
 *   node --import tsx/esm examples/kit-basics/boot.mjs
 */
import {
  RdbDatabaseRegistry,
  buildRdbListQuery,
  numberedPlaceholders,
  runWithTenantLine,
  upsertSql,
  wrapTenantLineDatabase,
} from '../../src/index.ts'
import { show, step } from '../_lib/fake-db.mjs'

step('① 注册表：登记 → 服务键 → 按名解析（未知名 fail loud）')
const registry = new RdbDatabaseRegistry()
registry.register('demo', { dialect: 'postgresql' })
console.log(`  登记名：${registry.names().join('、')}；服务键派生规则 = rdb.database.<名字>（provider 行按它提供生命周期服务）`)

step('② 占位符翻译：统一 ? 出口 → PG 的 $n（纯函数，零连接）')
const ph = numberedPlaceholders('INSERT INTO demo_kv VALUES (?, ?)', 'postgres')
show('翻译产物：', { sql: ph })

step('③ 结构化 upsert 渲染：声明列/冲突键/更新列，方言各自渲染 ON CONFLICT / ON DUPLICATE')
const rendered = upsertSql('postgresql', {
  table: 'demo_kv',
  columns: [
    { name: 'k', value: "'a'" },
    { name: 'v', value: '1' },
  ],
  conflictKeys: ['k'],
  updates: [{ column: 'v' }],
})
show('PG 渲染产物：', { sql: rendered })

step('④ 声明式分页列表查询：条件/排序/分页声明一次，语句生成')
const list = buildRdbListQuery({
  table: 'demo_kv',
  columns: ['k', 'v'],
  conditions: [{ kind: 'eq', column: 'k', value: 'a' }],
  order: ['k'],
  paging: { pageSize: 10 },
})
show('列表查询语句：', { sql: list.sql, params: list.params })

step('⑤ 租户值改写：受控表手写谓词的绑定值，执行期换成会话租户')
const tenantDb = wrapTenantLineDatabase(
  { name: 'demo', dialect: 'postgresql', query: async (sql, params) => ({ sql, params }) },
  { column: 'f_tenant_id', tables: ['base_user'] },
)
const captured = await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  tenantDb.query('SELECT * FROM base_user WHERE f_tenant_id = ?', ['whatever']))
show('业务绑的是 "whatever"，执行时被换成会话租户：', { sql: captured.sql, params: captured.params })

console.log('\nkit-basics 完成 ✓')
