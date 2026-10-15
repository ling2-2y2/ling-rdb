/**
 * 租户行拦截（tenant-line）单测：上下文作用域语义
 * （传播/并发隔离/嵌套/豁免）、参数改写器对语句家族各形态的命中与
 * 排除、以及包装外观在 query/execute/事务内连接上的行为。
 */
import { describe, expect, it } from 'vitest'
import type { RdbConnection, RdbDatabase } from '../src/hub/types.ts'
import {
  currentTenantLine,
  ignoreTenantLine,
  injectTenantLinePredicates,
  neutralizeTenantLine,
  rewriteTenantLineParams,
  runWithTenantLine,
  wrapTenantLineDatabase,
  type TenantLineRule,
} from '../src/kit/tenant-line.ts'

/** The rbac statement family's rule: one column, a controlled table set. */
const RULE: TenantLineRule = {
  column: 'f_tenant_id',
  tables: ['base_user', 'base_organize', 'base_position', 'base_authorize', 'base_sys_log'],
}

describe('tenant-line context (AsyncLocalStorage holder)', () => {
  it('propagates across awaits and clears after the body', async () => {
    expect(currentTenantLine()).toBeUndefined()
    const seen = await runWithTenantLine({ tenantId: '610001', filter: true }, async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
      return currentTenantLine()
    })
    expect(seen).toEqual({ tenantId: '610001', filter: true })
    expect(currentTenantLine()).toBeUndefined()
  })

  it('isolates concurrent scopes', async () => {
    const read = () => new Promise(resolve => setTimeout(() => resolve(currentTenantLine()?.tenantId), 2))
    const [a, b] = await Promise.all([
      runWithTenantLine({ tenantId: 'a-tenant', filter: true }, read),
      runWithTenantLine({ tenantId: 'b-tenant', filter: false }, read),
    ])
    expect([a, b]).toEqual(['a-tenant', 'b-tenant'])
  })

  it('a nested scope overrides, then the outer scope restores', async () => {
    const result = await runWithTenantLine({ tenantId: 'outer', filter: true }, async () => {
      const innerSeen = await runWithTenantLine({ tenantId: 'inner', filter: true }, async () => currentTenantLine()?.tenantId)
      const restored = currentTenantLine()?.tenantId
      return { innerSeen, restored }
    })
    expect(result).toEqual({ innerSeen: 'inner', restored: 'outer' })
  })

  it('ignoreTenantLine escapes inside a scope and restores it after', async () => {
    const result = await runWithTenantLine({ tenantId: 'outer', filter: true }, async () => {
      const inside = await ignoreTenantLine(async () => currentTenantLine())
      const restored = currentTenantLine()
      return { inside, restored }
    })
    expect(result.inside).toMatchObject({ tenantId: 'outer', ignored: true })
    expect(result.restored).toEqual({ tenantId: 'outer', filter: true })
  })

  it('ignoreTenantLine outside any scope yields an empty ignored context', async () => {
    const seen = await ignoreTenantLine(async () => currentTenantLine())
    expect(seen).toEqual({ tenantId: '', filter: false, ignored: true })
  })
})

