/**
 * SQL 注入防线测试（用户令「添加防 sql 注入测试用例并实现」）：
 * ①租户值全程参数化（载荷永不进 SQL 文本）；②词法级掩码（引号转义/行注释/
 * 块注释内的伪装谓词不参与定位与换值——注释内 `?` 非真占位符，执行序号跳
 * 过）；③多语句文本 fail loud；④UNION 第二 SELECT 涉受控表 fail loud；
 * ⑤规则标识符校验（词边界+元字符转义+敌意配置 fail loud）。
 */
import { describe, expect, it } from 'vitest'
import {
  injectInsertTenantColumn,
  injectTenantLinePredicates,
  rewriteTenantLineParams,
  runWithTenantLine,
  wrapTenantLineDatabase,
} from '../src/kit/tenant-line.ts'

const RULE = { column: 'f_tenant_id', tables: ['users', 'orders'] }
const inj = (sql: string, params: readonly unknown[] = [], tenantId = '000000') =>
  injectTenantLinePredicates(sql, params, RULE, tenantId)
const rw = (sql: string, params: readonly unknown[], tenantId = '000000') =>
  rewriteTenantLineParams(sql, params, RULE, tenantId)

describe('租户值参数化（载荷永不入 SQL 文本）', () => {
  const EVIL = "'; DROP TABLE users; --"

  it('SELECT 注入路径：载荷只出现在参数组尾部', () => {
    const r = inj('SELECT * FROM users WHERE name = ?', ['n'], EVIL)
    expect(r.sql).toBe('SELECT * FROM users WHERE name = ? AND f_tenant_id = ?')
    expect(r.sql).not.toContain('DROP')
    expect(r.sql).not.toContain(';')
    expect(r.params).toEqual(['n', EVIL])
  })

  it('INSERT 自动补列路径：载荷只出现在参数组尾部', () => {
    const r = injectInsertTenantColumn('INSERT INTO users(id, name) VALUES (?, ?)', [1, 'n'], RULE, EVIL)
    expect(r.sql).toBe('INSERT INTO users(id, name, f_tenant_id) VALUES (?, ?, ?)')
    expect(r.sql).not.toContain('DROP')
    expect(r.params).toEqual([1, 'n', EVIL])
  })

  it('换值路径：载荷经参数绑定（不进文本）', () => {
    const r = rw('SELECT * FROM users WHERE f_tenant_id = ?', ['orig'], EVIL)
    expect(r).toEqual([EVIL])
  })
})

describe('词法级掩码（注释/转义引号内的伪装内容不参与判定）', () => {
  it('行注释内伪装谓词不计数 → 执行序号跳过（真谓词=注释后首个存活占位符）', () => {
    // 注释内的 `?` 不是真占位符：执行序号只数掩码后存活的 `?`
    const r = rw(
      'SELECT * FROM users WHERE name = ? -- f_tenant_id = ?\n AND f_tenant_id = ?',
      ['n', 'w'],
    )
    expect(r).toEqual(['n', '000000'])
  })

  it('块注释内伪装谓词不参与换值（真谓词=唯一存活占位符）', () => {
    const r = rw(
      'SELECT * FROM users /* f_tenant_id = ? */ WHERE f_tenant_id = ?',
      ['w'],
    )
    expect(r).toEqual(['000000'])
  })

  it("转义引号（'' 逃逸）内的分号与伪注释不破坏掩码", async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
    const wrapped = wrapTenantLineDatabase({
      name: 'fake', dialect: 'mysql', identity: 'x',
      query: async (sql, params) => { calls.push({ sql, params }); return [] },
      execute: async () => ({ affectedRows: 0, insertId: 0 }),
      withConnection: async work => work({} as never),
      transaction: async work => work({} as never),
      close: async () => {},
    }, RULE)
    await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
      wrapped.query("SELECT * FROM users WHERE name = 'a''; DROP TABLE users --' AND f_tenant_id = ?", ['w']))
    // 字面量内的分号/DROP/-- 全被掩码（不破坏语句），真谓词正常换值
    expect(calls[0]!.sql).toBe(
      "SELECT * FROM users WHERE name = 'a''; DROP TABLE users --' AND f_tenant_id = ?",
    )
    expect(calls[0]!.params).toEqual(['000000'])
  })

  it('注入插入点不落进注释：块注释后的 WHERE 尾正常追加', () => {
    const r = inj('SELECT * FROM users /* note */ WHERE age > 18')
    expect(r.sql).toBe('SELECT * FROM users /* note */ WHERE age > 18 AND f_tenant_id = ?')
    expect(r.params).toEqual(['000000'])
  })
})

