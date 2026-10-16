/**
 * 用户令测试矩阵（2026-10-15）：Q001~Q707 八组 SQL 形态 × 注入式租户过滤。
 * 规则基线：受控表 = users / orders / products / order_items，租户列 =
 * f_tenant_id，会话租户 = '000000'。断言三类结果：注入（SQL+参数逐字）、
 * 透传（非受控/豁免语句零改动）、fail loud（受控表在子查询/CTE/派生表
 * 等不可保证过滤的区域 → 抛错，绝不静默跳过）。
 */
import { describe, expect, it } from 'vitest'
import type { RdbConnection, RdbDatabase } from '../src/hub/types.ts'
import {
  injectInsertTenantColumn,
  injectTenantLinePredicates,
  runWithTenantLine,
  wrapTenantLineDatabase,
} from '../src/kit/tenant-line.ts'

const RULE = { column: 'f_tenant_id', tables: ['users', 'orders', 'products', 'order_items'] }
const inj = (sql: string, params: readonly unknown[] = []) => injectTenantLinePredicates(sql, params, RULE, '000000')
const throws = (sql: string, params: readonly unknown[] = []) =>
  expect(() => injectTenantLinePredicates(sql, params, RULE, '000000')).toThrow(/tenant-line/)

describe('组合 1：单表基础查询', () => {
  it('Q001 查询所有用户 → 注入 WHERE', () => {
    expect(inj('SELECT * FROM users')).toEqual({ sql: 'SELECT * FROM users WHERE f_tenant_id = ?', params: ['000000'] })
  })
  it('Q002 城市等值 → 追加 AND', () => {
    expect(inj("SELECT * FROM users WHERE city = '北京'").sql).toBe("SELECT * FROM users WHERE city = '北京' AND f_tenant_id = ?")
  })
  it('Q003 LIKE 模糊（引号内 % 不受影响）→ 追加 AND', () => {
    expect(inj("SELECT * FROM users WHERE name LIKE '%张%'").sql).toBe("SELECT * FROM users WHERE name LIKE '%张%' AND f_tenant_id = ?")
  })
  it('Q004 BETWEEN → 追加 AND（BETWEEN 内部 AND 不错位）', () => {
    expect(inj('SELECT * FROM users WHERE age BETWEEN 20 AND 35').sql).toBe('SELECT * FROM users WHERE age BETWEEN 20 AND 35 AND f_tenant_id = ?')
  })
  it('Q005 ORDER BY + LIMIT → WHERE 插在 ORDER 之前', () => {
    expect(inj('SELECT * FROM users ORDER BY age DESC LIMIT 2')).toEqual({
      sql: 'SELECT * FROM users WHERE f_tenant_id = ? ORDER BY age DESC LIMIT 2',
      params: ['000000'],
    })
  })
  it('Q006 DISTINCT → 注入 WHERE', () => {
    expect(inj('SELECT DISTINCT city FROM users')).toEqual({
      sql: 'SELECT DISTINCT city FROM users WHERE f_tenant_id = ?',
      params: ['000000'],
    })
  })
  it('Q007 IS NULL → 追加 AND', () => {
    expect(inj('SELECT * FROM users WHERE city IS NULL').sql).toBe('SELECT * FROM users WHERE city IS NULL AND f_tenant_id = ?')
  })
})

