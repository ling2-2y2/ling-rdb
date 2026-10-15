const escapeRegExp = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// ① esc 语义：字面量内无 ?，只有 f_tenant_id 的一个 ?
const escSql = "SELECT * FROM users WHERE name = 'a''; DROP TABLE users --' AND f_tenant_id = ?"
const p1 = new RegExp(`(?:(?:\\w+)\\.)?\\b${escapeRegExp('f_tenant_id')}\\s*=\\s*\\?`, 'gi')
console.log('① esc matches:', [...escSql.matchAll(p1)].map(m => m.index))
// ② 左词边界：规则列 tenant_id，语句含 f_tenant_id 与 tenant_id
const p2 = new RegExp(`(?:(?:\\w+)\\.)?\\b${escapeRegExp('tenant_id')}\\s*=\\s*\\?`, 'gi')
const biteSql = 'SELECT * FROM users WHERE f_tenant_id = ? AND tenant_id = ?'
console.log('② tenant_id matches:', [...biteSql.matchAll(p2)].map(m => [m.index, m[0].slice(0, 16)]))
// ③ 限定列转义
const p3 = new RegExp(`(?:(?:\\w+)\\.)?\\b${escapeRegExp('pay.tenant_id')}\\s*=\\s*\\?`, 'gi')
console.log('③ pay.tenant_id pattern:', p3.source)
