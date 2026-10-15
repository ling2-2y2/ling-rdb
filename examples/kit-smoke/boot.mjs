// 自含示例：hub 注册表 + 方言 kit 纯函数一轮后退出（pnpm smoke）。
// 消费者视角换包名 import 即同款：import { ... } from '@ling2/ling-rdb'
import {
  RdbDatabaseRegistry,
  RdbError,
  buildRdbListQuery,
  numberedPlaceholders,
  rdbDatabaseServiceKey,
  upsertSql,
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

console.log('smoke OK')
