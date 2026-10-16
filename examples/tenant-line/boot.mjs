// 自含示例：注入式租户过滤（README「Tenant line」节的可跑形态）——业务 SQL
// 零租户谓词，受控表谓词由拦截层在执行期编译注入；师生域双规则（非标准租户
// 列独立配置）+ 多表 JOIN + INSERT 自动补列 + fail loud 防线。
// 消费者视角换包名 import 即同款：import { ... } from '@ling2/ling-rdb'
import { ignoreTenantLine, runWithTenantLine, wrapTenantLineDatabase } from '../../src/index.ts'

/** 捕获型假库：拦截包装后语句在 query 出口被记录（sql/params 即编译产物）。 */
function fakeDatabase() {
  const calls = []
  return {
    name: 'school', dialect: 'postgresql', identity: 'school:memory', calls,
    async query(sql, params = []) { calls.push({ sql, params }); return { sql, params } },
    async execute(sql, params = []) { calls.push({ sql, params }); return { sql, params, affectedRows: 1, insertId: 0 } },
    async withConnection(work) { return work({ query: (s, p) => this.query(s, p), execute: (s, p) => this.execute(s, p) }) },
    async transaction(work) { return work({ query: (s, p) => this.query(s, p), execute: (s, p) => this.execute(s, p) }) },
    async close() {},
  }
}

const raw = fakeDatabase()
// 标准列受控表一条规则；非标准租户列的特殊表独立一条（列名自持）；
// 非受控表（classroom）不进任何清单 → 永不注入
const tenantDb = wrapTenantLineDatabase(raw, [
  { column: 'f_tenant_id', tables: ['demo_teacher', 'demo_student'] },
  { column: 'tenant_code', tables: ['demo_teacher_student'] },
])

// ── ① 零谓词注入：受控表顶层出现且未写谓词 → WHERE 尾自动追加 + 参数尾绑会话租户 ──
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  tenantDb.query('SELECT * FROM demo_teacher WHERE f_enabled_mark = 1'))
const single = raw.calls.at(-1)
if (!single.sql.includes('f_tenant_id = ?') || single.params.at(-1) !== '000000') {
  throw new Error('单表注入失败: ' + JSON.stringify(single))
}

// ── ② 师生域多表 JOIN：谓词按归属表判定（各自列名）──
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  tenantDb.query(
    'SELECT t.f_name, s.f_name AS student_name FROM demo_teacher t'
    + ' JOIN demo_teacher_student ts ON t.f_id = ts.f_teacher_id'
    + ' JOIN demo_student s ON s.f_id = ts.f_student_id'))
const joined = raw.calls.at(-1)
if (!joined.sql.includes('t.f_tenant_id = ?')) throw new Error('主表谓词应表名限定')
if (!joined.sql.includes('ts.tenant_code = ?')) throw new Error('关系表应按非标准列注入')
if (!joined.sql.includes('s.f_tenant_id = ?')) throw new Error('学生表谓词应按别名注入')
if (JSON.stringify(joined.params) !== JSON.stringify(['000000', '000000', '000000'])) {
  throw new Error('JOIN 注入参数序不符: ' + JSON.stringify(joined.params))
}

// ── ③ 非受控表永不被碰 ──
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  tenantDb.query('SELECT * FROM classroom WHERE f_id = ?', ['c-1']))
const untouched = raw.calls.at(-1)
if (untouched.sql.includes('tenant')) throw new Error('非受控表不应注入')
if (untouched.params[0] !== 'c-1') throw new Error('非受控表参数应透传')

// ── ④ INSERT 自动补租户列（列清单尾 + 每组绑值）──
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  tenantDb.execute('INSERT INTO demo_teacher (f_name) VALUES (?)', ['张三']))
const inserted = raw.calls.at(-1)
if (!inserted.sql.includes('f_name, f_tenant_id')) throw new Error('INSERT 应自动补租户列')
if (JSON.stringify(inserted.params) !== JSON.stringify(['张三', '000000'])) {
  throw new Error('INSERT 补列参数不符: ' + JSON.stringify(inserted.params))
}

// ── ⑤ 豁免两形态：adminBypass（filter:false）不注入；ignoreTenantLine 作用域不改写 ──
await runWithTenantLine({ tenantId: '000000', filter: false }, () =>
  tenantDb.query('SELECT * FROM demo_teacher WHERE f_tenant_id = ?', ['raw-any']))
if (raw.calls.at(-1).params[0] !== 'raw-any') throw new Error('adminBypass 应跨区不注入')

const ignored = await ignoreTenantLine(() =>
  tenantDb.query('SELECT * FROM demo_teacher WHERE f_tenant_id = ?', ['raw']))
if (ignored.params[0] !== 'raw') throw new Error('豁免作用域不应改写')

// ── ⑥ fail loud：无法保证过滤的形态直接抛错（绝不静默跳过 = 绝不租户泄漏）──
const hostile = [
  ['子查询', 'SELECT * FROM demo_teacher WHERE f_id IN (SELECT f_teacher_id FROM demo_teacher_student)'],
  ['CTE', 'WITH t AS (SELECT * FROM demo_teacher) SELECT * FROM t'],
  ['多语句', 'SELECT 1; SELECT 2'],
]
for (const [name, sqlText] of hostile) {
  let threw = false
  try {
    await runWithTenantLine({ tenantId: '000000', filter: true }, () => tenantDb.query(sqlText))
  } catch { threw = true }
  if (!threw) throw new Error(`${name} 应 fail loud`)
}

console.log('tenant-line OK：零谓词注入/师生域 JOIN/INSERT 补列/豁免两形态/fail loud 全链通过')