describe('组合 2：聚合与分组统计', () => {
  it('Q101 GROUP BY → WHERE 插在 GROUP 之前', () => {
    expect(inj('SELECT city, COUNT(*) AS user_cnt FROM users GROUP BY city')).toEqual({
      sql: 'SELECT city, COUNT(*) AS user_cnt FROM users WHERE f_tenant_id = ? GROUP BY city',
      params: ['000000'],
    })
  })
  it('Q102 HAVING → WHERE 插在 GROUP 之前（HAVING 原样保留）', () => {
    expect(inj('SELECT city, AVG(age) AS avg_age FROM users GROUP BY city HAVING AVG(age) > 30')).toEqual({
      sql: 'SELECT city, AVG(age) AS avg_age FROM users WHERE f_tenant_id = ? GROUP BY city HAVING AVG(age) > 30',
      params: ['000000'],
    })
  })
  it('Q103 聚合 + CASE WHEN（括号内不误伤）→ 尾部注入 WHERE', () => {
    expect(inj("SELECT COUNT(*) AS order_cnt, SUM(CASE WHEN status = 'paid' THEN total_amount ELSE 0 END) AS paid_amt FROM orders")).toEqual({
      sql: "SELECT COUNT(*) AS order_cnt, SUM(CASE WHEN status = 'paid' THEN total_amount ELSE 0 END) AS paid_amt FROM orders WHERE f_tenant_id = ?",
      params: ['000000'],
    })
  })
  it('Q104 按月统计（WHERE 已有 + GROUP + ORDER）→ AND 插在 GROUP 之前', () => {
    expect(inj("SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, SUM(total_amount) AS amount FROM orders WHERE status = ? GROUP BY month ORDER BY month", ['paid'])).toEqual({
      sql: "SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, SUM(total_amount) AS amount FROM orders WHERE status = ? AND f_tenant_id = ? GROUP BY month ORDER BY month",
      params: ['paid', '000000'],
    })
  })
  it('Q105 分类统计 → WHERE 插在 GROUP 之前', () => {
    expect(inj('SELECT category, COUNT(*) AS cnt, AVG(price) AS avg_price FROM products GROUP BY category')).toEqual({
      sql: 'SELECT category, COUNT(*) AS cnt, AVG(price) AS avg_price FROM products WHERE f_tenant_id = ? GROUP BY category',
      params: ['000000'],
    })
  })
})

describe('组合 3：多表 JOIN 查询', () => {
  it('Q201 双表 JOIN（主表无别名 → 表名限定防歧义）', () => {
    expect(inj('SELECT o.order_no, u.name, o.total_amount, o.status FROM orders o JOIN users u ON o.user_id = u.id')).toEqual({
      sql: 'SELECT o.order_no, u.name, o.total_amount, o.status FROM orders o JOIN users u ON o.user_id = u.id'
        + ' WHERE o.f_tenant_id = ? AND u.f_tenant_id = ?',
      params: ['000000', '000000'],
    })
  })
  it('Q202 LEFT JOIN + GROUP BY → 双谓词插在 GROUP 之前', () => {
    expect(inj('SELECT u.name, COUNT(o.id) AS order_cnt FROM users u LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.id, u.name')).toEqual({
      sql: 'SELECT u.name, COUNT(o.id) AS order_cnt FROM users u LEFT JOIN orders o ON u.id = o.user_id'
        + ' WHERE u.f_tenant_id = ? AND o.f_tenant_id = ? GROUP BY u.id, u.name',
      params: ['000000', '000000'],
    })
  })
  it('Q203 三表链式 JOIN → 三表全过滤（主表表名限定）', () => {
    expect(inj('SELECT o.order_no, p.name, oi.quantity, oi.unit_price, oi.quantity * oi.unit_price AS subtotal'
      + ' FROM order_items oi JOIN orders o ON oi.order_id = o.id JOIN products p ON oi.product_id = p.id')).toEqual({
      sql: 'SELECT o.order_no, p.name, oi.quantity, oi.unit_price, oi.quantity * oi.unit_price AS subtotal'
        + ' FROM order_items oi JOIN orders o ON oi.order_id = o.id JOIN products p ON oi.product_id = p.id'
        + ' WHERE oi.f_tenant_id = ? AND o.f_tenant_id = ? AND p.f_tenant_id = ?',
      params: ['000000', '000000', '000000'],
    })
  })
  it('Q204 四表 JOIN + 既有 WHERE → 四谓词追加（引号内不误伤）', () => {
    expect(inj("SELECT DISTINCT u.name FROM users u JOIN orders o ON u.id = o.user_id"
      + " JOIN order_items oi ON o.id = oi.order_id JOIN products p ON oi.product_id = p.id WHERE p.category = '手机'")).toEqual({
      sql: "SELECT DISTINCT u.name FROM users u JOIN orders o ON u.id = o.user_id"
        + " JOIN order_items oi ON o.id = oi.order_id JOIN products p ON oi.product_id = p.id WHERE p.category = '手机'"
        + ' AND u.f_tenant_id = ? AND o.f_tenant_id = ? AND oi.f_tenant_id = ? AND p.f_tenant_id = ?',
      params: ['000000', '000000', '000000', '000000'],
    })
  })
  it('Q205 LEFT JOIN + IS NULL 反连接 → 双谓词追加', () => {
    expect(inj('SELECT u.* FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.id IS NULL')).toEqual({
      sql: 'SELECT u.* FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.id IS NULL'
        + ' AND u.f_tenant_id = ? AND o.f_tenant_id = ?',
      params: ['000000', '000000'],
    })
  })
})

