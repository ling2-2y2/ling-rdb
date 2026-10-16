/**
 * 版本化 DDL 迁移器 migrateRdb —— README「Migrations」一章的可跑孪生件。
 *
 * 一条 entry 一条 SQL；每个版本给「方言分派组」——MySQL 与 PostgreSQL 各自
 * 专属 DDL，运行器按所连库方言选支（缺支 fail loud）。版本簿记表自动建，
 * 应用过的版本不再重放（幂等）。
 *
 * 跑起来（无需真实数据库，DDL 由 examples/_lib 假库捕获并打印）：
 *   node --import tsx/esm examples/migrations/boot.mjs
 */
import { migrateRdb } from '../../src/index.ts'
import { fakeDatabase, show, step } from '../_lib/fake-db.mjs'

// 迁移受 IS_INIT_DB 总开关闸（缺省 false = 跳过一切初始化任务）——示例显式打开
process.env.IS_INIT_DB = 'true'

const VERSION_TABLE = 'demo_schema_version'

// 方言分派组：中文列注释双方言纪律——MySQL 走列内 COMMENT，
// PostgreSQL 走 COMMENT ON 语句。两个方言支内容等价，选哪个看所连的库。
const migrations = [
  {
    version: 1,
    statements: [{
      mysql: [
        `CREATE TABLE demo_portal (
           f_id        VARCHAR(36) NOT NULL PRIMARY KEY,
           f_full_name VARCHAR(200) NULL COMMENT '门户名'
         )`,
      ],
      postgresql: [
        `CREATE TABLE demo_portal (
           f_id        VARCHAR(36) NOT NULL PRIMARY KEY,
           f_full_name VARCHAR(200) NULL
         )`,
        `COMMENT ON COLUMN demo_portal.f_full_name IS '门户名'`,
      ],
    }],
  },
  {
    version: 2,
    statements: [{
      mysql:     ['ALTER TABLE demo_portal ADD COLUMN f_sort_code INT NULL'],
      postgresql: ['ALTER TABLE demo_portal ADD COLUMN f_sort_code INT NULL'],
    }],
  },
]

// 假库挂一个簿记钩子，模拟版本表：SELECT 回放已应用集，INSERT 记新版本——
// 真实库上这两条就是普通的 SELECT/INSERT，落在 VERSION_TABLE 里。
const applied = []
const db = fakeDatabase('demo', 'postgresql', (sqlText, params) => {
  if (sqlText.startsWith('SELECT version FROM')) return applied.map(version => ({ version }))
  if (sqlText.includes(`INSERT INTO ${VERSION_TABLE}`)) applied.push(Number(params[0]))
  return undefined
})

step('① 首轮迁移：先建簿记表，再按版本序应用 PG 方言支')
await migrateRdb(db, { table: VERSION_TABLE, migrations })
const ddlOf = calls => calls.filter(call => /^(CREATE|ALTER|COMMENT)/i.test(call.sql.trim()))
console.log(`  共执行 ${ddlOf(db.calls).length} 条 DDL（含簿记表幂等建表）：`)
for (const call of ddlOf(db.calls)) show(null, call)

step('② 幂等重放：已应用版本直接跳过（业务 DDL 零新增）')
const before = ddlOf(db.calls).length
await migrateRdb(db, { table: VERSION_TABLE, migrations })
const after = ddlOf(db.calls).length
console.log(`  第二轮 DDL 条数 ${before} → ${after}（簿记表 CREATE 幂等重执行，业务 DDL 零条）`)

console.log('\nmigrations 完成 ✓')
