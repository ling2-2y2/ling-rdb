// 自含示例：hub 注册表 + 方言 kit 纯函数一轮后退出（pnpm smoke）。
// 消费者视角换包名 import 即同款：import { ... } from '@ling2/ling-rdb'
import {
  RdbDatabaseRegistry,
  RdbError,
  buildRdbListQuery,
  ignoreTenantLine,
  numberedPlaceholders,
  rdbDatabaseServiceKey,
  runWithTenantLine,
  upsertSql,
  wrapTenantLineDatabase,
} from '../../src/index.ts'

// ① 注册表语义：登记/派生 key/未知名 fail loud
const registry = new RdbDatabaseRegistry()
registry.register('demo', { dialect: 'postgresql' })
if (rdbDatabaseServiceKey('demo') !== 'rdb.database.demo') throw new Error('service key 派生失败')
registry.names().includes('demo') || (() => { throw new Error('登记丢失') })()

// ② 方言 kit：占位符翻译（? → $n）与结构化 upsert 渲染（纯函数，零连接）
const ph = numberedPlaceholders('INSERT INTO demo_kv VALUES (?, ?)', 'postgres')
if (ph !== 'INSERT INTO demo_kv VALUES ($1, $2)') throw new Error('PG 占位符翻译失败')
const rendered = upsertSql('postgresql', {
  table: 'demo_kv',
  columns: [
    { name: 'k', value: "'a'" },
    { name: 'v', value: '1' },
  ],
  conflictKeys: ['k'],
  updates: [{ column: 'v' }],
})
if (!rendered.includes('ON CONFLICT')) throw new Error('PG upsert 渲染失败')

// ③ 声明式分页列表查询
const list = buildRdbListQuery({
  table: 'demo_kv',
  columns: ['k', 'v'],
  conditions: [{ kind: 'eq', column: 'k', value: 'a' }],
  order: ['k'],
  paging: { pageSize: 10 },
})
if (!list.sql.toLowerCase().includes('select')) throw new Error('列表查询渲染失败')

// ④ 未知名 fail loud
try {
  registry.get('nope')
  throw new Error('未知名应 fail loud')
} catch (e) {
  if (!(e instanceof RdbError)) throw e
}

// ⑤ 租户行拦截（README「租户拦截」示例的可跑形态）：
//    受控表 `列 = ?` 谓词绑定值在执行期改写为会话租户；豁免作用域内不改写。
const rule = { column: 'f_tenant_id', tables: ['base_user'] }
const tenantDb = wrapTenantLineDatabase(
  { name: 'demo', dialect: 'postgresql', query: async (sql, params) => ({ sql, params }) },
  rule,
)
const captured = await runWithTenantLine({ tenantId: '000000', filter: true }, async () =>
  tenantDb.query('SELECT * FROM base_user WHERE f_tenant_id = ?', ['whatever']))
if (captured.params[0] !== '000000') throw new Error('租户绑定值改写失败')
const ignored = await ignoreTenantLine(() =>
  tenantDb.query('SELECT * FROM base_user WHERE f_tenant_id = ?', ['raw']))
if (ignored.params[0] !== 'raw') throw new Error('豁免作用域不应改写')

// ⑥ 多表 JOIN：别名谓词按归属表判定——受控表改写、非受控表透传、裸列归主表
const joined = await runWithTenantLine({ tenantId: '000000', filter: true }, async () =>
  tenantDb.query(
    'SELECT u.*, d.f_name FROM base_user u JOIN base_dept d' +
    ' ON u.f_dept_id = d.f_id WHERE u.f_tenant_id = ? AND d.f_tenant_id = ? AND f_tenant_id = ?',
    ['raw_u', 'raw_d', 'raw_bare']))
if (JSON.stringify(joined.params) !== JSON.stringify(['000000', 'raw_d', '000000'])) {
  throw new Error('JOIN 租户改写失败: ' + JSON.stringify(joined.params))
}

console.log('smoke OK')
