/**
 * 示例共用：捕获型假库。
 *
 * 所有示例都不需要真实数据库——本文件提供一个「记下每条语句、按队列回放
 * 查询结果」的内存执行面，形状与真实 RdbDatabase 门面一致（query/execute/
 * withConnection/transaction）。真实库上生成的语句与参数和这里打印的完全
 * 相同，所以「跑示例 = 看真实 SQL」。
 */
import { inspect } from 'node:util'

/**
 * 创建捕获型假库。
 *
 * @param {string} [name] 门面名（对应宿主注册名的示意）
 * @param {string} [dialect] 方言——orm 层按它分派编译器（postgresql / mysql / …）
 * @param {(sql: string, params: unknown[]) => unknown[] | undefined} [onQuery]
 *   可选读回放钩子：返回数组则本次语句以它作结果集；返回 undefined 则走
 *   rows 队列。迁移示例用它模拟版本簿记表。
 */
export function fakeDatabase(name = 'demo', dialect = 'postgresql', onQuery) {
  const calls = [] // 捕获到的每条语句：{ sql, params, conn? }
  const rows = []  // 读回放队列：push 一个数组 = 下一次 query 的结果集
  const conn = {
    began: false, committed: false, rolledBack: false,
    async query(sql, params = []) {
      calls.push({ conn, sql, params })
      const replayed = onQuery?.(sql, params)
      if (replayed !== undefined) return replayed
      return rows.shift() ?? []
    },
    async execute(sql, params = []) {
      calls.push({ conn, sql, params })
      const replayed = onQuery?.(sql, params)
      return replayed !== undefined ? replayed : { affectedRows: 1, insertId: 0 }
    },
    async beginTransaction() { conn.began = true },
    async commit() { conn.committed = true },
    async rollback() { conn.rolledBack = true },
  }
  return {
    name, dialect, identity: `${name}:memory`,
    calls, rows, conn,
    query: (sql, params) => conn.query(sql, params),
    execute: (sql, params) => conn.execute(sql, params),
    withConnection: work => work(conn),
    async transaction(work) {
      await conn.beginTransaction()
      try {
        const settled = await work(conn)
        await conn.commit()
        return settled
      } catch (error) { await conn.rollback(); throw error }
    },
    close: async () => {},
  }
}

/** 打印一个小节标题。 */
export function step(title) {
  console.log(`\n■ ${title}`)
}

/** 打印一条捕获语句（SQL + 参数），可附返回值；call 也可只给 { sql }。 */
export function show(label, call, result) {
  if (label) console.log(`  ${label}`)
  if (call?.sql) console.log(`  SQL  ${call.sql}`)
  if (Array.isArray(call?.params) && call.params.length > 0) {
    console.log(`  参数 ${inspect(call.params, { breakLength: Infinity })}`)
  }
  if (result !== undefined) {
    const text = inspect(result, { depth: null, breakLength: 96 })
    console.log(`  结果 ${text.replace(/\n/g, '\n       ')}`)
  }
}

/** 取最后一条捕获语句；给片段时取最后一条包含它的语句（定位 INSERT/UPDATE 用）。 */
export function lastCall(db, fragment) {
  const found = fragment
    ? [...db.calls].reverse().find(call => call.sql.includes(fragment))
    : db.calls.at(-1)
  if (!found) throw new Error(`示例脚本未捕获到语句: ${fragment ?? '(任意)'}`)
  return found
}