describe('组合 4：子查询与 EXISTS（fail loud 防线）', () => {
  it('Q301 标量子查询同表 → fail loud', () => {
    throws('SELECT * FROM products WHERE price > (SELECT AVG(price) FROM products)')
  })
  it('Q302 EXISTS 子查询涉受控表 → fail loud', () => {
    throws('SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)')
  })
  it('Q303 NOT EXISTS 子查询涉受控表 → fail loud', () => {
    throws('SELECT * FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)')
  })
  it('Q304 标量子查询同表 → fail loud', () => {
    throws('SELECT * FROM orders WHERE total_amount = (SELECT MAX(total_amount) FROM orders)')
  })
  it('Q305 相关子查询 → fail loud', () => {
    throws('SELECT o.* FROM orders o WHERE o.created_at = (SELECT MAX(o2.created_at) FROM orders o2 WHERE o2.user_id = o.user_id)')
  })
})

describe('组合 5：窗口函数（OVER 括号深度>0 不影响顶层注入）', () => {
  it('Q401 ROW_NUMBER OVER → 尾部注入 WHERE', () => {
    expect(inj('SELECT user_id, order_no, total_amount, ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY total_amount DESC) AS rn FROM orders')).toEqual({
      sql: 'SELECT user_id, order_no, total_amount, ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY total_amount DESC) AS rn FROM orders WHERE f_tenant_id = ?',
      params: ['000000'],
    })
  })
  it('Q402 RANK OVER → 尾部注入 WHERE', () => {
    expect(inj('SELECT name, category, price, RANK() OVER(PARTITION BY category ORDER BY price DESC) AS rk FROM products')).toEqual({
      sql: 'SELECT name, category, price, RANK() OVER(PARTITION BY category ORDER BY price DESC) AS rk FROM products WHERE f_tenant_id = ?',
      params: ['000000'],
    })
  })
  it('Q403 累计 SUM OVER → 尾部注入 WHERE', () => {
    expect(inj('SELECT user_id, order_no, created_at, total_amount, SUM(total_amount) OVER(PARTITION BY user_id ORDER BY created_at) AS cum_amount FROM orders')).toEqual({
      sql: 'SELECT user_id, order_no, created_at, total_amount, SUM(total_amount) OVER(PARTITION BY user_id ORDER BY created_at) AS cum_amount FROM orders WHERE f_tenant_id = ?',
      params: ['000000'],
    })
  })
  it('Q404 CTE + 窗口 → fail loud', () => {
    throws('WITH t AS (SELECT o.*, ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY total_amount DESC) AS rn FROM orders o) SELECT * FROM t WHERE rn = 1')
  })
  it('Q405 派生表 + LAG → fail loud', () => {
    throws("SELECT month, amount, LAG(amount) OVER(ORDER BY month) AS prev_amount, amount - LAG(amount) OVER(ORDER BY month) AS diff"
      + " FROM (SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, SUM(total_amount) AS amount FROM orders WHERE status = 'paid' GROUP BY month) t")
  })
})

