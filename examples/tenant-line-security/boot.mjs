// 自含示例：租户过滤的 SQL 注入防线（README「SQL-injection defenses」与
// 「Unsupported shapes」两节的可跑形态）——敌意租户值参数化、词法掩码、
// 多语句/UNION 守卫、规则标识符包装期校验、左词边界。
// 消费者视角换包名 import 即同款：import { wrapTenantLineDatabase, runWithTenantLine } from '@ling2/ling-rdb'
import { runWithTenantLine, wrapTenantLineDatabase } from '../../src/index.ts'

function fakeDatabase() {
  const calls = []
  return {
    name: 'sec', dialect: 'postgresql', identity: 'sec:memory', calls,
    async query(sql, params = []) { calls.push({ sql, params }); return { sql, params } },
    async execute(sql, params = []) { calls.push({ sql, params }); return { sql, params, affectedRows: 1, insertId: 0 } },
    async withConnection(work) { return work({ query: (s, p) => this.query(s, p) }) },
    async transaction(work) { return work({ query: (s, p) => this.query(s, p) }) },
    async close() {},
  }
}

const raw = fakeDatabase()
const tenantDb = wrapTenantLineDatabase(raw, { column: 'f_tenant_id', tables: ['demo_item', 'demo_mirror'] })

// ── ① 敌意租户值全程参数化：payload 只落 params，永不进 SQL 文本 ──
const payload = "'; DROP TABLE demo_item; --"
await runWithTenantLine({ tenantId: payload, filter: true }, () =>
  tenantDb.query('SELECT * FROM demo_item'))
const injected = raw.calls.at(-1)
if (!injected.sql.includes('f_tenant_id = ?')) throw new Error('注入谓词应参数位形态')
if (injected.sql.includes('DROP TABLE')) throw new Error('敌意串不得进入 SQL 文本')
if (injected.params.at(-1) !== payload) throw new Error('敌意串应原样进参数')

// ── ② 词法掩码：字符串字面量内的分号不触发多语句守卫；注释内伪装谓词
//      不参与定位与换值（真实 WHERE 尾照常注入一次）──
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  tenantDb.query("SELECT * FROM demo_item WHERE note = 'a;b' -- f_tenant_id = ?"))
const masked = raw.calls.at(-1)
if (masked.params.filter(v => v === '000000').length !== 1) {
  throw new Error('应恰好注入一次: ' + JSON.stringify(masked))
}

// ── ③ 多语句 fail loud：顶层分号直接抛错（一次调用一条语句）──
let threw = false
try {
  await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
    tenantDb.query('SELECT * FROM demo_item; DROP TABLE demo_item'))
} catch { threw = true }
if (!threw) throw new Error('多语句应 fail loud')

// ── ④ UNION 守卫：第二段涉「未获注入的受控表」抛错；非受控第二段放行（仅首段注入）──
threw = false
try {
  await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
    tenantDb.query('SELECT f_id FROM demo_item UNION SELECT f_id FROM demo_mirror'))
} catch { threw = true }
if (!threw) throw new Error('UNION 第二段未注入受控表应 fail loud')

await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  tenantDb.query('SELECT f_id, f_name FROM demo_item UNION SELECT f_id, f_name FROM classroom'))
const unionOk = raw.calls.at(-1)
if (unionOk.params.filter(v => v === '000000').length !== 1) throw new Error('非受控第二段应只注首段')

// ── ⑤ 规则标识符校验：敌意配置包装期抛错（列/表名只收标识符形态）──
for (const hostile of [
  { column: 'f_tenant id', tables: ['demo_item'] },   // 空格
  { column: 'tenant;drop', tables: ['demo_item'] },   // 元字符
  { column: 'f_tenant_id', tables: ['demo_item;drop'] },
]) {
  let wrapThrew = false
  try { wrapTenantLineDatabase(raw, hostile) } catch { wrapThrew = true }
  if (!wrapThrew) throw new Error(`敌意规则应包装期抛错: ${JSON.stringify(hostile)}`)
}

// ── ⑥ 左词边界：tenant_id 规则不咬 f_tenant_id（手写谓词照常透传，
//      受控表缺真谓词照常注入）──
const edgeRaw = fakeDatabase()
const edgeDb = wrapTenantLineDatabase(edgeRaw, { column: 'tenant_id', tables: ['demo_edge'] })
await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
  edgeDb.query('SELECT * FROM demo_edge WHERE f_tenant_id = ?', ['raw-value']))
const edge = edgeRaw.calls.at(-1)
if (!edge.sql.includes('f_tenant_id = ?')) throw new Error('近名列不应被误改写')
if (!edge.sql.includes('tenant_id = ?')) throw new Error('真谓词应照常注入')
if (JSON.stringify(edge.params) !== JSON.stringify(['raw-value', '000000'])) {
  throw new Error('边界用例参数不符: ' + JSON.stringify(edge.params))
}

console.log('tenant-line-security OK：参数化/词法掩码/多语句/UNION/标识符校验/词边界全链通过')