describe('rewriteTenantLineParams (statement family shapes)', () => {
  /** Rewrite with the default rule and return the resulting params. */
  const rewrite = (sql: string, params: readonly unknown[], tenantId = '610001'): readonly unknown[] =>
    rewriteTenantLineParams(sql, params, RULE, tenantId)!

  it('rewrites the tenant predicate of a plain WHERE', () => {
    expect(rewrite('SELECT f_id FROM base_user WHERE f_account = ? AND f_tenant_id = ?', ['admin', '000000']))
      .toEqual(['admin', '610001'])
  })

  it('rewrites JOIN-aliased predicates and the bare primary-table predicate together', () => {
    const sql = 'SELECT p.f_full_name '
      + 'FROM base_position p LEFT JOIN base_organize o ON o.f_id = p.f_organize_id AND o.f_tenant_id = ? '
      + 'WHERE p.f_tenant_id = ?'
    expect(rewrite(sql, ['000000', '000000'])).toEqual(['610001', '610001'])
  })

  it('rewrites the tenant slot of an INSERT column list', () => {
    const sql = 'INSERT INTO base_authorize (f_id, f_item_type, f_object_id, f_tenant_id) VALUES (?, ?, ?, ?)'
    expect(rewrite(sql, ['a1', 'module', 'm1', '000000'])).toEqual(['a1', 'module', 'm1', '610001'])
  })

  it('rewrites UPDATE and DELETE tenant predicates', () => {
    expect(rewrite('UPDATE base_sys_log SET f_description = ? WHERE f_id = ? AND f_tenant_id = ?', ['d', 'x', '000000']))
      .toEqual(['d', 'x', '610001'])
    expect(rewrite('DELETE FROM base_user WHERE f_id = ? AND f_tenant_id = ?', ['u1', '000000']))
      .toEqual(['u1', '610001'])
  })

  it('leaves statements whose tables are outside the controlled set untouched', () => {
    // Registry-family owner references must survive (base_tenant_link is not tenant-scoped).
    const params = ['t-001']
    expect(rewrite('SELECT f_db_name FROM base_tenant_link WHERE f_tenant_id = ?', params)).toBe(params)
  })

  it('leaves column-to-column predicates (no placeholder) and non-controlled alias tables untouched', () => {
    // base_module/base_system are outside the controlled set: the ON clause
    // is column-to-column anyway and the WHERE term must survive as bound.
    expect(rewrite('SELECT m.f_id FROM base_module m LEFT JOIN base_system s ON s.f_id = m.f_system_id AND s.f_tenant_id = m.f_tenant_id WHERE m.f_tenant_id = ?', ['000000']))
      .toEqual(['000000'])
    expect(rewrite('SELECT 1 FROM base_authorize WHERE x.f_tenant_id = ?', ['000000'])).toEqual(['000000'])
  })

  it('never reads inside quoted literals, and quoted placeholders do not shift ordinals', () => {
    const sql = "SELECT f_id FROM base_user WHERE f_description = 'x = ? f_tenant_id = ?' AND f_tenant_id = ?"
    expect(rewrite(sql, ['000000'])).toEqual(['610001'])
  })

  it('counts predicates across IN lists before the tenant term', () => {
    const sql = 'SELECT f_id FROM base_user WHERE f_id IN (?, ?, ?) AND f_tenant_id = ?'
    expect(rewrite(sql, ['a', 'b', 'c', '000000'])).toEqual(['a', 'b', 'c', '610001'])
  })

  it('documents the INSERT…SELECT copy shape: the source predicate rewrites, the projection stays — hence ignoreTenantLine', () => {
    const sql = 'INSERT INTO base_authorize (f_id, f_tenant_id) SELECT f_id, ? FROM base_authorize WHERE f_tenant_id = ?'
    expect(rewrite(sql, ['610100', '000000'])).toEqual(['610100', '610001'])
  })

  it('passes through empty params by reference', () => {
    const params: readonly unknown[] = []
    expect(rewriteTenantLineParams('SELECT 1 FROM base_user WHERE f_tenant_id = ?', params, RULE, 'x')).toBe(params)
    expect(rewriteTenantLineParams('SELECT 1 FROM base_user WHERE f_tenant_id = ?', undefined, RULE, 'x')).toBeUndefined()
  })
})

