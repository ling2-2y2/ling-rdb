/**
 * Ad-hoc（一次性）MySQL 连接——供消费者对**用户在业务表里配置的外部库**
 * （dsh-admin 数据中心：base_db_link 行）建短命连接：测试连接、建模 DDL、
 * 数据预览、DataSync、数据接口 SQL 执行。
 *
 * 与 provider 池（`database.ts`，roster 注册制）互不相干：这里不注册、不缓存、
 * 不复用——每次调用建一条连接、跑完即关。`mysql2` 的解析因此仍发生在本包
 * （驱动只装在本包 node_modules 的硬规则不破）。
 *
 * 安全默认：**不开 `multipleStatements`**（对位 Ling PreparedStatement 单语句
 * 语义——数据接口多语句防护 DI-17 的第一道闸在驱动层就成立）。
 * @module @ling2/ling-rdb-mysql/src/adhoc
 */

import { createConnection, type Connection } from 'mysql2/promise'

/** 一条外部库连接参数（对位 base_db_link 行的业务列）。 */
export interface AdhocMysqlOptions {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
  /** 库名；探测类操作（如建库前测试连接）可省。 */
  readonly database?: string
  /**
   * 客户端握手预算（毫秒）。缺省 8s——测试连接类操作要快失败，
   * 不吃 provider 池那种 60s 大窗（那是给 boot 竞态留的）。
   */
  readonly connectTimeoutMs?: number
}

/**
 * 建一条一次性连接执行 `fn`，无论成败都关闭连接。
 *
 * @param options - 连接参数（host/port/user/password 必填）。
 * @param fn - 拿到 mysql2 `Connection` 执行业务；返回值原样透传。
 * @returns `fn` 的返回值。
 */
export async function withAdhocMysql<T>(options: AdhocMysqlOptions, fn: (conn: Connection) => Promise<T>): Promise<T> {
  const conn = await createConnection({
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
    connectTimeout: options.connectTimeoutMs ?? 8_000,
    // 显式保持默认关闭：多语句拼包是注入面，数据中心域的多语句防护依赖它。
    multipleStatements: false,
  })
  try {
    return await fn(conn)
  } finally {
    void conn.end().catch(() => undefined)
  }
}