describe('多语句 fail loud', () => {
  it('SELECT;DROP 组合 → 抛错', () => {
    expect(() => inj('SELECT * FROM users; DROP TABLE users')).toThrow(/多语句/)
  })
  it('换值路径同样拒绝多语句', () => {
    expect(() => rw('UPDATE users SET n = ?; DELETE FROM users', ['x'])).toThrow(/多语句/)
  })
  it('字符串字面量内的分号不算多语句（放行）', () => {
    const r = inj("SELECT * FROM users WHERE name = 'a;b;c'")
    expect(r.sql).toBe("SELECT * FROM users WHERE name = 'a;b;c' AND f_tenant_id = ?")
  })
})

describe('UNION 防线', () => {
  it('UNION 第二 SELECT 涉受控表 → fail loud（第二段无法注入）', () => {
    expect(() => inj('SELECT * FROM users UNION SELECT * FROM orders')).toThrow(/tenant-line/)
  })
  it('UNION 第二段非受控表 → 仅第一段注入', () => {
    const r = inj('SELECT * FROM users UNION SELECT f_id FROM audit_log')
    expect(r.sql).toBe('SELECT * FROM users WHERE f_tenant_id = ? UNION SELECT f_id FROM audit_log')
    expect(r.params).toEqual(['000000'])
  })
})

describe('规则标识符的精确匹配（词边界+元字符转义+校验）', () => {
  it('规则列 tenant_id 不误咬 f_tenant_id（左词边界）', () => {
    const r = rewriteTenantLineParams(
      'SELECT * FROM users WHERE f_tenant_id = ? AND tenant_id = ?',
      ['a', 'b'],
      { column: 'tenant_id', tables: ['users'] },
      '000000',
    )
    expect(r).toEqual(['a', '000000'])
  })
  it('受控表 users 不误伤 users_archive（表名词边界）', () => {
    const r = inj('SELECT * FROM users_archive')
    expect(r.sql).toBe('SELECT * FROM users_archive')
    expect(r.params).toEqual([])
  })
  it('敌意列名（括号等杂符）→ 包装期标识符校验 fail loud', () => {
    const hostile = { column: 'f.tenant(id', tables: ['users'] }
    expect(() => wrapTenantLineDatabase({} as never, [hostile])).toThrow(/不是合法标识符/)
  })
  it('良性限定列（一级点限定）→ 精确换值不误注入', async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
    const wrapped = wrapTenantLineDatabase({
      name: 'fake', dialect: 'mysql', identity: 'x',
      query: async (sql, params) => { calls.push({ sql, params }); return [] },
      execute: async () => ({ affectedRows: 0, insertId: 0 }),
      withConnection: async work => work({} as never),
      transaction: async work => work({} as never),
      close: async () => {},
    }, { column: 'pay.tenant_id', tables: ['users'] })
    await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
      wrapped.query('SELECT * FROM users WHERE pay.tenant_id = ?', ['w']))
    // 已手写谓词 → 只换值不重复注入；限定符 pay. 不干扰归属
    expect(calls[0]!.sql).toBe('SELECT * FROM users WHERE pay.tenant_id = ?')
    expect(calls[0]!.params).toEqual(['000000'])
  })
})