describe('wrapTenantLineDatabase (facade interception)', () => {
  /** A recording fake facade: every call is captured, then answered empty. */
  function fakeDatabase(): { db: RdbDatabase; calls: Array<{ sql: string; params?: readonly unknown[] }> } {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
    const conn: RdbConnection = {
      query: async (sql, params) => { calls.push({ sql, params }); return [] },
      execute: async (sql, params) => { calls.push({ sql, params }); return { affectedRows: 0, insertId: 0 } },
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
    }
    const db: RdbDatabase = {
      name: 'fake', dialect: 'mysql', identity: 'fake:1',
      query: conn.query.bind(conn),
      execute: conn.execute.bind(conn),
      withConnection: async work => work(conn),
      transaction: async work => work(conn),
      close: async () => {},
    }
    return { db, calls }
  }

  const SELECT = 'SELECT f_id FROM base_user WHERE f_tenant_id = ?'
  const REGISTRY = "SELECT f_db_name FROM base_tenant_link WHERE f_tenant_id = 't-001' OR f_tenant_id = ?"

  it('rewrites pool queries under a filtering context only', async () => {
    const { db, calls } = fakeDatabase()
    const wrapped = wrapTenantLineDatabase(db, RULE)
    await wrapped.query(SELECT, ['000000'])
    expect(calls[0]!.params).toEqual(['000000'])
    await runWithTenantLine({ tenantId: '610001', filter: true }, () => wrapped.query(SELECT, ['000000']))
    expect(calls[1]!.params).toEqual(['610001'])
    await runWithTenantLine({ tenantId: '610001', filter: false }, () => wrapped.query(SELECT, ['000000']))
    expect(calls[2]!.params).toEqual(['000000'])
  })

  it('rewrites execute and statements inside transactions and withConnection', async () => {
    const { db, calls } = fakeDatabase()
    const wrapped = wrapTenantLineDatabase(db, RULE)
    await runWithTenantLine({ tenantId: '610001', filter: true }, async () => {
      await wrapped.execute(SELECT, ['000000'])
      await wrapped.transaction(async conn => { await conn.query(SELECT, ['000000']) })
      await wrapped.withConnection(async conn => { await conn.execute(SELECT, ['000000']) })
    })
    expect(calls.map(call => call.params)).toEqual([['610001'], ['610001'], ['610001']])
  })

  it('leaves registry-family and non-tenant statements untouched under a context', async () => {
    const { db, calls } = fakeDatabase()
    const wrapped = wrapTenantLineDatabase(db, RULE)
    await runWithTenantLine({ tenantId: '610001', filter: true }, async () => {
      await wrapped.query(REGISTRY, ['t-002'])
      await wrapped.query('SELECT 1', undefined)
    })
    expect(calls[0]!.params).toEqual(['t-002'])
    expect(calls[1]!.params).toBeUndefined()
  })

  it('ignoreTenantLine suspends the rewrite inside a filtering scope', async () => {
    const { db, calls } = fakeDatabase()
    const wrapped = wrapTenantLineDatabase(db, RULE)
    await runWithTenantLine({ tenantId: '610001', filter: true },
      () => ignoreTenantLine(() => wrapped.query(SELECT, ['000000'])))
    expect(calls[0]!.params).toEqual(['000000'])
  })
})