describe('组合 6：CTE 复杂查询（fail loud 防线）', () => {
  it('Q501 CTE 内 JOIN 受控表 → fail loud', () => {
    throws('WITH city_paid AS (SELECT u.city, SUM(o.total_amount) AS paid_amount FROM users u JOIN orders o ON u.id = o.user_id'
      + " WHERE o.status = 'paid' GROUP BY u.city) SELECT * FROM city_paid WHERE paid_amount > 5000")
  })
  it('Q502 CTE 内受控表 → fail loud', () => {
    throws('WITH order_qty AS (SELECT order_id, SUM(quantity) AS total_qty FROM order_items GROUP BY order_id)'
      + ' SELECT * FROM order_qty WHERE total_qty >= 1')
  })
  it('Q503 CTE 内 JOIN 受控表 → fail loud', () => {
    throws('WITH user_amt AS (SELECT u.id, u.name, SUM(o.total_amount) AS amt FROM users u JOIN orders o ON u.id = o.user_id'
      + " WHERE o.status = 'paid' GROUP BY u.id, u.name) SELECT * FROM user_amt ORDER BY amt DESC LIMIT 3")
  })
})

describe('组合 7：DML 数据维护', () => {
  it('Q601 INSERT 无租户列 → 自动补列 + 组尾绑定', () => {
    expect(injectInsertTenantColumn(
      "INSERT INTO users(id, name, city, age, created_at) VALUES (6, '孙八', '深圳', 26, CURDATE())",
      [],
      RULE,
      '000000',
    )).toEqual({
      sql: "INSERT INTO users(id, name, city, age, created_at, f_tenant_id) VALUES (6, '孙八', '深圳', 26, CURDATE(), ?)",
      params: ['000000'],
    })
  })
  it('Q602 UPDATE 防超卖 → 追加 AND', () => {
    expect(inj('UPDATE products SET stock = stock - 1 WHERE id = 1 AND stock > 0').sql)
      .toBe('UPDATE products SET stock = stock - 1 WHERE id = 1 AND stock > 0 AND f_tenant_id = ?')
  })
  it('Q603 DELETE + IN 子查询涉受控表 → fail loud', () => {
    throws("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status = 'cancelled')")
  })
  it('Q604 DELETE 已取消订单 → 追加 AND', () => {
    expect(inj("DELETE FROM orders WHERE status = 'cancelled'").sql).toBe("DELETE FROM orders WHERE status = 'cancelled' AND f_tenant_id = ?")
  })
  it('Q605 UPSERT ON DUPLICATE KEY → 补列（组尾在 ON DUPLICATE 之前）', () => {
    expect(injectInsertTenantColumn(
      "INSERT INTO products(id, name, category, price, stock) VALUES (1, 'iPhone 15', '手机', 6999, 8) ON DUPLICATE KEY UPDATE stock = VALUES(stock)",
      [],
      RULE,
      '000000',
    )).toEqual({
      sql: "INSERT INTO products(id, name, category, price, stock, f_tenant_id) VALUES (1, 'iPhone 15', '手机', 6999, 8, ?)"
        + ' ON DUPLICATE KEY UPDATE stock = VALUES(stock)',
      params: ['000000'],
    })
  })
  it('Q601b INSERT 已含租户列 → 列位换值（不重复补列）', () => {
    expect(injectInsertTenantColumn(
      'INSERT INTO users(id, name, f_tenant_id) VALUES (?, ?, ?)',
      [7, '李四', 'whatever'],
      RULE,
      '000000',
    )).toEqual({
      sql: 'INSERT INTO users(id, name, f_tenant_id) VALUES (?, ?, ?)',
      params: [7, '李四', '000000'],
    })
  })
})

