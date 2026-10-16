// 自含示例：migrateRdb 版本化 DDL 迁移器（README「Migrations」节的可跑形态）。
// 有状态假库捕获 DDL 并模拟版本簿记——真实数据库上语句形态一致。
// 消费者视角换包名 import 即同款：import { migrateRdb } from '@ling2/ling-rdb'
import { migrateRdb } from '../../src/index.ts'

// 迁移受 IS_INIT_DB 总开关闸（缺省 false=跳过一切初始化任务）——示例显式打开
process.env.IS_INIT_DB = 'true'

const VERSION_TABLE = 'demo_schema_version'

/** 有状态假库：捕获 DDL；版本表 SELECT 回放已应用集 / INSERT 记版本。 */
function migrationDatabase(dialect) {
  const applied = []
  const ddl = []
  const exec = {
    async query(sql, params = []) {
      if (sql.startsWith('SELECT version FROM')) return applied.map(version => ({ version }))
      if (sql.includes(`INSERT INTO ${VERSION_TABLE}`)) applied.push(Number(params[0]))
      else if (!sql.startsWith('SELECT')) ddl.push(sql)
      return []
    },
    async execute(sql, params = []) { return exec.query(sql, params) },
    async beginTransaction() {}, async commit() {}, async rollback() {},
  }
  return {
    name: 'demo', dialect, identity: `demo:memory:${dialect}`, ddl,
    query: (sql, params) => exec.query(sql, params),
    execute: (sql, params) => exec.execute(sql, params),
    withConnection: work => work(exec),
    transaction: work => work(exec),
    close: async () => {},
  }
}

// 方言分派组链：mysql 与 postgresql 各自专属 DDL（列中文注释的双方言纪律——
// MySQL 走列内 COMMENT，PG 走 COMMENT ON 语句，运行器按所连库方言选支，缺支 fail loud）
const migrations = [
  {
    version: 1,
    statements: [{
      mysql: ["CREATE TABLE demo_portal (f_id VARCHAR(36) NOT NULL PRIMARY KEY, f_full_name VARCHAR(200) NULL COMMENT '门户名')"],
      postgresql: [
        'CREATE TABLE demo_portal (f_id VARCHAR(36) NOT NULL PRIMARY KEY, f_full_name VARCHAR(200) NULL)',
        "COMMENT ON COLUMN demo_portal.f_full_name IS '门户名'",
      ],
    }],
  },
  {
    version: 2,
    statements: [{
      mysql: ['ALTER TABLE demo_portal ADD COLUMN f_sort_code INT NULL'],
      postgresql: ['ALTER TABLE demo_portal ADD COLUMN f_sort_code INT NULL'],
    }],
  },
]

const db = migrationDatabase('postgresql')
await migrateRdb(db, { table: VERSION_TABLE, migrations })

// 首轮：簿记表 CREATE（1）+ v1 postgresql 支（2 条）+ v2（1 条）= 4 条 DDL
if (db.ddl.length !== 4) throw new Error(`首轮应应用 4 条语句，实得 ${db.ddl.length}`)
if (!db.ddl[0].includes(`CREATE TABLE IF NOT EXISTS ${VERSION_TABLE}`)) throw new Error('簿记表应最先创建')
if (!db.ddl.some(sql => sql.includes('COMMENT ON COLUMN'))) throw new Error('应选中 postgresql 方言支')
if (db.ddl.some(sql => sql.includes("COMMENT '门户名'"))) throw new Error('mysql 支不应被执行')
if (!db.ddl.some(sql => sql.includes('ADD COLUMN f_sort_code'))) throw new Error('v2 应按版本序应用')

// 幂等重放：簿记表 CREATE 恒执行，业务 DDL 零新增
const portalDdl = () => db.ddl.filter(sql => sql.includes('demo_portal')).length
if (portalDdl() !== 3) throw new Error('首轮业务 DDL 应 3 条（建表+COMMENT+加列）')
await migrateRdb(db, { table: VERSION_TABLE, migrations })
if (db.ddl.length !== 5 || portalDdl() !== 3) throw new Error('重放应零新增业务 DDL（簿记幂等）')

console.log('migrations OK：4 条 DDL 按方言支应用一次，重放幂等')