describe('neutralizeTenantLine (BasicTenantInterceptor 超管旁路)', () => {
  /** Neutralize with the default rule; adminTables 默认空集。 */
  const neutralize = (
    sql: string,
    params: readonly unknown[] | undefined,
    adminTables: ReadonlySet<string> = new Set<string>(),
    tenantId = '000000',
  ) => neutralizeTenantLine(sql, params, RULE, { adminTables, tenantId })

  it('中和 SELECT 的租户谓词：文本换 1 = 1，参数剔除', () => {
    const r = neutralize('SELECT f_id FROM base_user WHERE f_account = ? AND f_tenant_id = ?', ['admin', '000000'])
    expect(r.sql).toBe('SELECT f_id FROM base_user WHERE f_account = ? AND 1 = 1')
    expect(r.params).toEqual(['admin'])
  })

  it('别名 JOIN 谓词与裸主表谓词同时中和，顺序保持', () => {
    const sql = 'SELECT p.f_full_name '
      + 'FROM base_position p LEFT JOIN base_organize o ON o.f_id = p.f_organize_id AND o.f_tenant_id = ? '
      + 'WHERE p.f_tenant_id = ?'
    const r = neutralize(sql, ['000000', '000000'])
    expect(r.sql).toBe('SELECT p.f_full_name '
      + 'FROM base_position p LEFT JOIN base_organize o ON o.f_id = p.f_organize_id AND 1 = 1 '
      + 'WHERE 1 = 1')
    expect(r.params).toEqual([])
  })

  it('非受控表谓词不参与：参数原位保留（序号不漂移）', () => {
    // base_tenant_link 不在受控集：它的谓词与其参数都活着，且它前面的
    // 受控谓词被剔除后，后续参数照常对位。
    const sql = 'SELECT l.f_db_name FROM base_tenant_link l JOIN base_user u ON u.f_id = l.f_id '
      + "WHERE l.f_tenant_id = ? AND u.f_tenant_id = ? AND l.f_host = ?"
    const r = neutralize(sql, ['t-001', '000000', 'db.example'])
    expect(r.sql).toContain('l.f_tenant_id = ?')
    expect(r.sql).toContain('1 = 1')
    expect(r.params).toEqual(['t-001', 'db.example'])
  })

  it('adminTables 成员表保留谓词、绑定值换超管租户；同语句其余表照常中和', () => {
    const adminTables = new Set(['base_sys_log'])
    const sql = 'SELECT u.f_id, g.f_id FROM base_user u JOIN base_sys_log g ON g.f_user_id = u.f_id '
      + 'WHERE u.f_tenant_id = ? AND g.f_tenant_id = ?'
    const r = neutralize(sql, ['000000', '610001'], adminTables, '000000')
    expect(r.sql).toContain('1 = 1')
    expect(r.sql).toContain('g.f_tenant_id = ?')
    expect(r.params).toEqual(['000000'])
  })

  it('INSERT 永不中和：原引用返回（列位换值由包装层路径承担）', () => {
    const sql = 'INSERT INTO base_authorize (f_id, f_item_type, f_object_id, f_tenant_id) VALUES (?, ?, ?, ?)'
    const params = ['a1', 'module', 'm1', '000000']
    const r = neutralize(sql, params)
    expect(r.sql).toBe(sql)
    expect(r.params).toBe(params)
  })

  it('无命中时 sql 与 params 均为原引用', () => {
    const params = ['t-001']
    const r = neutralize('SELECT f_db_name FROM base_tenant_link WHERE f_tenant_id = ?', params)
    expect(r.params).toBe(params)
    const none = neutralize('SELECT 1', undefined)
    expect(none.params).toBeUndefined()
  })

  it('引号内谓词文本免疫（掩码语义）', () => {
    const sql = "SELECT f_id FROM base_user WHERE f_description = 'x = ? f_tenant_id = ?' AND f_tenant_id = ?"
    const r = neutralize(sql, ['000000'])
    expect(r.sql).toBe("SELECT f_id FROM base_user WHERE f_description = 'x = ? f_tenant_id = ?' AND 1 = 1")
    expect(r.params).toEqual([])
  })

  it('引号内含非 BMP 字符时拼接索引仍正确（maskQuoted 码元化锁定）', () => {
    const sql = "SELECT f_id FROM base_user WHERE f_real_name = '张😀三' AND f_tenant_id = ?"
    const r = neutralize(sql, ['000000'])
    expect(r.sql).toBe("SELECT f_id FROM base_user WHERE f_real_name = '张😀三' AND 1 = 1")
    expect(r.params).toEqual([])
  })
})

