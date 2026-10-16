/**
 * 租户过滤的 SQL 注入防线 —— README「SQL-injection defenses」与
 * 「Unsupported shapes」两章的可跑孪生件。
 *
 * 会话租户值是外部输入，可能藏着敌意串。拦截层四道防线：敌意值全程参数化、
 * 词法掩码（字符串/注释内的伪装谓词不参与定位）、多语句与 UNION 守卫、
 * 规则标识符包装期校验。
 *
 * 跑起来（无需真实数据库，语句由 examples/_lib 假库捕获并打印）：
 *   node --import tsx/esm examples/tenant-line-security/boot.mjs
 */
import { runWithTenantLine, wrapTenantLineDatabase } from '../../src/index.ts'
import { fakeDatabase, lastCall, show, step } from '../_lib/fake-db.mjs'

const raw = fakeDatabase('sec', 'postgresql')
const tenantDb = wrapTenantLineDatabase(raw, { column: 'f_tenant_id', tables: ['demo_item', 'demo_mirror'] })

step('① 敌意租户值全程参数化：payload 只落 params，永不进 SQL 文本')
const payload = "'; DROP TABLE demo_item; --"
await runWithTenantLine({ tenantId: payload, filter: true }, () =>
  tenantDb.query('SELECT * FROM demo_item'))
show('租户值就是上面这串敌意串，看落点：', lastCall(raw, 'demo_item'))

step('② 词法掩码：字符串里的分号不算多语句；注释里的伪装谓词不参与换值')
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  tenantDb.query("SELECT * FROM demo_item WHERE note = 'a;b' -- f_tenant_id = ?"))
show('a;b 的分号没触发多语句守卫；注释里的 f_tenant_id = ? 没被当成真谓词（照常补注入）：',
  lastCall(raw, 'demo_item'))

step('③ 多语句守卫：顶层分号直接抛错（一次调用一条语句）')
try {
  await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
    tenantDb.query('SELECT * FROM demo_item; DROP TABLE demo_item'))
} catch (error) {
  console.log(`  拒绝：${error.message}`)
}

step('④ UNION 守卫：第二段涉「未获注入的受控表」抛错；非受控第二段放行')
try {
  await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
    tenantDb.query('SELECT f_id FROM demo_item UNION SELECT f_id FROM demo_mirror'))
} catch (error) {
  console.log(`  demo_mirror 第二段没机会注入 → 拒绝：${error.message}`)
}
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  tenantDb.query('SELECT f_id, f_name FROM demo_item UNION SELECT f_id, f_name FROM classroom'))
show('第二段是非受控表 classroom → 放行，只给首段注入：', lastCall(raw, 'UNION'))

step('⑤ 规则标识符校验：敌意配置在包装期就抛错（列/表名只收标识符形态）')
for (const hostile of [
  { column: 'f_tenant id', tables: ['demo_item'] },   // 空格
  { column: 'tenant;drop', tables: ['demo_item'] },   // 元字符
  { column: 'f_tenant_id', tables: ['demo_item;drop'] },
]) {
  try {
    wrapTenantLineDatabase(raw, hostile)
  } catch (error) {
    console.log(`  规则 ${JSON.stringify(hostile.column)}/${JSON.stringify(hostile.tables[0])} → 拒绝：${error.message}`)
  }
}

step('⑥ 左词边界：tenant_id 规则不误咬 f_tenant_id')
const edgeRaw = fakeDatabase('sec', 'postgresql')
const edgeDb = wrapTenantLineDatabase(edgeRaw, { column: 'tenant_id', tables: ['demo_edge'] })
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  edgeDb.query('SELECT * FROM demo_edge WHERE f_tenant_id = ?', ['raw-value']))
show('手写的 f_tenant_id 谓词原样透传，真谓词 tenant_id 照常补注入：', lastCall(edgeRaw, 'demo_edge'))

console.log('\ntenant-line-security 完成 ✓')
