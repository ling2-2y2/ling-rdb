/**
 * Ad-hoc（一次性）PostgreSQL 连接——供消费者对**用户在业务表里配置的外部库**
 * （dsh-admin 数据中心：base_db_link 行）建短命连接：测试连接、建模 DDL、
 * 数据预览、数据接口 SQL 执行。
 *
 * 与 provider 池（`database.ts`，roster 注册制）互不相干：这里不注册、不缓存、
 * 不复用——每次调用建一条连接、跑完即关。`pg` 的解析因此仍发生在本包
 * （驱动只装在本包 node_modules 的硬规则不破）。
 *
 * 安全默认：**单语句守卫（在层闸）**——fn 拿到的 client 经代理拦截 `query`，
 * 语句文本经 `assertAdhocSingleStatement` 扫描（行/块注释、单双引号串、
 * dollar-quote 感知）后正文仍含语句分隔分号即拒。设计演进注：原设计指望
 * 「带 values 即扩展协议天然拒多命令」，pg 8.23 实证空数组 values 回落
 * simple 协议放行多命令——驱动层闸不成立（2026-10-02 门控套件证伪），改在
 * 本层自建，语义对位 mysql 缝的 `multipleStatements:false`（数据接口多语句
 * 防护 DI-17 第一道闸仍成立）；语句占位符 `?`→`$n` 翻译复用 `./translate.ts`
 * （调用方执行前过 `toPostgresSql`，引号/注释感知）。
 * @module @ling2/ling-rdb-postgres/src/adhoc
 */

import { Client } from 'pg'

/** pg Client 实例类型（@types/pg 类作值导出——包内定式 InstanceType<typeof X>，见 database.ts pool）。 */
type PgClient = InstanceType<typeof Client>

/** 一条外部库连接参数（对位 base_db_link 行的业务列 + 源 DbPostgre 语义）。 */
export interface AdhocPostgresOptions {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
  /** 库名；探测类操作（如建库前测试连接）可省。 */
  readonly database?: string
  /** 搜索 schema（源 DbPostgre：连接串拼 `currentSchema`；空走服务端默认 'public'）。 */
  readonly schema?: string
  /**
   * 客户端连接预算（毫秒）。缺省 8s——测试连接类操作要快失败，
   * 不吃 provider 池那种 60s 大窗（那是给 boot 竞态留的）。
   */
  readonly connectTimeoutMs?: number
}

/**
 * 连接参数 → pg 连接串（`postgres://user:pwd@host:port/db?currentSchema=…`）。
 * 经 WHATWG URL 对象拼装：user/password 自动 percent-encoding（特殊字符密码
 * 安全，pg 解析端解码还原）；schema 非空才拼 `currentSchema`（源
 * DbPostgre.getConnUrl:47-50 语义），库名缺省不落 pathname 段。
 */
export function buildAdhocPostgresUrl(options: AdhocPostgresOptions): string {
  const url = new URL('postgres://')
  url.hostname = options.host
  url.port = String(options.port)
  url.username = options.user
  url.password = options.password
  if (options.database !== undefined) url.pathname = `/${options.database}`
  if (options.schema !== undefined && options.schema !== '') url.searchParams.set('currentSchema', options.schema)
  return url.toString()
}

/**
 * 单语句守卫扫描：剥离行注释/块注释/单双引号串（'' "" 翻倍转义）/
 * dollar-quote 串后，正文仍含语句分隔分号即抛（尾分号与连续空分号放行）。
 * 已知边界：E'…\\'…' 反斜杠转义串按标准串语义解析（standard_conforming_strings=on
 * 缺省），极端转义形态可能误判——误判方向恒为「多拒」，安全闸宁严勿松。
 */
export function assertAdhocSingleStatement(sql: string): void {
  const n = sql.length
  let i = 0
  while (i < n) {
    const ch = sql[i]!
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i = i >= n ? n : i + 2
      continue
    }
    if (ch === "'" || ch === '"') {
      i++
      while (i < n) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) { i += 2; continue }
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0]
      if (tag !== undefined) {
        const end = sql.indexOf(tag, i + tag.length)
        i = end === -1 ? n : end + tag.length
        continue
      }
    }
    if (ch === ';') {
      const rest = sql.slice(i + 1).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '')
      if (/[^\s;]/.test(rest)) {
        throw new Error('多语句拒绝：adhoc 连接单次只允许一条语句（对位 mysql multipleStatements:false）')
      }
      return
    }
    i++
  }
}

/**
 * 建一条一次性连接执行 `fn`，无论成败都关闭连接。
 *
 * @param options - 连接参数（host/port/user/password 必填）。
 * @param fn - 拿到 pg `Client`（query 已过单语句守卫代理）执行业务；返回值原样透传。
 * @returns `fn` 的返回值。
 */
export async function withAdhocPostgres<T>(options: AdhocPostgresOptions, fn: (conn: PgClient) => Promise<T>): Promise<T> {
  const conn = new Client({
    connectionString: buildAdhocPostgresUrl(options),
    connectionTimeoutMillis: options.connectTimeoutMs ?? 8_000,
  })
  await conn.connect()
  const guarded = new Proxy(conn, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (textOrConfig: string | { text: string }, values?: unknown[]) => {
          const text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text
          try {
            assertAdhocSingleStatement(text)
          } catch (error) {
            // 拒绝走 rejected promise（query 的 async 契约；同步 throw 会越过调用方
            // 的 rejects.toThrow 断言直通 withAdhocPostgres 变成套件失败）。
            return Promise.reject(error)
          }
          return target.query(textOrConfig as never, values as never)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  try {
    return await fn(guarded)
  } finally {
    void conn.end().catch(() => undefined)
  }
}