describe('wrapTenantLineDatabase 超管旁路（adminBypass 语境）', () => {
  function fakeDatabase(): { db: RdbDatabase; calls: Array<{ sql: string; params?: readonly unknown[] }> } {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
    const conn: RdbConnection = {
      query: async (sql, params) => { calls.push({ sql, params }); return [] },
      execute: async (sql, params) => { calls.push({ sql, params }); return { affectedRows: 0, insertId: 0 } },
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
    }
    const db: RdbDatabase = {
      name: 'fake', dialect: 'mysql', identity: 'fake:1',
      query: conn.query.bind(conn),
      execute: conn.execute.bind(conn),
      withConnection: async work => work(conn),
      transaction: async work => work(conn),
      close: async () => {},
    }
    return { db, calls }
  }

  const SELECT = 'SELECT f_id FROM base_user WHERE f_account = ? AND f_tenant_id = ?'
  const INSERT = 'INSERT INTO base_authorize (f_id, f_item_type, f_object_id, f_tenant_id) VALUES (?, ?, ?, ?)'

  it('adminBypass 语境执行重建后的 sql（谓词中和、参数剔除）', async () => {
    const { db, calls } = fakeDatabase()
    const wrapped = wrapTenantLineDatabase(db, RULE)
    await runWithTenantLine({ tenantId: '000000', filter: true, adminBypass: { adminTables: new Set<string>() } },
      () => wrapped.query(SELECT, ['admin', '610001']))
    expect(calls[0]!.sql).toBe('SELECT f_id FROM base_user WHERE f_account = ? AND 1 = 1')
    expect(calls[0]!.params).toEqual(['admin'])
  })

  it('INSERT 在 adminBypass 语境走列位换值（tenant 列写入也在拦截层）', async () => {
    const { db, calls } = fakeDatabase()
    const wrapped = wrapTenantLineDatabase(db, RULE)
    await runWithTenantLine({ tenantId: '000000', filter: true, adminBypass: { adminTables: new Set<string>() } },
      () => wrapped.execute(INSERT, ['a1', 'module', 'm1', '610001']))
    expect(calls[0]!.sql).toBe(INSERT)
    expect(calls[0]!.params).toEqual(['a1', 'module', 'm1', '000000'])
  })

  it('ignored 优先于 adminBypass；filter 普通语境不受旁路影响', async () => {
    const { db, calls } = fakeDatabase()
    const wrapped = wrapTenantLineDatabase(db, RULE)
    await runWithTenantLine({ tenantId: '000000', filter: true, adminBypass: { adminTables: new Set<string>() } },
      () => ignoreTenantLine(() => wrapped.query(SELECT, ['admin', '610001'])))
    expect(calls[0]!.sql).toBe(SELECT)
    expect(calls[0]!.params).toEqual(['admin', '610001'])
    await runWithTenantLine({ tenantId: '610001', filter: true }, () => wrapped.query(SELECT, ['admin', '000000']))
    expect(calls[1]!.sql).toBe(SELECT)
    expect(calls[1]!.params).toEqual(['admin', '610001'])
  })
})


