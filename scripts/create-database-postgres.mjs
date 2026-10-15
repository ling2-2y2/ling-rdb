#!/usr/bin/env node
/**
 * 幂等建库脚本：在目标 PG 实例上创建业务库（dsh 惯例——提供者只验连，
 * 从不 CREATE DATABASE；建库一律带外执行）。已存在则跳过。
 *
 * 用法：
 *   DSH_POSTGRES_ADMIN_URL='postgres://user:pwd@host:5432/postgres' \
 *   DSH_POSTGRES_DBNAME='dsh_weknora' \
 *   node scripts/create-database.mjs
 *
 * DSH_POSTGRES_DBNAME 缺省 dsh_weknora；admin URL 必须指向已存在的库
 * （惯例用系统库 postgres）。
 * @module dsh-rdb-postgres/scripts/create-database
 */
import { Client } from 'pg'

const adminUrl = process.env.DSH_POSTGRES_ADMIN_URL
const dbname = process.env.DSH_POSTGRES_DBNAME ?? 'dsh_weknora'
if (!adminUrl) {
  console.error('缺少 DSH_POSTGRES_ADMIN_URL（指向已存在的管理库，如 postgres://…/postgres）')
  process.exit(1)
}
if (!/^[a-z_][a-z0-9_]*$/.test(dbname)) {
  console.error(`库名 '${dbname}' 不合 PG 小写标识符约定，拒绝执行`)
  process.exit(1)
}

const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000 })
await client.connect()
try {
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbname])
  if (exists.rowCount === 0) {
    // 标识符已按上方白名单校验，无法注入；CREATE DATABASE 不支持参数绑定
    await client.query(`CREATE DATABASE "${dbname}"`)
    console.log(`已创建 ${dbname}`)
  } else {
    console.log(`${dbname} 已存在，跳过`)
  }
} finally {
  await client.end()
}
