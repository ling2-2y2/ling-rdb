/**
 * 注入式租户过滤（tenant line）—— README「Tenant line」一章的可跑孪生件。
 *
 * 业务 SQL 零租户谓词：受控表（规则清单里的表）的租户过滤由拦截层在执行期
 * 编译注入——读补 WHERE、INSERT 补列、JOIN 按别名归属判定。没法保证过滤的
 * 形态（子查询/CTE/多语句）直接抛错，绝不静默跳过。
 *
 * 跑起来（无需真实数据库，注入后的语句由 examples/_lib 假库捕获并打印）：
 *   node --import tsx/esm examples/tenant-line/boot.mjs
 */
import { ignoreTenantLine, runWithTenantLine, wrapTenantLineDatabase } from '../../src/index.ts'
import { fakeDatabase, lastCall, show, step } from '../_lib/fake-db.mjs'

const raw = fakeDatabase('school', 'postgresql')

// 规则：标准租户列的表一条；非标准租户列的特殊表独立一条（列名自持）；
// 不进任何清单的表（classroom）永不注入。
const tenantDb = wrapTenantLineDatabase(raw, [
  { column: 'f_tenant_id', tables: ['demo_teacher', 'demo_student'] },
  { column: 'tenant_code', tables: ['demo_teacher_student'] },
])

step('① 零谓词注入：业务 SQL 不写租户，WHERE 尾自动补 + 参数尾绑会话租户')
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  tenantDb.query('SELECT * FROM demo_teacher WHERE f_enabled_mark = 1'))
show('业务写的是「SELECT * FROM demo_teacher WHERE f_enabled_mark = 1」，执行时变成：',
  lastCall(raw, 'demo_teacher'))

step('② 师生域多表 JOIN：谓词按归属表判定（各自列名、各自别名）')
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  tenantDb.query(
    'SELECT t.f_name, s.f_name AS student_name FROM demo_teacher t'
    + ' JOIN demo_teacher_student ts ON t.f_id = ts.f_teacher_id'
    + ' JOIN demo_student s ON s.f_id = ts.f_student_id'))
show('三张受控表三条谓词，全按别名限定：', lastCall(raw, 'JOIN'))

step('③ 非受控表永不被碰')
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  tenantDb.query('SELECT * FROM classroom WHERE f_id = ?', ['c-1']))
show('classroom 不在规则清单里，语句原样透传：', lastCall(raw, 'classroom'))

step('④ INSERT 自动补租户列（列清单尾 + 每组绑值）')
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  tenantDb.execute('INSERT INTO demo_teacher (f_name) VALUES (?)', ['张三']))
show('业务只写 f_name，落库时多了 f_tenant_id：', lastCall(raw, 'INSERT'))

step('⑤ 豁免两形态：adminBypass（filter: false）与 ignoreTenantLine 作用域')
await runWithTenantLine({ tenantId: '000000', filter: false }, () =>
  tenantDb.query('SELECT * FROM demo_teacher WHERE f_tenant_id = ?', ['raw-any']))
show('filter: false——管理旁路，绑定值原样透传：', lastCall(raw, 'demo_teacher'))

const ignored = await ignoreTenantLine(() =>
  tenantDb.query('SELECT * FROM demo_teacher WHERE f_tenant_id = ?', ['raw']))
show('ignoreTenantLine 作用域内同样不改写：', { sql: ignored.sql, params: ignored.params })

step('⑥ fail loud：无法保证过滤的形态直接抛错（绝不租户泄漏）')
for (const [name, sqlText] of [
  ['子查询', 'SELECT * FROM demo_teacher WHERE f_id IN (SELECT f_teacher_id FROM demo_teacher_student)'],
  ['CTE', 'WITH t AS (SELECT * FROM demo_teacher) SELECT * FROM t'],
  ['多语句', 'SELECT 1; SELECT 2'],
]) {
  try {
    await runWithTenantLine({ tenantId: '000000', filter: true }, () => tenantDb.query(sqlText))
  } catch (error) {
    console.log(`  ${name} → 拒绝：${error.message}`)
  }
}

console.log('\ntenant-line 完成 ✓')