describe('注入式租户过滤（业务 SQL 零租户谓词——设计基线）', () => {
  const RULE2: TenantLineRule = { column: 'f_tenant_id', tables: ['base_user'] }
  const inject = (sql: string, params: readonly unknown[], tenantId = '000000') =>
    injectTenantLinePredicates(sql, params, RULE2, tenantId)

  it('单表 SELECT 无 WHERE：注入 WHERE 谓词，参数尾追加会话租户', () => {
    const r = inject('SELECT * FROM base_user', [])
    expect(r.sql).toBe('SELECT * FROM base_user WHERE f_tenant_id = ?')
    expect(r.params).toEqual(['000000'])
  })

  it('WHERE 已存在：谓词追加在 WHERE 尾（ORDER BY/LIMIT 之前）', () => {
    const r = inject('SELECT * FROM base_user WHERE f_age > 18 ORDER BY f_id LIMIT 10', ['x'])
    expect(r.sql).toBe('SELECT * FROM base_user WHERE f_age > 18 AND f_tenant_id = ? ORDER BY f_id LIMIT 10')
    expect(r.params).toEqual(['x', '000000'])
  })

  it('JOIN 多表：受控别名注入，非受控别名不注入；主表有别名时注入别名形态', () => {
    const r = inject(
      'SELECT u.*, d.f_name FROM base_user u JOIN base_dept d ON u.f_dept_id = d.f_id WHERE u.f_age > 18',
      ['x'],
    )
    expect(r.sql).toBe(
      'SELECT u.*, d.f_name FROM base_user u JOIN base_dept d ON u.f_dept_id = d.f_id'
      + ' WHERE u.f_age > 18 AND u.f_tenant_id = ?',
    )
    expect(r.params).toEqual(['x', '000000'])
  })

  it('已手写受控表谓词：不重复注入（换值路径负责）', () => {
    const r = inject('SELECT * FROM base_user WHERE f_tenant_id = ?', ['whatever'])
    expect(r.sql).toBe('SELECT * FROM base_user WHERE f_tenant_id = ?')
    expect(r.params).toEqual(['whatever'])
  })

  it('非受控表语句：零注入', () => {
    const r = inject('SELECT * FROM base_dept WHERE f_id = ?', ['x'])
    expect(r.sql).toBe('SELECT * FROM base_dept WHERE f_id = ?')
    expect(r.params).toEqual(['x'])
  })

  it('UPDATE/DELETE：无 WHERE 在语句尾注入', () => {
    const u = inject('UPDATE base_user SET f_name = ?', ['n'])
    expect(u.sql).toBe('UPDATE base_user SET f_name = ? WHERE f_tenant_id = ?')
    expect(u.params).toEqual(['n', '000000'])
    const d = inject('DELETE FROM base_user WHERE f_age > 18', [])
    expect(d.sql).toBe('DELETE FROM base_user WHERE f_age > 18 AND f_tenant_id = ?')
    expect(d.params).toEqual(['000000'])
  })

  it('自连接：两个别名各注入一次（主表别名形态优先，不注裸列）', () => {
    const r = inject(
      'SELECT a.* FROM base_user a JOIN base_user b ON a.f_pid = b.f_id WHERE a.f_age > 18',
      ['x'],
    )
    expect(r.sql).toBe(
      'SELECT a.* FROM base_user a JOIN base_user b ON a.f_pid = b.f_id'
      + ' WHERE a.f_age > 18 AND a.f_tenant_id = ? AND b.f_tenant_id = ?',
    )
    expect(r.params).toEqual(['x', '000000', '000000'])
  })

  it('端到端：业务 SQL 零租户谓词，经包装外观编译出租户条件', async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
    const db: RdbDatabase = {
      name: 'fake', dialect: 'mysql', identity: 'fake:1',
      query: async (sql, params) => { calls.push({ sql, params }); return [] },
      execute: async () => ({ affectedRows: 0, insertId: 0 }),
      withConnection: async <T,>(work: (conn: RdbConnection) => Promise<T>) => work({
        query: async (sql: string, params?: readonly unknown[]) => { calls.push({ sql, params }); return [] },
        execute: async (sql: string, params?: readonly unknown[]) => { calls.push({ sql, params }); return { affectedRows: 0, insertId: 0 } },
      } as never),
      transaction: async <T,>(work: (conn: RdbConnection) => Promise<T>) => work({} as never),
      close: async () => {},
    }
    const wrapped = wrapTenantLineDatabase(db, RULE2)
    await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
      wrapped.query(
        'SELECT u.*, d.f_name FROM base_user u JOIN base_dept d ON u.f_dept_id = d.f_id WHERE u.f_age > 18',
        ['x'],
      ))
    expect(calls[0]!.sql).toContain('AND u.f_tenant_id = ?')
    expect(calls[0]!.params).toEqual(['x', '000000'])
  })
})