describe('组合 8：性能、边界与异常', () => {
  it('Q701 EXPLAIN → 非行访问语句透传', () => {
    expect(inj("EXPLAIN SELECT * FROM orders WHERE user_id = 1 AND status = 'paid'")).toEqual({
      sql: "EXPLAIN SELECT * FROM orders WHERE user_id = 1 AND status = 'paid'",
      params: [],
    })
  })
  it('Q702 CREATE INDEX → 透传', () => {
    expect(inj('CREATE INDEX idx_orders_user_status_created ON orders(user_id, status, created_at)')).toEqual({
      sql: 'CREATE INDEX idx_orders_user_status_created ON orders(user_id, status, created_at)',
      params: [],
    })
  })
  it('Q703 大分页（id 范围）→ 追加 AND', () => {
    expect(inj('SELECT * FROM orders WHERE id > 100 ORDER BY id LIMIT 20').sql)
      .toBe('SELECT * FROM orders WHERE id > 100 AND f_tenant_id = ? ORDER BY id LIMIT 20')
  })
  it('Q704 NOW()/INTERVAL → 追加 AND', () => {
    expect(inj("SELECT * FROM orders WHERE status = 'paid' AND created_at >= NOW() - INTERVAL 30 DAY").sql)
      .toBe("SELECT * FROM orders WHERE status = 'paid' AND created_at >= NOW() - INTERVAL 30 DAY AND f_tenant_id = ?")
  })
  it('Q705 异常库存 → 追加 AND', () => {
    expect(inj('SELECT * FROM products WHERE stock < 0').sql).toBe('SELECT * FROM products WHERE stock < 0 AND f_tenant_id = ?')
  })
  it('Q706 GROUP BY + HAVING COUNT → WHERE 插在 GROUP 之前', () => {
    expect(inj('SELECT order_no, COUNT(*) FROM orders GROUP BY order_no HAVING COUNT(*) > 1')).toEqual({
      sql: 'SELECT order_no, COUNT(*) FROM orders WHERE f_tenant_id = ? GROUP BY order_no HAVING COUNT(*) > 1',
      params: ['000000'],
    })
  })
  it('Q707 空结果边界 → 追加 AND', () => {
    expect(inj("SELECT * FROM users WHERE city = '不存在的城市'").sql).toBe("SELECT * FROM users WHERE city = '不存在的城市' AND f_tenant_id = ?")
  })
})

describe('端到端：包装外观下的矩阵抽样（真库形状假外观）', () => {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
  const db: RdbDatabase = {
    name: 'fake', dialect: 'mysql', identity: 'fake:1',
    query: async (sql, params) => { calls.push({ sql, params }); return [] },
    execute: async (sql, params) => { calls.push({ sql, params }); return { affectedRows: 0, insertId: 0 } },
    withConnection: async <T,>(work: (conn: RdbConnection) => Promise<T>) => work({
      query: async (sql: string, params?: readonly unknown[]) => { calls.push({ sql, params }); return [] },
      execute: async (sql: string, params?: readonly unknown[]) => { calls.push({ sql, params }); return { affectedRows: 0, insertId: 0 } },
    } as never),
    transaction: async <T,>(work: (conn: RdbConnection) => Promise<T>) => work({
      query: async (sql: string, params?: readonly unknown[]) => { calls.push({ sql, params }); return [] },
      execute: async (sql: string, params?: readonly unknown[]) => { calls.push({ sql, params }); return { affectedRows: 0, insertId: 0 } },
    } as never),
    close: async () => {},
  }
  const wrapped = wrapTenantLineDatabase(db, RULE)

  it('Q201/Q601/Q602 经包装外观端到端', async () => {
    await runWithTenantLine({ tenantId: '000000', filter: true }, async () => {
      await wrapped.query('SELECT o.order_no, u.name FROM orders o JOIN users u ON o.user_id = u.id')
      await wrapped.execute(
        "INSERT INTO users(id, name, city, age, created_at) VALUES (6, '孙八', '深圳', 26, CURDATE())",
      )
      await wrapped.execute('UPDATE products SET stock = stock - 1 WHERE id = 1 AND stock > 0')
    })
    expect(calls[0]!.sql).toContain('WHERE o.f_tenant_id = ? AND u.f_tenant_id = ?')
    expect(calls[0]!.params).toEqual(['000000', '000000'])
    expect(calls[1]!.sql).toContain('f_tenant_id) VALUES')
    expect(calls[1]!.params).toEqual(['000000'])
    expect(calls[2]!.sql).toContain('AND f_tenant_id = ?')
    expect(calls[2]!.params).toEqual(['000000'])
  })
})

describe('师生域：多规则包装 + 非标准租户列 + 受控清单变量', () => {
  /** 表清单变量：teacher/student=标准列 f_tenant_id；teacher_student=非标准列 tenant_code（独立配置）；classroom=非受控。 */
  const RULE_STD = { column: 'f_tenant_id', tables: ['teacher', 'student'] }
  const RULE_REL = { column: 'tenant_code', tables: ['teacher_student'] }
  const RULE_BOTH = [RULE_STD, RULE_REL]

  function fakeDb() {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
    const db: RdbDatabase = {
      name: 'school', dialect: 'mysql', identity: 'school:1',
      query: async (sql, params) => { calls.push({ sql, params }); return [] },
      execute: async (sql, params) => { calls.push({ sql, params }); return { affectedRows: 0, insertId: 0 } },
      withConnection: async <T,>(work: (conn: RdbConnection) => Promise<T>) => work({
        query: async (sql: string, params?: readonly unknown[]) => { calls.push({ sql, params }); return [] },
        execute: async (sql: string, params?: readonly unknown[]) => { calls.push({ sql, params }); return { affectedRows: 0, insertId: 0 } },
      } as never),
      transaction: async <T,>(work: (conn: RdbConnection) => Promise<T>) => work({
        query: async (sql: string, params?: readonly unknown[]) => { calls.push({ sql, params }); return [] },
        execute: async (sql: string, params?: readonly unknown[]) => { calls.push({ sql, params }); return { affectedRows: 0, insertId: 0 } },
      } as never),
      close: async () => {},
    }
    return { db, calls }
  }

  const TEACHER_CLASS_JOIN = 'SELECT t.name, s.name AS student_name, c.name AS class_name'
    + ' FROM teacher t JOIN teacher_student ts ON t.id = ts.teacher_id'
    + ' JOIN student s ON s.id = ts.student_id'
    + ' JOIN classroom c ON s.classroom_id = c.id WHERE c.name = ?'

  it('三表 JOIN + 非受控表：双规则包装 → 三处租户谓词注入（各自列名），classroom 零注入', async () => {
    const { db, calls } = fakeDb()
    const wrapped = wrapTenantLineDatabase(db, RULE_BOTH)
    await runWithTenantLine({ tenantId: '000000', filter: true }, () => wrapped.query(TEACHER_CLASS_JOIN, ['一班']))
    expect(calls[0]!.sql).toBe(TEACHER_CLASS_JOIN
      + ' AND t.f_tenant_id = ? AND s.f_tenant_id = ? AND ts.tenant_code = ?')
    expect(calls[0]!.params).toEqual(['一班', '000000', '000000', '000000'])
  })

  it('受控清单变量：同一 SQL 仅挂标准列规则 → teacher_student 零注入（清单决定行为）', async () => {
    const { db, calls } = fakeDb()
    const wrapped = wrapTenantLineDatabase(db, RULE_STD)
    await runWithTenantLine({ tenantId: '000000', filter: true }, () => wrapped.query(TEACHER_CLASS_JOIN, ['一班']))
    expect(calls[0]!.sql).toBe(TEACHER_CLASS_JOIN + ' AND t.f_tenant_id = ? AND s.f_tenant_id = ?')
    expect(calls[0]!.params).toEqual(['一班', '000000', '000000'])
  })

  it('复杂 UPDATE：单表 + 既有 WHERE → 注入标准列', async () => {
    const { db, calls } = fakeDb()
    const wrapped = wrapTenantLineDatabase(db, RULE_BOTH)
    await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
      wrapped.execute("UPDATE teacher SET f_title = '高教' WHERE f_id = ? AND f_status = 'on'", ['t1']))
    expect(calls[0]!.sql).toBe("UPDATE teacher SET f_title = '高教' WHERE f_id = ? AND f_status = 'on' AND f_tenant_id = ?")
    expect(calls[0]!.params).toEqual(['t1', '000000'])
  })

  it('复杂 DELETE：关系表（非标准列）单表删除 → 注入 tenant_code', async () => {
    const { db, calls } = fakeDb()
    const wrapped = wrapTenantLineDatabase(db, RULE_BOTH)
    await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
      wrapped.execute('DELETE FROM teacher_student WHERE teacher_id = ? AND student_id = ?', ['t1', 's1']))
    expect(calls[0]!.sql).toBe('DELETE FROM teacher_student WHERE teacher_id = ? AND student_id = ? AND tenant_code = ?')
    expect(calls[0]!.params).toEqual(['t1', 's1', '000000'])
  })

  it('复杂 UPDATE：MySQL 多表 JOIN UPDATE 形态 → fail loud（诚实边界）', async () => {
    const { db, calls } = fakeDb()
    const wrapped = wrapTenantLineDatabase(db, RULE_BOTH)
    await expect(Promise.resolve().then(() => runWithTenantLine({ tenantId: '000000', filter: true }, () =>
      wrapped.execute(
        'UPDATE teacher t JOIN teacher_student ts ON t.id = ts.teacher_id SET ts.f_deleted = 1 WHERE t.f_id = ?',
        ['t1'],
      )))).rejects.toThrow(/tenant-line/)
    expect(calls).toEqual([])
  })

  it('聚合 + JOIN：双规则各注入各列，GROUP BY 前插入', async () => {
    const { db, calls } = fakeDb()
    const wrapped = wrapTenantLineDatabase(db, RULE_BOTH)
    await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
      wrapped.query('SELECT ts.teacher_id, COUNT(*) AS cnt FROM teacher_student ts'
        + ' JOIN teacher t ON t.id = ts.teacher_id GROUP BY ts.teacher_id'))
    expect(calls[0]!.sql).toBe('SELECT ts.teacher_id, COUNT(*) AS cnt FROM teacher_student ts'
      + ' JOIN teacher t ON t.id = ts.teacher_id'
      + ' WHERE t.f_tenant_id = ? AND ts.tenant_code = ? GROUP BY ts.teacher_id')
    expect(calls[0]!.params).toEqual(['000000', '000000'])
  })

  it('清单变量边界：规则清单不含目标表 → 零注入零误伤（即便列名匹配）', async () => {
    const { db, calls } = fakeDb()
    const wrapped = wrapTenantLineDatabase(db, { column: 'tenant_code', tables: ['teacher_student'] })
    await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
      wrapped.query('SELECT * FROM teacher WHERE f_tenant_id = ?', ['x']))
    expect(calls[0]!.sql).toBe('SELECT * FROM teacher WHERE f_tenant_id = ?')
    expect(calls[0]!.params).toEqual(['x'])
  })

  it('INSERT 关系表（非标准列缺失）→ 自动补 tenant_code 列', async () => {
    const { db, calls } = fakeDb()
    const wrapped = wrapTenantLineDatabase(db, RULE_BOTH)
    await runWithTenantLine({ tenantId: '000000', filter: true }, () =>
      wrapped.execute('INSERT INTO teacher_student(teacher_id, student_id) VALUES (?, ?)', ['t1', 's1']))
    expect(calls[0]!.sql).toBe('INSERT INTO teacher_student(teacher_id, student_id, tenant_code) VALUES (?, ?, ?)')
    expect(calls[0]!.params).toEqual(['t1', 's1', '000000'])
  })
})
